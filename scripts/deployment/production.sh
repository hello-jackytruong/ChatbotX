#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly REPO_ROOT
readonly COMPOSE_FILE="$REPO_ROOT/docker-compose.production.yml"
IMAGE_PREFIX="${CHATBOTX_IMAGE_PREFIX:-ghcr.io/hello-jackytruong}"
readonly IMAGE_PREFIX
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

# Compose resolves image variables before it executes a command. Keep one tag
# per application so a selective deployment never changes an untouched
# service's desired image. CHATBOTX_IMAGE_TAG remains the release tag supplied
# by CI (and the backwards-compatible default for a full manual deployment).
export CHATBOTX_BUILDER_IMAGE_TAG="${CHATBOTX_BUILDER_IMAGE_TAG:-${CHATBOTX_IMAGE_TAG:-local}}"
export CHATBOTX_WORKER_IMAGE_TAG="${CHATBOTX_WORKER_IMAGE_TAG:-${CHATBOTX_IMAGE_TAG:-local}}"
export CHATBOTX_JAVASCRIPT_EXECUTOR_IMAGE_TAG="${CHATBOTX_JAVASCRIPT_EXECUTOR_IMAGE_TAG:-${CHATBOTX_IMAGE_TAG:-local}}"
export CHATBOTX_REALTIME_IMAGE_TAG="${CHATBOTX_REALTIME_IMAGE_TAG:-${CHATBOTX_IMAGE_TAG:-local}}"

COMPOSE=(
  docker compose
  --project-directory "$REPO_ROOT"
  -f "$COMPOSE_FILE"
)

# Dependency-safe activation order: public API first, its isolated executor,
# realtime after Builder is healthy, and Worker last.
APP_SERVICES=(builder javascript-executor realtime worker)
RESOLVED_DEPLOY_SERVICES=()

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
  build [--refresh]   Build selected application images sequentially; keep cache
  pull                 Pull selected release images without activating them
  up                  Activate the latest successfully built image tag
  deploy [--refresh]  Build, backup, migrate and activate in one safe command
  pull-deploy          Pull, backup, migrate and activate selected services
  rollback            Restore previous images of the last/selected services
  backup              Create and verify a database backup immediately
  install-cron        Install automatic backups at 02:00 and 14:00 daily
  cron-status         Show backup cron status and retained backup count
  remove-cron         Remove only the ChatbotX database backup cron job
  status              Show containers, disk use and Docker disk usage
  logs [service...]   Follow production logs (all services by default)
  clean               Prune old build cache, dangling images and old releases

Normal deployment:
  ./scripts/deployment/production.sh deploy

Deploy an image already built by GitHub Actions:
  CHATBOTX_IMAGE_TAG=sha-<git-sha> ./scripts/deployment/production.sh pull-deploy

Deploy only selected services (validated comma-separated names):
  CHATBOTX_DEPLOY_SERVICES=builder,realtime \
    CHATBOTX_IMAGE_TAG=sha-<git-sha> ./scripts/deployment/production.sh pull-deploy

Refresh base images before building:
  ./scripts/deployment/production.sh deploy --refresh
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

check_tools() {
  local command
  (( BASH_VERSINFO[0] >= 4 )) || fail "Bash 4 or newer is required."
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

state_unset() {
  rm -f -- "$STATE_DIR/$1"
}

is_app_service() {
  case "$1" in
    builder | worker | realtime | javascript-executor) return 0 ;;
    *) return 1 ;;
  esac
}

service_tag_variable() {
  case "$1" in
    builder) printf '%s' 'CHATBOTX_BUILDER_IMAGE_TAG' ;;
    worker) printf '%s' 'CHATBOTX_WORKER_IMAGE_TAG' ;;
    realtime) printf '%s' 'CHATBOTX_REALTIME_IMAGE_TAG' ;;
    javascript-executor) printf '%s' 'CHATBOTX_JAVASCRIPT_EXECUTOR_IMAGE_TAG' ;;
    *) fail "Unknown application service: $1" ;;
  esac
}

set_service_tag() {
  local service="$1" tag="$2" variable
  variable="$(service_tag_variable "$service")"
  printf -v "$variable" '%s' "$tag"
  export "${variable?}"
}

running_tag() {
  local service="${1:-builder}" container_id image repository
  repository="$(service_image_repository "$service")"
  container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
  [[ -n "$container_id" ]] || return 0
  image="$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || true)"
  [[ "$image" == "$repository:"* ]] || return 0
  printf '%s' "${image#"$repository:"}"
}

current_tag_for_service() {
  local service="$1" tag
  tag="$(running_tag "$service")"
  [[ -n "$tag" ]] || tag="$(state_get "current-tag-$service")"
  # Migration path from the original single-release state files.
  [[ -n "$tag" ]] || tag="$(state_get current-tag)"
  printf '%s' "$tag"
}

previous_tag_for_service() {
  local service="$1" tag
  tag="$(state_get "previous-tag-$service")"
  [[ -n "$tag" ]] || tag="$(state_get previous-tag)"
  printf '%s' "$tag"
}

built_tag_for_service() {
  local service="$1" tag
  tag="$(state_get "built-tag-$service")"
  [[ -n "$tag" ]] || tag="$(state_get built-tag)"
  printf '%s' "$tag"
}

resolve_deploy_services() {
  local raw="${CHATBOTX_DEPLOY_SERVICES:-}" service seen=','
  local -a requested=()
  RESOLVED_DEPLOY_SERVICES=()
  if [[ -z "$raw" ]]; then
    RESOLVED_DEPLOY_SERVICES=("${APP_SERVICES[@]}")
    return 0
  fi

  while IFS= read -r service; do
    service="$(printf '%s' "$service" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -n "$service" ]] || continue
    is_app_service "$service" || fail "Invalid CHATBOTX_DEPLOY_SERVICES entry: $service"
    if [[ "$seen" != *",$service,"* ]]; then
      requested+=("$service")
      seen+="$service,"
    fi
  done < <(printf '%s\n' "$raw" | tr ',' '\n')
  RESOLVED_DEPLOY_SERVICES=("${requested[@]}")
}

join_services() {
  local joined="" service
  for service in "$@"; do
    [[ -n "$joined" ]] && joined+=','
    joined+="$service"
  done
  printf '%s' "$joined"
}

deployment_scope_is_full() {
  local service
  (( $# == ${#APP_SERVICES[@]} )) || return 1
  for service in "${APP_SERVICES[@]}"; do
    service_is_selected "$service" "$@" || return 1
  done
}

require_full_deploy_after_manual_rollback() {
  [[ "$(state_get force-full-next-deploy)" != "1" ]] && return 0
  deployment_scope_is_full "$@" || fail \
    "A manual rollback changed the production baseline. Run one full deployment before using selective deployment again."
}

configure_compose_tags_from_current() {
  local service tag
  for service in "${APP_SERVICES[@]}"; do
    tag="$(current_tag_for_service "$service")"
    set_service_tag "$service" "${tag:-local}"
  done
}

ensure_untouched_services_are_running() {
  local selected="," service
  for service in "$@"; do
    selected+="$service,"
  done
  for service in "${APP_SERVICES[@]}"; do
    if [[ "$selected" != *",$service,"* ]] && [[ -z "$(running_tag "$service")" ]]; then
      fail "Cannot selectively deploy while $service is not running. Run a full deployment first."
    fi
  done
}

new_release_tag() {
  printf '%s-%s' "$(git rev-parse --short=12 HEAD)" "$(date '+%Y%m%d%H%M%S')"
}

build_release() {
  local refresh="$1" service deploy_tag
  local -a build_options=(--builder "$BUILDER_NAME")
  shift
  local -a services=("$@")
  [[ "$refresh" == "true" ]] && build_options+=(--pull)

  deploy_tag="${CHATBOTX_IMAGE_TAG:-$(new_release_tag)}"
  export CHATBOTX_IMAGE_TAG="$deploy_tag"
  configure_compose_tags_from_current

  for service in "${services[@]}"; do
    set_service_tag "$service" "$deploy_tag"
    log "Building $service sequentially with tag $deploy_tag"
    COMPOSE_PARALLEL_LIMIT=1 \
      "${COMPOSE[@]}" build "${build_options[@]}" "$service"
  done

  record_built_release "$deploy_tag" "${services[@]}"
  log "Build completed for $(join_services "${services[@]}"). Activate it with: $0 up"
}

service_image_repository() {
  case "$1" in
    builder) printf '%s' 'chatbotx-builder' ;;
    worker) printf '%s' 'chatbotx-worker' ;;
    realtime) printf '%s' 'chatbotx-realtime' ;;
    javascript-executor) printf '%s' 'chatbotx-javascript-executor' ;;
    *) fail "Unknown application service: $1" ;;
  esac
}

pull_release() {
  local deploy_tag service repository remote_image local_image downloaded_image index
  local expected_revision actual_revision
  local -a services=("$@")
  local -a remote_images=()
  local -a local_images=()

  deploy_tag="${CHATBOTX_IMAGE_TAG:-}"
  [[ -n "$deploy_tag" ]] || fail "CHATBOTX_IMAGE_TAG is required for pull and pull-deploy."
  [[ "$deploy_tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || fail "Invalid image tag: $deploy_tag"
  [[ "$IMAGE_PREFIX" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || fail "Invalid CHATBOTX_IMAGE_PREFIX: $IMAGE_PREFIX"

  for service in "${services[@]}"; do
    repository="$(service_image_repository "$service")"
    remote_image="${IMAGE_PREFIX%/}/$repository:$deploy_tag"
    local_image="$repository:$deploy_tag"
    log "Pulling $remote_image"
    if ! docker pull "$remote_image"; then
      for downloaded_image in "${remote_images[@]}"; do
        docker image rm "$downloaded_image" >/dev/null 2>&1 || true
      done
      fail "Could not pull $remote_image. For private GHCR packages, run 'docker login ghcr.io' on this server first."
    fi
    remote_images+=("$remote_image")
    if [[ "$deploy_tag" =~ ^sha-([0-9a-f]{40})$ ]]; then
      expected_revision="${BASH_REMATCH[1]}"
      if ! actual_revision="$(docker image inspect \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
        "$remote_image")"; then
        for downloaded_image in "${remote_images[@]}"; do
          docker image rm "$downloaded_image" >/dev/null 2>&1 || true
        done
        fail "Could not inspect the Git revision label for $remote_image"
      fi
      if [[ "$actual_revision" != "$expected_revision" ]]; then
        for downloaded_image in "${remote_images[@]}"; do
          docker image rm "$downloaded_image" >/dev/null 2>&1 || true
        done
        fail "Image revision mismatch for $remote_image: expected $expected_revision, received ${actual_revision:-<missing>}"
      fi
    fi
    local_images+=("$local_image")
  done

  for ((index = 0; index < ${#remote_images[@]}; index += 1)); do
    docker image tag "${remote_images[$index]}" "${local_images[$index]}"
  done
  for remote_image in "${remote_images[@]}"; do
    docker image rm "$remote_image" >/dev/null 2>&1 || true
  done

  log "Release $deploy_tag downloaded and verified for: $(join_services "${services[@]}")."
}

record_built_release() {
  local deploy_tag="$1" service
  shift
  local -a services=("$@")
  for service in "${services[@]}"; do
    state_set "built-tag-$service" "$deploy_tag"
  done
  state_set built-tag "$deploy_tag"
  state_set built-services "$(join_services "${services[@]}")"
}

release_matches_expected_git_sha() {
  local expected_sha="${CHATBOTX_EXPECTED_GIT_SHA:-}" remote_sha
  [[ -n "$expected_sha" ]] || return 0
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Invalid CHATBOTX_EXPECTED_GIT_SHA: $expected_sha"

  git fetch --quiet origin dev || fail "Could not refresh origin/dev before deployment."
  if ! remote_sha="$(git rev-parse origin/dev)"; then
    fail "Could not resolve origin/dev before deployment."
  fi
  if [[ "$remote_sha" != "$expected_sha" ]]; then
    log "Skipping stale release $expected_sha; origin/dev is now $remote_sha"
    return 1
  fi
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

service_is_selected() {
  local wanted="$1" service
  shift
  for service in "$@"; do
    [[ "$service" == "$wanted" ]] && return 0
  done
  return 1
}

start_selected_apps() {
  local service
  local -a selected=("$@")
  for service in "${APP_SERVICES[@]}"; do
    service_is_selected "$service" "${selected[@]}" || continue
    log "Activating $service with image tag $(current_compose_tag "$service")."
    # --no-deps is essential for a selective release: Compose must not
    # recreate an untouched dependency merely because another service changed.
    if ! "${COMPOSE[@]}" up \
      -d --no-build --no-deps --wait --wait-timeout 300 \
      "$service"; then
      log "Health-checked activation failed for $service."
      return 1
    fi
  done
}

current_compose_tag() {
  local variable
  variable="$(service_tag_variable "$1")"
  printf '%s' "${!variable}"
}

rollback_services_to_map() {
  local map_name="$1" service tag rollback_failed=false
  shift
  local -a services=("$@")
  local -a restorable=()
  # shellcheck disable=SC2178
  local -n rollback_tag_map="$map_name"

  for service in "${services[@]}"; do
    tag="${rollback_tag_map[$service]:-}"
    if [[ -z "$tag" ]]; then
      log "No previous image is available for $service; automatic rollback is incomplete."
      rollback_failed=true
      continue
    fi
    set_service_tag "$service" "$tag"
    restorable+=("$service")
  done

  if (( ${#restorable[@]} > 0 )); then
    log "Restoring previous images for: $(join_services "${restorable[@]}")."
    # Try every touched service even if one rollback health check fails. This
    # avoids needlessly leaving later services on the failed release.
    for service in "${APP_SERVICES[@]}"; do
      service_is_selected "$service" "${restorable[@]}" || continue
      start_selected_apps "$service" || rollback_failed=true
    done
  fi
  [[ "$rollback_failed" == "false" ]]
}

activate_built_release() {
  local service deploy_tag
  local -a services=("$@")
  declare -A previous_tags=()

  ensure_untouched_services_are_running "${services[@]}"
  configure_compose_tags_from_current
  for service in "${services[@]}"; do
    previous_tags["$service"]="$(current_tag_for_service "$service")"
    deploy_tag="$(built_tag_for_service "$service")"
    [[ -n "$deploy_tag" ]] || fail "No completed image exists for $service. Run '$0 build' or '$0 pull' first."
    set_service_tag "$service" "$deploy_tag"
  done

  start_datastores
  backup_database
  run_migrations

  log "Activating application services: $(join_services "${services[@]}")."
  if ! start_selected_apps "${services[@]}"; then
    log "New release failed health checks; starting service-scoped rollback."
    rollback_services_to_map previous_tags "${services[@]}" || true
    fail "Activation failed; previous images were restored when available. Database migrations were not reversed."
  fi

  for service in "${services[@]}"; do
    [[ -n "${previous_tags[$service]}" ]] && \
      state_set "previous-tag-$service" "${previous_tags[$service]}"
    state_set "current-tag-$service" "$(current_compose_tag "$service")"
  done
  state_set last-deployed-services "$(join_services "${services[@]}")"
  if deployment_scope_is_full "${services[@]}"; then
    [[ -n "${previous_tags[builder]}" ]] && state_set previous-tag "${previous_tags[builder]}"
    state_set current-tag "$(current_compose_tag builder)"
    state_unset force-full-next-deploy
  fi
  log "Production is healthy after activating: $(join_services "${services[@]}")."
  "${COMPOSE[@]}" ps
}

rollback_release() {
  local service current_tag previous_tag
  local -a services=("$@")
  declare -A current_tags=()
  declare -A previous_tags=()

  configure_compose_tags_from_current
  for service in "${services[@]}"; do
    current_tag="$(current_tag_for_service "$service")"
    previous_tag="$(previous_tag_for_service "$service")"
    [[ -n "$previous_tag" ]] || fail "No previous image tag is recorded for $service."
    current_tags["$service"]="$current_tag"
    previous_tags["$service"]="$previous_tag"
  done

  # Set this before touching containers. A partially failed manual rollback is
  # still a production-baseline change and must force reconciliation.
  state_set force-full-next-deploy 1
  rollback_services_to_map previous_tags "${services[@]}" || fail "Rollback failed."
  for service in "${services[@]}"; do
    state_set "current-tag-$service" "${previous_tags[$service]}"
    [[ -n "${current_tags[$service]}" ]] && \
      state_set "previous-tag-$service" "${current_tags[$service]}"
  done
  state_set last-deployed-services "$(join_services "${services[@]}")"
  log "Rollback completed for: $(join_services "${services[@]}")."
}

clean_old_releases() {
  local service repository current_tag previous_tag built_tag tag kept

  for service in "${APP_SERVICES[@]}"; do
    repository="$(service_image_repository "$service")"
    current_tag="$(current_tag_for_service "$service")"
    previous_tag="$(previous_tag_for_service "$service")"
    built_tag="$(built_tag_for_service "$service")"
    kept=0

    while IFS= read -r tag; do
      [[ -n "$tag" && "$tag" != "<none>" ]] || continue
      if [[ "$tag" == "$current_tag" || "$tag" == "$previous_tag" || \
        "$tag" == "$built_tag" || "$tag" == "local" || $kept -lt $KEEP_RELEASES ]]; then
        ((kept += 1))
        continue
      fi
      log "Removing old $service image tag: $tag"
      docker image rm "$repository:$tag" >/dev/null 2>&1 || true
    done < <(docker image ls "$repository" --format '{{.Tag}}')
  done
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
  local -a deploy_services=()
  shift || true

  if [[ "$command" == "help" || "$command" == "-h" || "$command" == "--help" ]]; then
    usage
    return 0
  fi

  check_tools
  check_project

  if [[ "$command" =~ ^(build|pull|up|deploy|pull-deploy|rollback)$ ]]; then
    if [[ -z "${CHATBOTX_DEPLOY_SERVICES:-}" && "$command" == "up" ]]; then
      CHATBOTX_DEPLOY_SERVICES="$(state_get built-services)"
      export CHATBOTX_DEPLOY_SERVICES
    elif [[ -z "${CHATBOTX_DEPLOY_SERVICES:-}" && "$command" == "rollback" ]]; then
      CHATBOTX_DEPLOY_SERVICES="$(state_get last-deployed-services)"
      export CHATBOTX_DEPLOY_SERVICES
    fi
    resolve_deploy_services
    deploy_services=("${RESOLVED_DEPLOY_SERVICES[@]}")
    (( ${#deploy_services[@]} > 0 )) || fail "No valid application service was selected."
    log "Selected application services: $(join_services "${deploy_services[@]}")."
  fi

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
      build_release "$refresh" "${deploy_services[@]}"
      ;;
    pull)
      acquire_lock
      pull_release "${deploy_services[@]}"
      record_built_release \
        "${CHATBOTX_IMAGE_TAG:?CHATBOTX_IMAGE_TAG is required}" \
        "${deploy_services[@]}"
      ;;
    up)
      acquire_lock
      require_full_deploy_after_manual_rollback "${deploy_services[@]}"
      activate_built_release "${deploy_services[@]}"
      ;;
    deploy)
      [[ "${1:-}" == "--refresh" ]] && refresh=true
      acquire_lock
      require_full_deploy_after_manual_rollback "${deploy_services[@]}"
      check_build_capacity
      ensure_limited_builder
      build_release "$refresh" "${deploy_services[@]}"
      activate_built_release "${deploy_services[@]}"
      ;;
    pull-deploy)
      acquire_lock
      require_full_deploy_after_manual_rollback "${deploy_services[@]}"
      pull_release "${deploy_services[@]}"
      if ! release_matches_expected_git_sha; then
        return 75
      fi
      record_built_release \
        "${CHATBOTX_IMAGE_TAG:?CHATBOTX_IMAGE_TAG is required}" \
        "${deploy_services[@]}"
      activate_built_release "${deploy_services[@]}"
      ;;
    rollback)
      acquire_lock
      rollback_release "${deploy_services[@]}"
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
