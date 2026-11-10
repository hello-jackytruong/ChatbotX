#!/usr/bin/env bash

set -Eeuo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  printf 'SKIP: production dispatcher tests require Bash 4 or newer.\n'
  exit 0
fi

TEST_DIR="$(mktemp -d)"
export CHATBOTX_DEPLOY_LOCK="$TEST_DIR/production.lock"
export CHATBOTX_ENV_FILE="$TEST_DIR/.env"
trap 'rm -rf -- "$TEST_DIR"' EXIT

backup_dir="$TEST_DIR/encrypted-backups"
globals_dir="$TEST_DIR/encrypted-globals"
install -d -m 700 "$backup_dir" "$globals_dir"
touch "$backup_dir/.chatbotx-encrypted-backup-target"
touch "$globals_dir/.chatbotx-encrypted-backup-target"
cat >"$CHATBOTX_ENV_FILE" <<EOF
PRODUCTION_AUTOMATION_READY=1
APP_URL=https://app.example.test
S3_ENDPOINT=https://app.example.test
BETTER_AUTH_SECRET=better-auth-secret-at-least-32-characters
ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
POSTGRES_USER=chatbotx
POSTGRES_PASSWORD=chatbotx-postgres-password-at-least-24
S3_ACCESS_KEY_ID=chatbotx-storage
S3_SECRET_ACCESS_KEY=chatbotx-storage-secret-at-least-24
S3_BUCKET=chatbotx
REALTIME_BROADCAST_SECRET=realtime-secret-at-least-32-characters
JAVASCRIPT_EXECUTOR_TOKEN=executor-secret-at-least-32-characters
ZALO_APP_URL=https://zalo.example.test
ZALO_DB_USER=zalo_personal
ZALO_DB_PASSWORD=zalo-postgres-password-at-least-24
ZALO_DB_NAME=zalo_personal
ZALO_DATABASE_URL=postgresql://zalo_personal:zalo-postgres-password-at-least-24@postgres:5432/zalo_personal
ZALO_REDIS_URL=redis://redis:6379/1
ZALO_DEPLOYMENT_MODE=migrate
ZALO_JWT_SECRET=zalo-jwt-secret-at-least-32-characters
ZALO_ENCRYPTION_KEY=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
ZALO_S3_ACCESS_KEY_ID=zalo-storage
ZALO_S3_SECRET_ACCESS_KEY=zalo-storage-secret-at-least-24
ZALO_S3_BUCKET=zalocrm-attachments
ZALO_S3_PUBLIC_URL=https://files.example.test/zalocrm-attachments
ZALO_AUTOMATION_STUB_MODE=false
ZALO_BACKUP_OFFSITE_DIR=$backup_dir
ZALO_BACKUP_OFFSITE_VERIFIED=1
ZALO_GLOBALS_BACKUP_OFFSITE_DIR=$globals_dir
ZALO_GLOBALS_BACKUP_OFFSITE_VERIFIED=1
EOF
chmod 600 "$CHATBOTX_ENV_FILE"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/production-full.sh"

validate_automation_environment
chmod 644 "$CHATBOTX_ENV_FILE"
if (validate_automation_environment) >/dev/null 2>&1; then
  echo "FAIL: production automation must reject an overly broad .env mode" >&2
  exit 1
fi
chmod 600 "$CHATBOTX_ENV_FILE"

cp "$CHATBOTX_ENV_FILE" "$TEST_DIR/valid.env"
sed -i.bak 's/^ZALO_JWT_SECRET=.*/ZALO_JWT_SECRET=replace-with-secret/' "$CHATBOTX_ENV_FILE"
if (validate_automation_environment) >/dev/null 2>&1; then
  echo "FAIL: production automation must reject placeholder secrets" >&2
  exit 1
fi
mv "$TEST_DIR/valid.env" "$CHATBOTX_ENV_FILE"
chmod 600 "$CHATBOTX_ENV_FILE"

cp "$CHATBOTX_ENV_FILE" "$TEST_DIR/valid.env"
for invalid_endpoint in \
  'http://app.example.test' \
  'https://localhost:9000' \
  'https://filesystem:9000'; do
  sed -i.bak "s|^S3_ENDPOINT=.*|S3_ENDPOINT=$invalid_endpoint|" "$CHATBOTX_ENV_FILE"
  if (validate_automation_environment) >/dev/null 2>&1; then
    echo "FAIL: production automation accepted invalid S3_ENDPOINT=$invalid_endpoint" >&2
    exit 1
  fi
  cp "$TEST_DIR/valid.env" "$CHATBOTX_ENV_FILE"
done
rm -f "$TEST_DIR/valid.env"

split_services "zalo-personal"
[[ "$DEPLOY_ZALO" == "true" && ${#CHATBOTX_SERVICES[@]} -eq 0 ]] || {
  echo "FAIL: Zalo-only routing leaked into the ChatbotX deploy scope" >&2
  exit 1
}

split_services "builder,realtime,zalo-personal"
[[ "$DEPLOY_ZALO" == "true" ]] || exit 1
[[ "${CHATBOTX_SERVICES[0]}" == "builder" ]] || exit 1
[[ "${CHATBOTX_SERVICES[1]}" == "realtime" ]] || exit 1

source_text="$(<"$SCRIPT_DIR/production-full.sh")"
workflow_text="$(<"$SCRIPT_DIR/../../.github/workflows/deploy-production.yml")"
lock_line="$(grep -n '^[[:space:]]*acquire_lock$' "$SCRIPT_DIR/production-full.sh" | head -n 1 | cut -d: -f1)"
checkout_line="$(grep -n '^[[:space:]]*checkout_release_under_lock' "$SCRIPT_DIR/production-full.sh" | tail -n 1 | cut -d: -f1)"
[[ -n "$lock_line" && -n "$checkout_line" && "$lock_line" -lt "$checkout_line" ]] || {
  echo "FAIL: checkout mutation is not guarded by the host deployment lock" >&2
  exit 1
}
[[ "$source_text" != *"down --volumes"* ]] || exit 1
# GitHub expression syntax must remain literal in these workflow assertions.
# shellcheck disable=SC2016
[[ "$workflow_text" == *'DEPLOY_SERVICES: ${{ needs.detect.outputs.services }}'* ]] || {
  echo "FAIL: production activation must receive the complete affected service set" >&2
  exit 1
}
# shellcheck disable=SC2016
[[ "$workflow_text" != *'matrix: ${{ fromJSON(needs.detect.outputs.deploy_matrix) }}'* ]] || {
  echo "FAIL: affected scopes must not mutate production in separate matrix jobs" >&2
  exit 1
}
[[ "$workflow_text" == *'environment: production'* && \
  "$workflow_text" == *'record-successful-baseline:'* ]] || {
  echo "FAIL: scope baselines must be recorded only after combined activation" >&2
  exit 1
}
# These literals assert that workflow variables are evaluated on the host.
# shellcheck disable=SC2016
[[ "$workflow_text" == *'git checkout --quiet dev'* && \
  "$workflow_text" == *'git merge --ff-only --quiet "$release_sha"'* ]] || {
  echo "FAIL: CI checkout must not print the production file diff" >&2
  exit 1
}
# shellcheck disable=SC2016
[[ "$workflow_text" == *'install -d -m 700 "$deploy_log_dir"'* && \
  "$workflow_text" == *'chmod 600 "$deploy_log"'* && \
  "$workflow_text" == *'>"$deploy_log" 2>&1'* ]] || {
  echo "FAIL: detailed deployment output must stay in a restricted host-only log" >&2
  exit 1
}
[[ "$workflow_text" != *'production-full.sh status'* ]] || {
  echo "FAIL: failed CI activation must not publish the production container inventory" >&2
  exit 1
}
[[ "$source_text" == *'rollback_completed_scopes'* ]] || {
  echo "FAIL: a mixed-scope failure must restore scopes activated earlier in the release" >&2
  exit 1
}

preflight_line="$(grep -n '^[[:space:]]*preflight_scopes ' "$SCRIPT_DIR/production-full.sh" | head -n 1 | cut -d: -f1)"
schedule_line="$(grep -n '^[[:space:]]*ensure_backup_schedules ' "$SCRIPT_DIR/production-full.sh" | head -n 1 | cut -d: -f1)"
smoke_line="$(grep -n '^[[:space:]]*record_shared_state$' "$SCRIPT_DIR/production-full.sh" | head -n 1 | cut -d: -f1)"
deploy_line="$(grep -n 'CHATBOTX_DEPLOY.*pull-deploy' "$SCRIPT_DIR/production-full.sh" | head -n 1 | cut -d: -f1)"
verify_line="$(grep -n 'verify_shared_state' "$SCRIPT_DIR/production-full.sh" | tail -n 1 | cut -d: -f1)"
[[ -n "$preflight_line" && -n "$schedule_line" && -n "$smoke_line" && \
  -n "$deploy_line" && -n "$verify_line" && \
  "$preflight_line" -lt "$schedule_line" && \
  "$schedule_line" -lt "$smoke_line" && "$smoke_line" -lt "$deploy_line" && \
  "$deploy_line" -lt "$verify_line" ]] || {
  echo "FAIL: all-scope preflight and backup schedules must complete before deployment" >&2
  exit 1
}

printf 'Production scope dispatcher tests passed.\n'
