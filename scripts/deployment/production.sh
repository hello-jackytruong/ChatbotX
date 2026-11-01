#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly REPO_ROOT
readonly COMPOSE_FILE="$REPO_ROOT/docker-compose.production.yml"
readonly BUILDER_NAME="${CHATBOTX_BUILDER_NAME:-chatbotx-production-limited}"
readonly BUILD_MEMORY="${CHATBOTX_BUILD_MEMORY:-4608m}"
readonly BUILD_CPU_QUOTA="${CHATBOTX_BUILD_CPU_QUOTA:-300000}"
readonly MIN_AVAILABLE_DISK_GB="${MIN_AVAILABLE_DISK_GB:-25}"
readonly MIN_SWAP_MB="${MIN_SWAP_MB:-4096}"
readonly KEEP_RELEASES="${KEEP_RELEASES:-3}"
readonly LOCK_FILE="${CHATBOTX_DEPLOY_LOCK:-/var/lock/chatbotx-production.lock}"
readonly STATE_DIR="${CHATBOTX_STATE_DIR:-/var/lib/chatbotx-production}"
readonly BACKUP_DIR="${CHATBOTX_BACKUP_DIR:-/var/backups/chatbotx-production}"
readonly MAX_BACKUP_DAYS="${MAX_BACKUP_DAYS:-15}"
readonly MAX_BACKUP_FILES="${MAX_BACKUP_FILES:-30}"
readonly BACKUP_LOCK_WAIT_SECONDS="${BACKUP_LOCK_WAIT_SECONDS:-1800}"
readonly BACKUP_CRON_SCHEDULE="${BACKUP_CRON_SCHEDULE:-0 2,14 * * *}"
readonly BACKUP_CRON_TIMEZONE="${BACKUP_CRON_TIMEZONE:-Asia/Ho_Chi_Minh}"
readonly BACKUP_CRON_FILE="${BACKUP_CRON_FILE:-/etc/cron.d/chatbotx-production-backup}"
readonly BACKUP_LOG_FILE="${BACKUP_LOG_FILE:-/var/log/chatbotx-production-backup.log}"
readonly BACKUP_LOGROTATE_FILE="${BACKUP_LOGROTATE_FILE:-/etc/logrotate.d/chatbotx-production-backup}"

COMPOSE=(
  docker compose
  --project-directory "$REPO_ROOT"
  -f "$COMPOSE_FILE"
)

APP_SERVICES=(builder worker javascript-executor realtime)

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./scripts/deployment/production.sh <command> [options]

Commands:
  check               Validate Docker, Compose, host capacity and configuration
  build [--refresh]   Build all application images sequentially; keep cache
  up                  Activate the latest successfully built image tag
  deploy [--refresh]  Build, backup, migrate and activate in one safe command
  rollback            Restore the previous application image tag
  backup              Create and verify a database backup immediately
  install-cron        Install automatic backups at 02:00 and 14:00 daily
  cron-status         Show backup cron status and retained backup count
  remove-cron         Remove only the ChatbotX database backup cron job
  status              Show containers, disk use and Docker disk usage
  logs [service...]   Follow production logs (all services by default)
  clean               Prune old build cache, dangling images and old releases

Normal deployment:
  ./scripts/deployment/production.sh deploy

Refresh base images before building:
  ./scripts/deployment/production.sh deploy --refresh
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

check_tools() {
  local command
  for command in awk chmod chown cut df docker du find flock git grep install mktemp sed sort tr wc; do
    require_command "$command"
  done

  docker buildx version >/dev/null 2>&1 || fail "Docker Buildx is required."
  docker compose build --help | grep -- '--builder' >/dev/null || fail "Docker Compose is too old: build --builder is required."
  docker compose up --help | grep -- '--wait' >/dev/null || fail "Docker Compose is too old: up --wait is required."
  docker compose wait --help >/dev/null 2>&1 || fail "Docker Compose is too old: compose wait is required."
}

check_project() {
  [[ -f "$COMPOSE_FILE" ]] || fail "Missing $COMPOSE_FILE"
  [[ -f "$REPO_ROOT/.env" ]] || fail "Missing $REPO_ROOT/.env"
  "${COMPOSE[@]}" config --quiet
}

read_meminfo_mb() {
  local key="$1"
  awk -v key="$key" '$1 == key ":" { printf "%d", $2 / 1024 }' /proc/meminfo
}

check_build_capacity() {
  [[ "$(uname -s)" == "Linux" ]] || fail "Build commands must run on the Ubuntu server."

  local memory_mb swap_mb available_disk_gb
  memory_mb="$(read_meminfo_mb MemTotal)"
  swap_mb="$(read_meminfo_mb SwapTotal)"
  available_disk_gb="$(df -Pk "$REPO_ROOT" | awk 'NR == 2 { printf "%d", $4 / 1024 / 1024 }')"

  (( memory_mb >= 7000 )) || fail "At least 8 GB RAM is required; detected ${memory_mb} MB."
  if (( swap_mb < MIN_SWAP_MB )) && [[ "${ALLOW_LOW_SWAP:-0}" != "1" ]]; then
    fail "At least ${MIN_SWAP_MB} MB swap is required; detected ${swap_mb} MB. Create 4 GB swap first or explicitly set ALLOW_LOW_SWAP=1."
  fi
  (( available_disk_gb >= MIN_AVAILABLE_DISK_GB )) || fail "At least ${MIN_AVAILABLE_DISK_GB} GB free disk is required; detected ${available_disk_gb} GB. Run the clean command or expand the disk."

  log "Capacity OK: ${memory_mb} MB RAM, ${swap_mb} MB swap, ${available_disk_gb} GB free disk."
}

acquire_lock() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another production operation is already running."
}

acquire_backup_lock() {
  exec 9>"$LOCK_FILE"
  flock -w "$BACKUP_LOCK_WAIT_SECONDS" 9 || fail "Timed out waiting for the active deployment to finish."
}

ensure_limited_builder() {
  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    log "Creating BuildKit builder limited to $BUILD_MEMORY RAM and 3 CPU cores."
    docker buildx create \
      --name "$BUILDER_NAME" \
      --driver docker-container \
      --driver-opt "memory=$BUILD_MEMORY" \
      --driver-opt "cpu-quota=$BUILD_CPU_QUOTA" \
      --driver-opt cpu-period=100000 \
      >/dev/null
  fi
  docker buildx inspect --bootstrap "$BUILDER_NAME" >/dev/null
}

state_get() {
  local name="$1"
  [[ -f "$STATE_DIR/$name" ]] || return 0
  tr -d '\r\n' <"$STATE_DIR/$name"
}

state_set() {
  local name="$1" value="$2" temporary
  install -d -m 700 "$STATE_DIR"
  temporary="$(mktemp "$STATE_DIR/.${name}.XXXXXX")"
  printf '%s\n' "$value" >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$STATE_DIR/$name"
}

running_tag() {
  local container_id image
  container_id="$("${COMPOSE[@]}" ps -q builder 2>/dev/null || true)"
  [[ -n "$container_id" ]] || return 0
  image="$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || true)"
  [[ "$image" == chatbotx-builder:* ]] || return 0
  printf '%s' "${image#chatbotx-builder:}"
}

new_release_tag() {
  printf '%s-%s' "$(git rev-parse --short=12 HEAD)" "$(date '+%Y%m%d%H%M%S')"
}

build_release() {
  local refresh="$1" service deploy_tag
  local -a build_options=(--builder "$BUILDER_NAME")
  [[ "$refresh" == "true" ]] && build_options+=(--pull)

  deploy_tag="${CHATBOTX_IMAGE_TAG:-$(new_release_tag)}"
  export CHATBOTX_IMAGE_TAG="$deploy_tag"

  for service in "${APP_SERVICES[@]}"; do
    log "Building $service sequentially with tag $deploy_tag"
    COMPOSE_PARALLEL_LIMIT=1 \
      "${COMPOSE[@]}" build "${build_options[@]}" "$service"
  done

  state_set built-tag "$deploy_tag"
  log "Build completed. Activate it with: $0 up"
}

start_datastores() {
  log "Starting PostgreSQL, Redis and local RustFS."
  "${COMPOSE[@]}" up \
    -d --no-build --wait --wait-timeout 180 \
    postgres redis filesystem
  "${COMPOSE[@]}" up -d --no-build --force-recreate filesystem-init
  "${COMPOSE[@]}" wait filesystem-init
}

prune_database_backups() {
  local backup_file cutoff_minutes
  local -a backup_files=()
  cutoff_minutes="$((MAX_BACKUP_DAYS * 24 * 60))"

  while IFS= read -r backup_file; do
    [[ -n "$backup_file" ]] || continue
    log "Removing database backup older than ${MAX_BACKUP_DAYS} days: $backup_file"
    rm -f -- "$backup_file"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'postgres-*.dump' -mmin "+$cutoff_minutes" -print)

  mapfile -t backup_files < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'postgres-*.dump' \
      -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-
  )
  if (( ${#backup_files[@]} > MAX_BACKUP_FILES )); then
    for backup_file in "${backup_files[@]:MAX_BACKUP_FILES}"; do
      log "Removing database backup above the ${MAX_BACKUP_FILES}-file limit: $backup_file"
      rm -f -- "$backup_file"
    done
  fi

  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tmp' -mmin +1440 -delete
}

backup_database() {
  local backup_file temporary retained_count
  install -d -m 700 "$BACKUP_DIR"
  backup_file="$BACKUP_DIR/postgres-$(date '+%Y%m%d-%H%M%S').dump"
  temporary="${backup_file}.tmp"

  log "Creating PostgreSQL backup before migration."
  # Variables expand inside the PostgreSQL container.
  # shellcheck disable=SC2016
  if ! "${COMPOSE[@]}" exec -T postgres \
    sh -ec 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
    >"$temporary"; then
    rm -f -- "$temporary"
    fail "Database backup failed; activation stopped before migration."
  fi

  if [[ ! -s "$temporary" ]] || ! "${COMPOSE[@]}" exec -T postgres \
    pg_restore --list <"$temporary" >/dev/null; then
    rm -f -- "$temporary"
    fail "Database backup validation failed; invalid file was removed."
  fi

  chmod 600 "$temporary"
  mv -- "$temporary" "$backup_file"
  prune_database_backups
  retained_count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'postgres-*.dump' | wc -l | tr -d ' ')"
  log "Backup verified: $backup_file (${retained_count}/${MAX_BACKUP_FILES} files retained)."
}

install_backup_cron() {
  local temporary
  (( EUID == 0 )) || fail "install-cron must run as root."
  [[ "$REPO_ROOT" != *' '* ]] || fail "Cron installation does not support spaces in the repository path."
  require_command systemctl

  temporary="$(mktemp)"
  {
    printf 'SHELL=/bin/bash\n'
    printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
    printf 'MAILTO=""\n'
    printf 'CRON_TZ=%s\n' "$BACKUP_CRON_TIMEZONE"
    printf '%s root %s backup >> %s 2>&1\n' \
      "$BACKUP_CRON_SCHEDULE" "$REPO_ROOT/scripts/deployment/production.sh" "$BACKUP_LOG_FILE"
  } >"$temporary"
  install -o root -g root -m 644 "$temporary" "$BACKUP_CRON_FILE"
  rm -f -- "$temporary"

  temporary="$(mktemp)"
  {
    printf '%s {\n' "$BACKUP_LOG_FILE"
    printf '    weekly\n'
    printf '    rotate 8\n'
    printf '    compress\n'
    printf '    delaycompress\n'
    printf '    missingok\n'
    printf '    notifempty\n'
    printf '    copytruncate\n'
    printf '}\n'
  } >"$temporary"
  install -o root -g root -m 644 "$temporary" "$BACKUP_LOGROTATE_FILE"
  rm -f -- "$temporary"

  if [[ ! -e "$BACKUP_LOG_FILE" ]]; then
    install -o root -g root -m 640 /dev/null "$BACKUP_LOG_FILE"
  else
    chown root:root "$BACKUP_LOG_FILE"
    chmod 640 "$BACKUP_LOG_FILE"
  fi
  systemctl enable --now cron >/dev/null
  systemctl reload cron 2>/dev/null || systemctl restart cron
  log "Backup cron installed: 02:00 and 14:00 daily ($BACKUP_CRON_TIMEZONE)."
  log "Retention: maximum ${MAX_BACKUP_DAYS} days and ${MAX_BACKUP_FILES} files."
}

show_cron_status() {
  if [[ -f "$BACKUP_CRON_FILE" ]]; then
    printf '%s\n' 'Backup cron: installed'
    sed -n '1,20p' "$BACKUP_CRON_FILE"
  else
    printf '%s\n' 'Backup cron: not installed'
  fi
  if command -v systemctl >/dev/null 2>&1; then
    printf 'Cron service: %s\n' "$(systemctl is-active cron 2>/dev/null || true)"
  fi
  if [[ -d "$BACKUP_DIR" ]]; then
    printf 'Retained backups: %s/%s\n' \
      "$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'postgres-*.dump' | wc -l | tr -d ' ')" \
      "$MAX_BACKUP_FILES"
    du -sh "$BACKUP_DIR"
  else
    printf 'Retained backups: 0/%s\n' "$MAX_BACKUP_FILES"
  fi
}

remove_backup_cron() {
  (( EUID == 0 )) || fail "remove-cron must run as root."
  rm -f -- "$BACKUP_CRON_FILE" "$BACKUP_LOGROTATE_FILE"
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active cron >/dev/null 2>&1; then
    systemctl reload cron 2>/dev/null || systemctl restart cron
  fi
  log "ChatbotX backup cron removed. Existing backup files were kept."
}

run_migrations() {
  log "Running migrations before application cutover."
  "${COMPOSE[@]}" run --rm --no-deps builder migrate
}

start_apps() {
  "${COMPOSE[@]}" up \
    -d --no-build --remove-orphans --wait --wait-timeout 300
}

rollback_to() {
  local target_tag="$1"
  [[ -n "$target_tag" ]] || return 1
  log "Restoring application image tag $target_tag"
  CHATBOTX_IMAGE_TAG="$target_tag" \
    "${COMPOSE[@]}" up \
    -d --no-build --wait --wait-timeout 300 \
    "${APP_SERVICES[@]}"
}

activate_built_release() {
  local deploy_tag previous_tag
  deploy_tag="$(state_get built-tag)"
  [[ -n "$deploy_tag" ]] || fail "No completed build found. Run '$0 build' first."
  previous_tag="$(running_tag)"
  [[ -n "$previous_tag" ]] || previous_tag="$(state_get current-tag)"
  export CHATBOTX_IMAGE_TAG="$deploy_tag"

  start_datastores
  backup_database
  run_migrations

  log "Activating application image tag $deploy_tag"
  if ! start_apps; then
    log "New release failed health checks."
    rollback_to "$previous_tag" || true
    fail "Activation failed; previous application images were restored when available."
  fi

  [[ -n "$previous_tag" ]] && state_set previous-tag "$previous_tag"
  state_set current-tag "$deploy_tag"
  log "Production is healthy on image tag $deploy_tag"
  "${COMPOSE[@]}" ps
}

rollback_release() {
  local current_tag previous_tag
  current_tag="$(running_tag)"
  [[ -n "$current_tag" ]] || current_tag="$(state_get current-tag)"
  previous_tag="$(state_get previous-tag)"
  [[ -n "$previous_tag" ]] || fail "No previous release tag is recorded."

  rollback_to "$previous_tag" || fail "Rollback failed."
  state_set current-tag "$previous_tag"
  [[ -n "$current_tag" ]] && state_set previous-tag "$current_tag"
  log "Rollback completed: $previous_tag"
}

clean_old_releases() {
  local current_tag previous_tag built_tag tag repository kept=0
  local -a repositories=(
    chatbotx-builder
    chatbotx-worker
    chatbotx-javascript-executor
    chatbotx-realtime
  )
  declare -A protected=()

  current_tag="$(running_tag)"
  [[ -n "$current_tag" ]] || current_tag="$(state_get current-tag)"
  previous_tag="$(state_get previous-tag)"
  built_tag="$(state_get built-tag)"
  for tag in "$current_tag" "$previous_tag" "$built_tag" local; do
    [[ -n "$tag" ]] && protected["$tag"]=1
  done

  while IFS= read -r tag; do
    [[ -n "$tag" && "$tag" != "<none>" ]] || continue
    if [[ -n "${protected[$tag]:-}" ]] || (( kept < KEEP_RELEASES )); then
      ((kept += 1))
      continue
    fi
    log "Removing old application image tag: $tag"
    for repository in "${repositories[@]}"; do
      docker image rm "$repository:$tag" >/dev/null 2>&1 || true
    done
  done < <(docker image ls chatbotx-builder --format '{{.Tag}}')
}

clean_cache() {
  log "Pruning BuildKit cache older than 7 days while retaining up to 12 GB."
  if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    if docker buildx prune --help | grep -- '--max-used-space' >/dev/null; then
      docker buildx prune \
        --builder "$BUILDER_NAME" --force \
        --filter until=168h \
        --max-used-space 12gb \
        --reserved-space 5gb
    else
      docker buildx prune \
        --builder "$BUILDER_NAME" --force \
        --filter until=168h
    fi
  fi

  clean_old_releases
  docker image prune --force --filter until=168h
  log "Cleanup completed. Volumes and active container images were not removed."
  docker system df
}

show_status() {
  "${COMPOSE[@]}" ps
  df -h "$REPO_ROOT"
  docker system df
}

main() {
  local command="${1:-help}" refresh=false
  shift || true

  if [[ "$command" == "help" || "$command" == "-h" || "$command" == "--help" ]]; then
    usage
    return 0
  fi

  check_tools
  check_project

  case "$command" in
    check)
      check_build_capacity
      ensure_limited_builder
      log "Production preflight passed."
      ;;
    build)
      [[ "${1:-}" == "--refresh" ]] && refresh=true
      acquire_lock
      check_build_capacity
      ensure_limited_builder
      build_release "$refresh"
      ;;
    up)
      acquire_lock
      activate_built_release
      ;;
    deploy)
      [[ "${1:-}" == "--refresh" ]] && refresh=true
      acquire_lock
      check_build_capacity
      ensure_limited_builder
      build_release "$refresh"
      activate_built_release
      ;;
    rollback)
      acquire_lock
      rollback_release
      ;;
    backup)
      acquire_backup_lock
      backup_database
      ;;
    install-cron)
      install_backup_cron
      ;;
    cron-status)
      show_cron_status
      ;;
    remove-cron)
      remove_backup_cron
      ;;
    clean)
      acquire_lock
      clean_cache
      ;;
    status)
      show_status
      ;;
    logs)
      "${COMPOSE[@]}" logs --follow --tail="${TAIL:-200}" "$@"
      ;;
    *)
      usage >&2
      fail "Unknown command: $command"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
