#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_ROOT
readonly LOCK_FILE="${CHATBOTX_DEPLOY_LOCK:-/var/lock/chatbotx-production.lock}"
readonly ENV_FILE="${CHATBOTX_ENV_FILE:-$REPO_ROOT/.env}"
readonly CHATBOTX_DEPLOY="$REPO_ROOT/scripts/deployment/production.sh"
readonly ZALO_DEPLOY="$REPO_ROOT/scripts/docker/zalo-personal/production.sh"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

dotenv_value() {
  local key="$1" value
  value="$(sed -n "s/^${key}=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '\r')"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

require_env_value() {
  local key="$1" value
  value="$(dotenv_value "$key")"
  [[ -n "$value" ]] || fail "Missing required production env: $key"
  case "${value,,}" in
    *change-me* | *replace-with* | *insecure-default* | secretkey)
      fail "Production env $key still contains a placeholder value."
      ;;
  esac
  printf '%s' "$value"
}

require_secret_length() {
  local key="$1" minimum="$2" value
  value="$(require_env_value "$key")"
  (( ${#value} >= minimum )) ||
    fail "Production env $key must contain at least $minimum characters."
}

require_hex_key() {
  local key="$1" value
  value="$(require_env_value "$key")"
  [[ "$value" =~ ^[0-9a-fA-F]{64}$ ]] ||
    fail "Production env $key must be exactly 64 hexadecimal characters."
}

validate_backup_target() {
  local key="$1" verified_key="$2" directory mode
  directory="$(require_env_value "$key")"
  [[ "$(require_env_value "$verified_key")" == "1" ]] ||
    fail "$verified_key must be 1 after verifying the encrypted mount."
  [[ "$directory" == /* && -d "$directory" ]] ||
    fail "$key must be an existing absolute directory."
  [[ -f "$directory/.chatbotx-encrypted-backup-target" ]] ||
    fail "$key is missing .chatbotx-encrypted-backup-target."
  mode="$(stat -c '%a' "$directory")"
  [[ "$mode" == "700" ]] || fail "$key must have mode 0700."
  printf '%s' "$directory"
}

validate_automation_environment() {
  local mode app_url zalo_app_url zalo_public_url postgres_user zalo_user
  local s3_access zalo_s3_access s3_bucket zalo_s3_bucket database_url
  local backup_directory globals_directory deployment_mode
  [[ -f "$ENV_FILE" ]] || fail "Missing production env file: $ENV_FILE"
  mode="$(stat -c '%a' "$ENV_FILE")"
  [[ "$mode" == "600" ]] || fail "Production .env must have mode 0600 (found $mode)."
  [[ "$(require_env_value PRODUCTION_AUTOMATION_READY)" == "1" ]] ||
    fail "Set PRODUCTION_AUTOMATION_READY=1 only after completing the production checklist."

  app_url="$(require_env_value APP_URL)"
  zalo_app_url="$(require_env_value ZALO_APP_URL)"
  zalo_public_url="$(require_env_value ZALO_S3_PUBLIC_URL)"
  [[ "$app_url" == https://* ]] || fail "APP_URL must use HTTPS in production."
  [[ "$zalo_app_url" == https://* ]] || fail "ZALO_APP_URL must use HTTPS in production."
  [[ "$zalo_public_url" == https://* ]] || fail "ZALO_S3_PUBLIC_URL must use HTTPS in production."

  require_secret_length BETTER_AUTH_SECRET 32
  require_hex_key ENCRYPTION_KEY
  require_secret_length POSTGRES_PASSWORD 24
  require_secret_length S3_SECRET_ACCESS_KEY 24
  require_secret_length REALTIME_BROADCAST_SECRET 32
  require_secret_length JAVASCRIPT_EXECUTOR_TOKEN 32
  require_secret_length ZALO_DB_PASSWORD 24
  require_secret_length ZALO_JWT_SECRET 32
  require_hex_key ZALO_ENCRYPTION_KEY
  require_secret_length ZALO_S3_SECRET_ACCESS_KEY 24

  postgres_user="$(require_env_value POSTGRES_USER)"
  zalo_user="$(require_env_value ZALO_DB_USER)"
  s3_access="$(require_env_value S3_ACCESS_KEY_ID)"
  zalo_s3_access="$(require_env_value ZALO_S3_ACCESS_KEY_ID)"
  s3_bucket="$(require_env_value S3_BUCKET)"
  zalo_s3_bucket="$(require_env_value ZALO_S3_BUCKET)"
  [[ "$postgres_user" != "$zalo_user" ]] || fail "ChatbotX and Zalo database roles must differ."
  [[ "$s3_access" != "$zalo_s3_access" ]] || fail "ChatbotX and Zalo RustFS identities must differ."
  [[ "$s3_bucket" != "$zalo_s3_bucket" ]] || fail "ChatbotX and Zalo buckets must differ."

  [[ "$(require_env_value ZALO_REDIS_URL)" == "redis://redis:6379/1" ]] ||
    fail "ZALO_REDIS_URL must select shared Redis DB 1."
  database_url="$(require_env_value ZALO_DATABASE_URL)"
  [[ "$database_url" == "postgresql://${zalo_user}:"* &&
    "$database_url" == *"@postgres:5432/$(require_env_value ZALO_DB_NAME)"* ]] ||
    fail "ZALO_DATABASE_URL must target the dedicated database on shared PostgreSQL."
  deployment_mode="$(require_env_value ZALO_DEPLOYMENT_MODE)"
  [[ "$deployment_mode" == "fresh" || "$deployment_mode" == "migrate" ]] ||
    fail "ZALO_DEPLOYMENT_MODE must be fresh or migrate."
  [[ "$(require_env_value ZALO_AUTOMATION_STUB_MODE)" == "false" ]] ||
    fail "ZALO_AUTOMATION_STUB_MODE must be false in production."

  backup_directory="$(validate_backup_target ZALO_BACKUP_OFFSITE_DIR ZALO_BACKUP_OFFSITE_VERIFIED)"
  globals_directory="$(validate_backup_target ZALO_GLOBALS_BACKUP_OFFSITE_DIR ZALO_GLOBALS_BACKUP_OFFSITE_VERIFIED)"
  [[ "$backup_directory" != "$globals_directory" ]] ||
    fail "Zalo data and PostgreSQL globals require separate backup custody."
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

validate_full_config() {
  validate_automation_environment
  docker compose --project-directory "$REPO_ROOT" \
    -f "$REPO_ROOT/docker-compose.production.yml" \
    -f "$REPO_ROOT/docker-compose.zalo-personal.production.yml" \
    --profile bootstrap config --quiet
}

preflight_scopes() {
  local joined=""
  if (( ${#CHATBOTX_SERVICES[@]} > 0 )); then
    joined="$(IFS=,; printf '%s' "${CHATBOTX_SERVICES[*]}")"
    CHATBOTX_DEPLOY_SERVICES="$joined" "$CHATBOTX_DEPLOY" check
  fi
  if [[ "$DEPLOY_ZALO" == "true" ]]; then
    "$ZALO_DEPLOY" check
  fi
}

ensure_backup_schedules() {
  if (( ${#CHATBOTX_SERVICES[@]} > 0 )); then
    "$CHATBOTX_DEPLOY" install-cron
  fi
  if [[ "$DEPLOY_ZALO" == "true" ]]; then
    "$ZALO_DEPLOY" install-backup-cron
  fi
}

record_shared_state() {
  command -v node >/dev/null 2>&1 || fail "Node.js is required for shared-state smoke checks."
  node "$REPO_ROOT/scripts/docker/zalo-personal/shared-state-smoke.mjs" --before
}

verify_shared_state() {
  node "$REPO_ROOT/scripts/docker/zalo-personal/shared-state-smoke.mjs" --after
}

rollback_completed_scopes() {
  local chatbotx_deployed="$1" zalo_deployed="$2" chatbotx_services="$3"
  local rollback_failed=false

  if [[ "$zalo_deployed" == "true" ]]; then
    printf '%s\n' 'Rolling back Zalo because the combined release did not complete.' >&2
    "$ZALO_DEPLOY" rollback || rollback_failed=true
  fi
  if [[ "$chatbotx_deployed" == "true" ]]; then
    printf '%s\n' 'Rolling back ChatbotX because the combined release did not complete.' >&2
    CHATBOTX_AUTOMATIC_ROLLBACK=1 \
      CHATBOTX_DEPLOY_SERVICES="$chatbotx_services" \
      "$CHATBOTX_DEPLOY" rollback || rollback_failed=true
  fi
  [[ "$rollback_failed" == "false" ]]
}

split_services() {
  local raw="$1" service
  CHATBOTX_SERVICES=()
  DEPLOY_ZALO=false
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    case "$service" in
      builder | worker | realtime | javascript-executor)
        CHATBOTX_SERVICES+=("$service")
        ;;
      zalo-personal) DEPLOY_ZALO=true ;;
      *) fail "Unknown production service: $service" ;;
    esac
  done < <(printf '%s\n' "$raw" | tr ',' '\n')
}

checkout_release_under_lock() {
  local release_sha="$1"
  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Invalid release SHA."
  git -C "$REPO_ROOT" fetch --quiet origin dev
  local remote_sha
  remote_sha="$(git -C "$REPO_ROOT" rev-parse origin/dev)"
  if [[ "$remote_sha" != "$release_sha" ]]; then
    printf 'Skipping stale release %s; origin/dev is now %s\n' "$release_sha" "$remote_sha"
    exit 75
  fi
  git -C "$REPO_ROOT" checkout dev
  git -C "$REPO_ROOT" merge --ff-only "$release_sha"
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$release_sha" ]] ||
    fail "Checked-out release does not match the requested SHA."
}

pull_deploy_scopes() {
  local release_sha="$1" image_prefix="$2" services="$3" joined=""
  local chatbotx_deployed=false zalo_deployed=false
  split_services "$services"
  export CHATBOTX_IMAGE_PREFIX="$image_prefix"
  export CHATBOTX_IMAGE_TAG="sha-$release_sha"
  export CHATBOTX_EXPECTED_GIT_SHA="$release_sha"

  preflight_scopes "$services"
  ensure_backup_schedules "$services"
  if [[ "$DEPLOY_ZALO" == "true" ]]; then
    record_shared_state
  fi

  if (( ${#CHATBOTX_SERVICES[@]} > 0 )); then
    joined="$(IFS=,; printf '%s' "${CHATBOTX_SERVICES[*]}")"
    if ! CHATBOTX_DEPLOY_SERVICES="$joined" "$CHATBOTX_DEPLOY" pull-deploy; then
      fail "ChatbotX activation failed; no later scope was activated."
    fi
    chatbotx_deployed=true
  fi
  if [[ "$DEPLOY_ZALO" == "true" ]]; then
    if ! "$ZALO_DEPLOY" pull-deploy; then
      rollback_completed_scopes "$chatbotx_deployed" false "$joined" ||
        fail "Zalo activation failed and the earlier ChatbotX scope could not be fully restored."
      fail "Zalo activation failed; earlier ChatbotX services were restored."
    fi
    zalo_deployed=true
    if ! verify_shared_state; then
      rollback_completed_scopes "$chatbotx_deployed" "$zalo_deployed" "$joined" ||
        fail "Post-activation verification failed and automatic rollback was incomplete."
      fail "Post-activation verification failed; every activated scope was restored."
    fi
  fi
}

main() {
  local command="${1:-status}" release_sha image_prefix
  shift || true
  case "$command" in
    checkout-pull-deploy)
      [[ $# -eq 3 ]] || fail "checkout-pull-deploy requires SHA, image prefix, and service list."
      acquire_lock
      checkout_release_under_lock "$1"
      validate_full_config
      pull_deploy_scopes "$1" "$2" "$3"
      ;;
    pull-deploy)
      [[ $# -eq 3 ]] || fail "pull-deploy requires SHA, image prefix, and service list."
      acquire_lock
      validate_full_config
      pull_deploy_scopes "$1" "$2" "$3"
      ;;
    deploy)
      acquire_lock
      validate_full_config
      [[ $# -eq 0 ]] || fail "deploy reads CHATBOTX_EXPECTED_GIT_SHA and CHATBOTX_IMAGE_PREFIX from the environment."
      release_sha="${CHATBOTX_EXPECTED_GIT_SHA:?CHATBOTX_EXPECTED_GIT_SHA is required}"
      image_prefix="${CHATBOTX_IMAGE_PREFIX:?CHATBOTX_IMAGE_PREFIX is required}"
      [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$release_sha" ]] ||
        fail "Current checkout does not match CHATBOTX_EXPECTED_GIT_SHA."
      pull_deploy_scopes "$release_sha" "$image_prefix" \
        "builder,worker,realtime,javascript-executor,zalo-personal"
      ;;
    check)
      acquire_lock
      validate_full_config
      "$CHATBOTX_DEPLOY" check
      "$ZALO_DEPLOY" check
      ;;
    status)
      "$CHATBOTX_DEPLOY" status
      "$ZALO_DEPLOY" status
      ;;
    *)
      echo "Usage: $0 {checkout-pull-deploy SHA PREFIX SERVICES|pull-deploy SHA PREFIX SERVICES|deploy [--refresh]|check|status}" >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
