#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
readonly REPO_ROOT
readonly LOCK_FILE="${CHATBOTX_DEPLOY_LOCK:-/var/lock/chatbotx-production.lock}"
readonly STATE_DIR="${ZALO_STATE_DIR:-/var/lib/chatbotx-production/zalo-personal}"
readonly BACKUP_DIR="${ZALO_BACKUP_DIR:-/var/backups/chatbotx-production/zalo-personal}"
readonly IMAGE_PREFIX="${CHATBOTX_IMAGE_PREFIX:-ghcr.io/hello-jackytruong}"
readonly KEEP_RELEASES="${ZALO_KEEP_RELEASES:-3}"
export CHATBOTX_ZALO_PERSONAL_IMAGE_TAG="${CHATBOTX_ZALO_PERSONAL_IMAGE_TAG:-${CHATBOTX_IMAGE_TAG:-local}}"

COMPOSE=(
  docker compose
  --project-directory "$REPO_ROOT"
  -f "$REPO_ROOT/docker-compose.production.yml"
  -f "$REPO_ROOT/docker-compose.zalo-personal.production.yml"
)
SHARED_SERVICES=(postgres redis filesystem)

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }
compose() { "${COMPOSE[@]}" "$@"; }

check_tools() {
  local command
  (( BASH_VERSINFO[0] >= 4 )) || fail "Bash 4 or newer is required."
  for command in cp docker find flock git grep install mktemp mv rm sed sha256sum sort stat tail tr xargs; do
    command -v "$command" >/dev/null 2>&1 || fail "Missing required command: $command"
  done
  docker compose version >/dev/null
}

validate_encrypted_backup_directory() {
  local label="$1" directory="$2" verified="$3" mode
  [[ "$verified" == "1" ]] ||
    fail "$label requires an explicit encrypted-target attestation."
  [[ "$directory" == /* ]] || fail "$label must be an absolute path."
  case "$directory" in
    / | /tmp | /var/tmp | /dev | /proc | /sys | /run | "$BACKUP_DIR")
      fail "$label points to an unsafe or non-independent directory."
      ;;
  esac
  [[ -d "$directory" ]] || fail "$label must already exist as a mounted backup target."
  [[ -f "$directory/.chatbotx-encrypted-backup-target" ]] ||
    fail "$label is missing .chatbotx-encrypted-backup-target."
  mode="$(stat -c '%a' "$directory")"
  [[ "$mode" == "700" ]] || fail "$label must have mode 0700 (found $mode)."
}

copy_backup_atomically() {
  local source="$1" destination="$2" temporary
  temporary="$(mktemp "$destination/.$(basename "$source").XXXXXX")"
  cp -- "$source" "$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$destination/$(basename "$source")"
}

dotenv_value() {
  local key="$1" fallback="${2:-}" value
  value="$(sed -n "s/^${key}=//p" "$REPO_ROOT/.env" 2>/dev/null | tail -n 1 | tr -d '\r')"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "${value:-$fallback}"
}

acquire_lock() {
  if [[ "${CHATBOTX_DEPLOY_LOCK_FD:-}" == "9" && -e /proc/$$/fd/9 ]]; then
    flock -n 9 || fail "Inherited production lock FD is not held."
    return
  fi
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another production operation is already running."
  export CHATBOTX_DEPLOY_LOCK_FD=9
}

state_set() {
  local name="$1" value="$2" temporary
  install -d -m 700 "$STATE_DIR"
  temporary="$(mktemp "$STATE_DIR/.${name}.XXXXXX")"
  printf '%s\n' "$value" >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$STATE_DIR/$name"
}

state_get() {
  [[ -f "$STATE_DIR/$1" ]] && tr -d '\r\n' <"$STATE_DIR/$1"
}

state_unset() {
  rm -f -- "$STATE_DIR/$1"
}

prune_local_backups() {
  local keep_days backup_file audit_log
  keep_days="${ZALO_BACKUP_KEEP_DAYS:-$(dotenv_value ZALO_BACKUP_KEEP_DAYS 30)}"
  [[ "$keep_days" =~ ^[0-9]+$ && "$keep_days" -gt 0 ]] ||
    fail "ZALO_BACKUP_KEEP_DAYS must be a positive integer."
  audit_log="$BACKUP_DIR/retention-audit.log"
  while IFS= read -r backup_file; do
    printf '[%s] deleted expired local backup %s\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$backup_file" >>"$audit_log"
    rm -f -- "$backup_file"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'zalo-*.dump' -o -name 'globals-*.sql' -o \
       -name 'zalo-*.sha256' -o -name 'globals-*.sha256' \) \
    -mtime "+$keep_days" -print)
  [[ ! -e "$audit_log" ]] || chmod 600 "$audit_log"
}

prune_object_backups() {
  local base_directory="$1" keep_days object_directory audit_log
  keep_days="${ZALO_BACKUP_KEEP_DAYS:-$(dotenv_value ZALO_BACKUP_KEEP_DAYS 30)}"
  [[ "$keep_days" =~ ^[0-9]+$ && "$keep_days" -gt 0 ]] ||
    fail "ZALO_BACKUP_KEEP_DAYS must be a positive integer."
  audit_log="$base_directory/retention-audit.log"
  while IFS= read -r object_directory; do
    [[ -f "$object_directory/.complete" && -f "$object_directory/SHA256SUMS" ]] ||
      continue
    printf '[%s] deleted expired complete object backup %s\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$object_directory" >>"$audit_log"
    find "$object_directory" -depth -delete
  done < <(find "$base_directory" -mindepth 1 -maxdepth 1 -type d \
    -name 'objects-*' -mtime "+$keep_days" -print)
  [[ ! -e "$audit_log" ]] || chmod 600 "$audit_log"
}

container_fingerprint() {
  local service="$1" container_id
  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || fail "Shared service $service is not running."
  docker inspect --format \
    '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Health.Status}}' \
    "$container_id"
}

snapshot_shared_services() {
  local service
  for service in "${SHARED_SERVICES[@]}"; do
    printf '%s=%s\n' "$service" "$(container_fingerprint "$service")"
  done
}

assert_shared_services_unchanged() {
  local expected="$1" actual
  actual="$(snapshot_shared_services)"
  [[ "$actual" == "$expected" ]] || {
    printf 'Expected shared identities:\n%s\nActual shared identities:\n%s\n' \
      "$expected" "$actual" >&2
    log "ERROR: A shared container was recreated, restarted, or became unhealthy." >&2
    return 1
  }
}

preflight() {
  local deployment_mode av_enabled av_fail_closed
  [[ -f "$REPO_ROOT/.env" ]] || fail "Missing $REPO_ROOT/.env"
  compose --profile bootstrap config --quiet
  deployment_mode="${ZALO_DEPLOYMENT_MODE:-$(dotenv_value ZALO_DEPLOYMENT_MODE)}"
  case "$deployment_mode" in
    fresh | migrate) ;;
    *) fail "Set ZALO_DEPLOYMENT_MODE=fresh or migrate after completing the data inventory." ;;
  esac
  snapshot_shared_services >/dev/null
  av_enabled="${ZALO_MEDIA_AV_ENABLED:-$(dotenv_value ZALO_MEDIA_AV_ENABLED 0)}"
  av_fail_closed="${ZALO_MEDIA_AV_FAIL_CLOSED:-$(dotenv_value ZALO_MEDIA_AV_FAIL_CLOSED 1)}"
  if [[ "$av_enabled" == "1" ]]; then
    container_fingerprint clamav >/dev/null
    [[ "$av_fail_closed" == "1" ]] ||
      fail "AV-enabled production deploys must be fail-closed unless separately approved."
  fi
  preflight_backup_configuration
}

preflight_backup_configuration() {
  local offsite_directory globals_offsite_directory allow_local_only
  local offsite_verified globals_offsite_verified
  offsite_directory="${ZALO_BACKUP_OFFSITE_DIR:-$(dotenv_value ZALO_BACKUP_OFFSITE_DIR)}"
  globals_offsite_directory="${ZALO_GLOBALS_BACKUP_OFFSITE_DIR:-$(dotenv_value ZALO_GLOBALS_BACKUP_OFFSITE_DIR)}"
  allow_local_only="${ZALO_ALLOW_LOCAL_BACKUP_ONLY:-$(dotenv_value ZALO_ALLOW_LOCAL_BACKUP_ONLY 0)}"
  if [[ -n "$offsite_directory" ]]; then
    offsite_verified="${ZALO_BACKUP_OFFSITE_VERIFIED:-$(dotenv_value ZALO_BACKUP_OFFSITE_VERIFIED 0)}"
    globals_offsite_verified="${ZALO_GLOBALS_BACKUP_OFFSITE_VERIFIED:-$(dotenv_value ZALO_GLOBALS_BACKUP_OFFSITE_VERIFIED 0)}"
    validate_encrypted_backup_directory \
      ZALO_BACKUP_OFFSITE_DIR "$offsite_directory" "$offsite_verified"
    validate_encrypted_backup_directory \
      ZALO_GLOBALS_BACKUP_OFFSITE_DIR "$globals_offsite_directory" "$globals_offsite_verified"
    [[ "$offsite_directory" != "$globals_offsite_directory" ]] ||
      fail "PostgreSQL globals require separate administrator-only custody."
  elif [[ "$allow_local_only" != "1" ]]; then
    fail "Set verified encrypted backup targets before production bootstrap."
  fi
}

bootstrap_namespaces() {
  compose --profile bootstrap run --rm --no-deps zalo-database-init
  compose --profile bootstrap run --rm --no-deps zalo-filesystem-init
}

create_backup() {
  local timestamp temporary dump_path globals_temporary globals_path
  local dump_manifest globals_manifest postgres_user zalo_database
  local offsite_directory globals_offsite_directory allow_local_only
  local offsite_verified globals_offsite_verified
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  install -d -m 700 "$BACKUP_DIR"
  temporary="$(mktemp "$BACKUP_DIR/.zalo-${timestamp}.XXXXXX.dump")"
  dump_path="$BACKUP_DIR/zalo-${timestamp}.dump"
  globals_temporary="$(mktemp "$BACKUP_DIR/.globals-${timestamp}.XXXXXX.sql")"
  globals_path="$BACKUP_DIR/globals-${timestamp}.sql"
  dump_manifest="$BACKUP_DIR/zalo-${timestamp}.sha256"
  globals_manifest="$BACKUP_DIR/globals-${timestamp}.sha256"

  postgres_user="${POSTGRES_USER:-$(dotenv_value POSTGRES_USER chatbotx)}"
  zalo_database="${ZALO_DB_NAME:-$(dotenv_value ZALO_DB_NAME zalo_personal)}"
  compose exec -T postgres pg_dump -Fc \
    -U "$postgres_user" -d "$zalo_database" >"$temporary"
  [[ -s "$temporary" ]] || fail "Zalo database backup is empty."
  compose exec -T postgres pg_restore --list <"$temporary" >/dev/null
  compose exec -T postgres pg_dumpall --globals-only \
    -U "$postgres_user" >"$globals_temporary"
  [[ -s "$globals_temporary" ]] || fail "PostgreSQL globals backup is empty."

  chmod 600 "$temporary" "$globals_temporary"
  mv -- "$temporary" "$dump_path"
  mv -- "$globals_temporary" "$globals_path"
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$dump_path")" \
    >"$(basename "$dump_manifest")")
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$globals_path")" \
    >"$(basename "$globals_manifest")")
  chmod 600 "$dump_manifest" "$globals_manifest"

  offsite_directory="${ZALO_BACKUP_OFFSITE_DIR:-$(dotenv_value ZALO_BACKUP_OFFSITE_DIR)}"
  globals_offsite_directory="${ZALO_GLOBALS_BACKUP_OFFSITE_DIR:-$(dotenv_value ZALO_GLOBALS_BACKUP_OFFSITE_DIR)}"
  allow_local_only="${ZALO_ALLOW_LOCAL_BACKUP_ONLY:-$(dotenv_value ZALO_ALLOW_LOCAL_BACKUP_ONLY 0)}"
  if [[ -n "$offsite_directory" ]]; then
    offsite_verified="${ZALO_BACKUP_OFFSITE_VERIFIED:-$(dotenv_value ZALO_BACKUP_OFFSITE_VERIFIED 0)}"
    globals_offsite_verified="${ZALO_GLOBALS_BACKUP_OFFSITE_VERIFIED:-$(dotenv_value ZALO_GLOBALS_BACKUP_OFFSITE_VERIFIED 0)}"
    validate_encrypted_backup_directory \
      ZALO_BACKUP_OFFSITE_DIR "$offsite_directory" "$offsite_verified"
    validate_encrypted_backup_directory \
      ZALO_GLOBALS_BACKUP_OFFSITE_DIR "$globals_offsite_directory" "$globals_offsite_verified"
    [[ "$offsite_directory" != "$globals_offsite_directory" ]] ||
      fail "PostgreSQL globals require separate administrator-only custody."
    copy_backup_atomically "$dump_path" "$offsite_directory"
    copy_backup_atomically "$dump_manifest" "$offsite_directory"
    copy_backup_atomically "$globals_path" "$globals_offsite_directory"
    copy_backup_atomically "$globals_manifest" "$globals_offsite_directory"
    (cd "$offsite_directory" && sha256sum -c "$(basename "$dump_manifest")")
    (cd "$globals_offsite_directory" && sha256sum -c "$(basename "$globals_manifest")")
  elif [[ "$allow_local_only" != "1" ]]; then
    fail "Set an encrypted ZALO_BACKUP_OFFSITE_DIR or explicitly approve local-only backup."
  fi
  state_set latest-backup "$dump_path"
  prune_local_backups
  log "Verified custom-format database backup."
}

backup_object_bytes() {
  local offsite_directory allow_local_only offsite_verified target timestamp manifest_temporary
  offsite_directory="${ZALO_BACKUP_OFFSITE_DIR:-$(dotenv_value ZALO_BACKUP_OFFSITE_DIR)}"
  allow_local_only="${ZALO_ALLOW_LOCAL_BACKUP_ONLY:-$(dotenv_value ZALO_ALLOW_LOCAL_BACKUP_ONLY 0)}"
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  if [[ -n "$offsite_directory" ]]; then
    offsite_verified="${ZALO_BACKUP_OFFSITE_VERIFIED:-$(dotenv_value ZALO_BACKUP_OFFSITE_VERIFIED 0)}"
    validate_encrypted_backup_directory \
      ZALO_BACKUP_OFFSITE_DIR "$offsite_directory" "$offsite_verified"
    target="$offsite_directory/objects-$timestamp"
  elif [[ "$allow_local_only" == "1" ]]; then
    target="$BACKUP_DIR/objects-$timestamp"
  else
    fail "Object-byte backup requires an encrypted offsite directory."
  fi
  install -d -m 700 "$target"
  # Variables below are expanded inside the one-shot RustFS client container.
  # shellcheck disable=SC2016
  compose --profile bootstrap run --rm --no-deps \
    -v "$target:/backup" --entrypoint /bin/sh zalo-filesystem-init -ec '
      rc alias set rustfs http://filesystem:9000 "$RUSTFS_ADMIN_ACCESS_KEY" "$RUSTFS_ADMIN_SECRET_KEY"
      rc cp --recursive --overwrite "rustfs/$CHATBOTX_S3_BUCKET/" /backup/chatbotx/
      rc cp --recursive --overwrite "rustfs/$ZALO_S3_BUCKET/" /backup/zalo-personal/
    '
  manifest_temporary="$(mktemp "$BACKUP_DIR/.objects-${timestamp}.XXXXXX.sha256")"
  (cd "$target" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) \
    >"$manifest_temporary"
  mv -- "$manifest_temporary" "$target/SHA256SUMS"
  touch "$target/.complete"
  chmod -R go-rwx "$target"
  [[ -f "$target/SHA256SUMS" ]] || fail "RustFS byte backup manifest was not created."
  prune_object_backups "$(dirname "$target")"
  log "Verified RustFS object-byte backup."
}

guard_migration_compatibility() {
  local previous_sha destructive
  previous_sha="$(state_get deployed-git-sha || true)"
  [[ -n "$previous_sha" ]] || return 0
  git -C "$REPO_ROOT" cat-file -e "$previous_sha^{commit}" 2>/dev/null ||
    fail "Previous Zalo deployment SHA is unavailable for migration compatibility review."
  destructive="$(git -C "$REPO_ROOT" diff --unified=0 "$previous_sha" HEAD -- \
    apps/zalo-personal/backend/prisma/migrations | \
    grep -Ei '^\+.*(TRUNCATE|DELETE[[:space:]]+FROM|DROP[[:space:]]+(TABLE|COLUMN|TYPE|CONSTRAINT)|ALTER[[:space:]].*RENAME|ALTER[[:space:]].*(TYPE|SET[[:space:]]+NOT[[:space:]]+NULL))' || true)"
  if [[ -n "$destructive" && "${ZALO_DESTRUCTIVE_MIGRATION_APPROVED:-0}" != "1" ]]; then
    fail "Pending Prisma SQL is not backward-compatible; use the stop-traffic/restore procedure."
  fi
}

migrate_database() {
  guard_migration_compatibility
  compose run --rm --no-deps zalo-personal npx prisma migrate deploy
}

readiness_probe() {
  # JavaScript reads container environment variables, not shell variables.
  # shellcheck disable=SC2016
  compose exec -T zalo-personal node --input-type=module -e '
    import { PrismaClient } from "@prisma/client";
    import { PrismaPg } from "@prisma/adapter-pg";
    import Redis from "ioredis";
    import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION,
      forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY } });
    const key = `.deploy-probe/${Date.now()}`;
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      if (await redis.ping() !== "PONG") throw new Error("Redis ping failed");
      await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: "ok" }));
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    } finally { await Promise.allSettled([prisma.$disconnect(), redis.quit()]); }
  '
}

activate_previous_image() {
  local previous_image="$1" previous_tag
  [[ "$previous_image" == chatbotx-zalo-personal:sha-* ]] || return 1
  previous_tag="${previous_image#chatbotx-zalo-personal:}"
  export CHATBOTX_ZALO_PERSONAL_IMAGE_TAG="$previous_tag"
  compose up -d --no-deps --wait --wait-timeout 180 zalo-personal
  readiness_probe
}

restore_previous_image_state() {
  local current_image previous_image previous_deployed_sha
  current_image="$(state_get current-image || true)"
  previous_image="$(state_get previous-image || true)"
  previous_deployed_sha="$(state_get previous-deployed-git-sha || true)"
  [[ "$previous_image" == chatbotx-zalo-personal:sha-* ]] || return 1
  activate_previous_image "$previous_image" || return 1
  state_set current-image "$previous_image"
  if [[ "$current_image" == chatbotx-zalo-personal:sha-* ]]; then
    state_set previous-image "$current_image"
  fi
  if [[ -n "$previous_deployed_sha" ]]; then
    state_set deployed-git-sha "$previous_deployed_sha"
  else
    state_unset deployed-git-sha
  fi
}

activate() {
  local previous_image="" previous_deployed_sha container_id attempted_tag
  attempted_tag="$CHATBOTX_ZALO_PERSONAL_IMAGE_TAG"
  previous_deployed_sha="$(state_get deployed-git-sha || true)"
  container_id="$(compose ps -q zalo-personal 2>/dev/null || true)"
  if [[ -n "$container_id" ]]; then
    previous_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
    state_set previous-image "$previous_image"
  else
    state_unset previous-image
  fi
  if ! compose up -d --no-deps --wait --wait-timeout 180 zalo-personal ||
    ! readiness_probe; then
    log "Zalo activation failed; restoring the previous image."
    if [[ -n "$previous_image" ]]; then
      activate_previous_image "$previous_image" ||
        fail "Zalo activation and automatic image rollback both failed."
    else
      compose stop zalo-personal || true
    fi
    fail "Zalo activation failed; the previous image was restored when available."
  fi
  state_set current-image "chatbotx-zalo-personal:$attempted_tag"
  if [[ -n "$previous_deployed_sha" ]]; then
    state_set previous-deployed-git-sha "$previous_deployed_sha"
  else
    state_unset previous-deployed-git-sha
  fi
  state_set deployed-git-sha "$(git -C "$REPO_ROOT" rev-parse HEAD)"
}

verify_staged_release() {
  local local_image revision expected_sha
  expected_sha="${CHATBOTX_EXPECTED_GIT_SHA:?CHATBOTX_EXPECTED_GIT_SHA is required}"
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Invalid CHATBOTX_EXPECTED_GIT_SHA."
  [[ "$CHATBOTX_ZALO_PERSONAL_IMAGE_TAG" == "sha-$expected_sha" ]] ||
    fail "Production deploy requires an immutable sha-<git-sha> Zalo image tag."
  local_image="chatbotx-zalo-personal:$CHATBOTX_ZALO_PERSONAL_IMAGE_TAG"
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$local_image")"
  [[ "$revision" == "$expected_sha" ]] ||
    fail "Staged Zalo image revision does not match the requested release."
}

pull_release() {
  local tag remote_image revision
  tag="${CHATBOTX_IMAGE_TAG:?CHATBOTX_IMAGE_TAG is required}"
  remote_image="${IMAGE_PREFIX%/}/chatbotx-zalo-personal:$tag"
  docker pull "$remote_image"
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$remote_image")"
  [[ "$revision" == "${CHATBOTX_EXPECTED_GIT_SHA:?CHATBOTX_EXPECTED_GIT_SHA is required}" ]] ||
    fail "Zalo image revision does not match the requested release."
  docker image tag "$remote_image" "chatbotx-zalo-personal:$tag"
  docker image rm "$remote_image" >/dev/null 2>&1 || true
  export CHATBOTX_ZALO_PERSONAL_IMAGE_TAG="$tag"
}

deploy() {
  local shared_before
  verify_staged_release
  preflight
  shared_before="$(snapshot_shared_services)"
  bootstrap_namespaces
  create_backup
  backup_object_bytes
  migrate_database
  activate
  if ! assert_shared_services_unchanged "$shared_before"; then
    restore_previous_image_state ||
      fail "Shared-state verification failed and the previous Zalo image could not be restored."
    fail "Shared-state verification failed; the previous Zalo image was restored."
  fi
  clean_old_images
}

clean_old_images() {
  local repository="chatbotx-zalo-personal" current_image previous_image tag kept=0
  current_image="$(state_get current-image || true)"
  previous_image="$(state_get previous-image || true)"
  while IFS= read -r tag; do
    [[ -n "$tag" && "$tag" != "<none>" ]] || continue
    if [[ "$repository:$tag" == "$current_image" ||
      "$repository:$tag" == "$previous_image" || "$tag" == "local" ||
      $kept -lt $KEEP_RELEASES ]]; then
      ((kept += 1))
      continue
    fi
    log "Removing obsolete Zalo image tag: $tag"
    docker image rm "$repository:$tag" >/dev/null 2>&1 || true
  done < <(docker image ls "$repository" --format '{{.Tag}}')
}

rollback() {
  local shared_before
  preflight
  shared_before="$(snapshot_shared_services)"
  restore_previous_image_state || fail "No healthy previous Zalo image could be restored."
  assert_shared_services_unchanged "$shared_before"
}

install_backup_cron() {
  local existing cron_line quoted_root quoted_script
  command -v crontab >/dev/null 2>&1 || fail "crontab is required to install backups."
  printf -v quoted_root '%q' "$REPO_ROOT"
  printf -v quoted_script '%q' "$SCRIPT_DIR/production.sh"
  cron_line="17 3 * * * cd $quoted_root && $quoted_script backup >> $quoted_root/logs/zalo-backup.log 2>&1"
  existing="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$existing" | grep -Fqx "$cron_line"; then
    log "Zalo complete-backup cron is already installed."
    return
  fi
  install -d -m 700 "$REPO_ROOT/logs"
  { printf '%s\n' "$existing"; printf '%s\n' "$cron_line"; } | crontab -
  log "Installed daily Zalo database/globals/RustFS backup at 03:17."
}

usage() {
  echo "Usage: $0 {check|deploy|pull-deploy|backup|install-backup-cron|rollback|status|logs [service]|config}" >&2
}

main() {
  local command="${1:-status}"
  check_tools
  case "$command" in
    check) acquire_lock; preflight ;;
    deploy) acquire_lock; deploy ;;
    pull-deploy) acquire_lock; pull_release; deploy ;;
    backup) acquire_lock; preflight; create_backup; backup_object_bytes ;;
    install-backup-cron) install_backup_cron ;;
    rollback) acquire_lock; rollback ;;
    status) compose ps zalo-personal postgres redis filesystem ;;
    logs) compose logs -f --tail=200 "${2:-zalo-personal}" ;;
    config) compose --profile bootstrap config --quiet ;;
    *) usage; return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
