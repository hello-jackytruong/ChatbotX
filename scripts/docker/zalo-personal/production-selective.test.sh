#!/usr/bin/env bash
# shellcheck disable=SC2329

set -Eeuo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  printf 'SKIP: Zalo selective deployment tests require Bash 4 or newer.\n'
  exit 0
fi

TEST_DIR="$(mktemp -d)"
export ZALO_STATE_DIR="$TEST_DIR/state"
export ZALO_BACKUP_DIR="$TEST_DIR/backups"
export CHATBOTX_DEPLOY_LOCK="$TEST_DIR/production.lock"
trap 'rm -rf -- "$TEST_DIR"' EXIT

# shellcheck disable=SC1091
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/production.sh"

if command -v flock >/dev/null 2>&1; then
  acquire_lock
  if bash -c 'exec 8>"$1"; flock -n 8' _ "$CHATBOTX_DEPLOY_LOCK"; then
    echo "FAIL: a competing process acquired the production lock" >&2
    exit 1
  fi
  CHATBOTX_DEPLOY_LOCK_FD=9 bash -c 'flock -n 9' || {
    echo "FAIL: the verified lock FD was not inherited by a child" >&2
    exit 1
  }
fi

declare -A IDS=(
  [postgres]=postgres-id
  [redis]=redis-id
  [filesystem]=filesystem-id
)
declare -A STARTED=(
  [postgres]=2026-01-01T00:00:00Z
  [redis]=2026-01-01T00:00:00Z
  [filesystem]=2026-01-01T00:00:00Z
)
declare -A RESTARTS=([postgres]=0 [redis]=0 [filesystem]=0)
CALLS=()

compose() {
  CALLS+=("$*")
  if [[ "$1 $2 $3" == "ps -q zalo-personal" ]]; then
    return 0
  fi
  if [[ "$1 $2" == "ps -q" ]]; then
    printf '%s-container\n' "$3"
  fi
}

docker() {
  local container="${*: -1}"
  local service="${container%-container}"
  if [[ "$1" == "inspect" ]]; then
    printf '%s|%s|%s|healthy\n' \
      "${IDS[$service]}" "${STARTED[$service]}" "${RESTARTS[$service]}"
    return 0
  fi
  return 0
}

git() {
  printf '%040d\n' 1
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || {
    printf 'FAIL: %s (missing %s)\n' "$3" "$2" >&2
    exit 1
  }
}

before="$(snapshot_shared_services)"
assert_shared_services_unchanged "$before"

if (RESTARTS[redis]=1; assert_shared_services_unchanged "$before") 2>/dev/null; then
  echo "FAIL: restart-count drift must fail closed" >&2
  exit 1
fi
if (IDS[filesystem]=replacement; assert_shared_services_unchanged "$before") 2>/dev/null; then
  echo "FAIL: container identity drift must fail closed" >&2
  exit 1
fi
if (STARTED[postgres]=2026-01-02T00:00:00Z; assert_shared_services_unchanged "$before") 2>/dev/null; then
  echo "FAIL: StartedAt drift must fail closed" >&2
  exit 1
fi

readiness_probe() { :; }
state_set() { :; }
CALLS=()
activate
calls="$(printf '%s\n' "${CALLS[@]}")"
assert_contains "$calls" "--no-deps" "Zalo activation must not start dependencies"
assert_contains "$calls" "zalo-personal" "Zalo activation must target only the app"

source_text="$(<"$SCRIPT_DIR/production.sh")"
assert_contains "$source_text" 'new PrismaPg' "Prisma 7 readiness must use its PostgreSQL adapter"
assert_contains "$source_text" 'activate_previous_image' "Failed activation must restore the previous image"
assert_contains "$source_text" 'backup_object_bytes' "Complete backup must include RustFS object bytes"
if (validate_encrypted_backup_directory unsafe /tmp 1) >/dev/null 2>&1; then
  echo "FAIL: unsafe backup destinations must fail closed" >&2
  exit 1
fi
verified_backup="$TEST_DIR/verified-backup"
install -d -m 700 "$verified_backup"
touch "$verified_backup/.chatbotx-encrypted-backup-target"
validate_encrypted_backup_directory verified "$verified_backup" 1

export ZALO_BACKUP_KEEP_DAYS=1
expired_objects="$TEST_DIR/object-retention/objects-20000101T000000Z"
incomplete_objects="$TEST_DIR/object-retention/objects-20000102T000000Z"
mkdir -p "$expired_objects" "$incomplete_objects"
touch "$expired_objects/SHA256SUMS" "$expired_objects/.complete"
touch "$incomplete_objects/SHA256SUMS"
touch -t 200001010000 "$expired_objects" "$incomplete_objects"
prune_object_backups "$TEST_DIR/object-retention"
[[ ! -e "$expired_objects" ]] || {
  echo "FAIL: expired complete object backup was not pruned" >&2
  exit 1
}
[[ -d "$incomplete_objects" ]] || {
  echo "FAIL: incomplete object backup must be retained for operator review" >&2
  exit 1
}

rollback_log="$TEST_DIR/rollback.log"
compose() {
  if [[ "$1 $2 $3" == "ps -q zalo-personal" ]]; then
    printf 'zalo-app-container\n'
  elif [[ "$1" == "up" ]]; then
    printf '%s\n' "$CHATBOTX_ZALO_PERSONAL_IMAGE_TAG" >>"$rollback_log"
  fi
}
docker() {
  if [[ "$1" == "inspect" && "$*" == *'.Config.Image'* ]]; then
    printf 'chatbotx-zalo-personal:sha-%040d\n' 1
  fi
}
readiness_probe() {
  [[ "$CHATBOTX_ZALO_PERSONAL_IMAGE_TAG" == "sha-$(printf '%040d' 1)" ]]
}
state_set() { :; }
git() { printf '%040d\n' 2; }
CHATBOTX_ZALO_PERSONAL_IMAGE_TAG="sha-$(printf '%040d' 2)"
export CHATBOTX_ZALO_PERSONAL_IMAGE_TAG
if (activate) >/dev/null 2>&1; then
  echo "FAIL: a failed activation must return nonzero after automatic rollback" >&2
  exit 1
fi
rollback_calls="$(<"$rollback_log")"
assert_contains "$rollback_calls" "sha-$(printf '%040d' 2)" "New image was not attempted"
assert_contains "$rollback_calls" "sha-$(printf '%040d' 1)" "Previous image was not restored"

ORDER=()
verify_staged_release() { ORDER+=(release); }
preflight() { ORDER+=(preflight); }
snapshot_shared_services() { printf 'stable'; }
bootstrap_namespaces() { ORDER+=(bootstrap); }
create_backup() { ORDER+=(backup); }
backup_object_bytes() { ORDER+=(object-backup); }
migrate_database() { ORDER+=(migrate); }
activate() { ORDER+=(activate); }
assert_shared_services_unchanged() { ORDER+=(identity-check); }
clean_old_images() { ORDER+=(cleanup); }
deploy
order="$(printf '%s,' "${ORDER[@]}")"
[[ "$order" == "release,preflight,bootstrap,backup,object-backup,migrate,activate,identity-check,cleanup," ]] || {
  printf 'FAIL: unsafe deploy order: %s\n' "$order" >&2
  exit 1
}

printf 'Zalo selective production deployment tests passed.\n'
