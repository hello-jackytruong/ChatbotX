#!/usr/bin/env bash

set -Eeuo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  printf 'SKIP: selective deployment tests require Bash 4 or newer.\n'
  exit 0
fi

TEST_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_SCRIPT_DIR
TEST_STATE_DIR="$(mktemp -d)"
readonly TEST_STATE_DIR
export CHATBOTX_STATE_DIR="$TEST_STATE_DIR"
trap 'rm -rf -- "$TEST_STATE_DIR"' EXIT

# shellcheck disable=SC1091
source "$TEST_SCRIPT_DIR/production.sh"

declare -a DOCKER_CALLS=()
FAIL_DOCKER_SERVICE=''

docker() {
  local argument
  DOCKER_CALLS+=("$*")
  for argument in "$@"; do
    if [[ -n "$FAIL_DOCKER_SERVICE" && "$argument" == "$FAIL_DOCKER_SERVICE" ]]; then
      return 1
    fi
  done
  return 0
}

running_tag() {
  case "$1" in
    builder) printf '%s' 'builder-old' ;;
    worker) printf '%s' 'worker-old' ;;
    realtime) printf '%s' 'realtime-old' ;;
    javascript-executor) printf '%s' 'executor-old' ;;
  esac
}

assert_equal() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' \
      "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" message="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nmissing: %s\nin:      %s\n' \
      "$message" "$needle" "$haystack" >&2
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" message="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'FAIL: %s\nunexpected: %s\nin:         %s\n' \
      "$message" "$needle" "$haystack" >&2
    exit 1
  fi
}

CHATBOTX_DEPLOY_SERVICES='worker, builder,worker'
resolve_deploy_services
assert_equal '2' "${#RESOLVED_DEPLOY_SERVICES[@]}" 'Service selection removes duplicates'
assert_equal 'worker' "${RESOLVED_DEPLOY_SERVICES[0]}" 'Service selection preserves requested order'
assert_equal 'builder' "${RESOLVED_DEPLOY_SERVICES[1]}" 'Service selection trims whitespace'
if (export CHATBOTX_DEPLOY_SERVICES='builder,not-a-service'; resolve_deploy_services); then
  printf 'FAIL: invalid service selection must fail atomically\n' >&2
  exit 1
fi
unset CHATBOTX_DEPLOY_SERVICES

configure_compose_tags_from_current
assert_equal 'builder-old' "$CHATBOTX_BUILDER_IMAGE_TAG" 'Builder keeps its running tag'
assert_equal 'worker-old' "$CHATBOTX_WORKER_IMAGE_TAG" 'Worker keeps its running tag'
assert_equal 'realtime-old' "$CHATBOTX_REALTIME_IMAGE_TAG" 'Realtime keeps its running tag'
assert_equal \
  'executor-old' \
  "$CHATBOTX_JAVASCRIPT_EXECUTOR_IMAGE_TAG" \
  'JavaScript Executor keeps its running tag'

set_service_tag builder 'builder-new'
start_selected_apps builder
calls="$(printf '%s\n' "${DOCKER_CALLS[@]}")"
assert_contains "$calls" '--no-deps' 'Selective activation never starts dependencies'
assert_contains "$calls" 'builder' 'Selected Builder is activated'
assert_not_contains "$calls" 'worker' 'Untouched Worker is not activated'
assert_not_contains "$calls" 'realtime' 'Untouched Realtime is not activated'

DOCKER_CALLS=()
# Read indirectly through the production function's nameref.
# shellcheck disable=SC2034
declare -A rollback_tags=([builder]='builder-old')
rollback_services_to_map rollback_tags builder
assert_equal 'builder-old' "$CHATBOTX_BUILDER_IMAGE_TAG" 'Rollback restores Builder tag'
calls="$(printf '%s\n' "${DOCKER_CALLS[@]}")"
assert_contains "$calls" 'builder' 'Rollback activates the selected service'
assert_not_contains "$calls" 'worker' 'Rollback leaves untouched services alone'

state_set previous-tag-builder 'builder-previous'
rollback_release builder
assert_equal \
  '1' \
  "$(state_get force-full-next-deploy)" \
  'Manual rollback requires the next activation to be a full deployment'
state_unset force-full-next-deploy

state_set previous-tag-builder 'builder-baseline'
state_set deployed-git-sha "$(printf 'b%.0s' {1..40})"
state_set previous-deployed-git-sha "$(printf 'a%.0s' {1..40})"
CHATBOTX_AUTOMATIC_ROLLBACK=1 rollback_release builder
assert_equal \
  "$(printf 'a%.0s' {1..40})" \
  "$(state_get deployed-git-sha)" \
  'Combined-release rollback restores the last successful deployment SHA'
assert_equal \
  '' \
  "$(state_get force-full-next-deploy)" \
  'Combined-release rollback keeps the successful baseline aligned'
unset CHATBOTX_AUTOMATIC_ROLLBACK

DOCKER_CALLS=()
FAIL_DOCKER_SERVICE='builder'
set_service_tag builder 'builder-new'
if start_selected_apps builder worker; then
  printf 'FAIL: one failed health check must fail the entire activation\n' >&2
  exit 1
fi
calls="$(printf '%s\n' "${DOCKER_CALLS[@]}")"
assert_contains "$calls" 'builder' 'Failed service activation was attempted'
assert_not_contains "$calls" 'worker' 'Activation stops after the first failed service'

state_set force-full-next-deploy 1
if (require_full_deploy_after_manual_rollback builder); then
  printf 'FAIL: selective deployment must stop after a manual rollback\n' >&2
  exit 1
fi
require_full_deploy_after_manual_rollback "${APP_SERVICES[@]}"
state_unset force-full-next-deploy

# A superseded release must not be reported as a successful deployment. A
# later workflow uses successful production deployments as its cumulative
# comparison base.
check_tools() { :; }
check_project() { :; }
acquire_lock() { :; }
pull_release() { :; }
release_matches_expected_git_sha() { return 1; }
CHATBOTX_IMAGE_TAG="sha-$(printf 'a%.0s' {1..40})"
export CHATBOTX_IMAGE_TAG
if main pull-deploy; then
  printf 'FAIL: a stale pull-deploy must return a non-zero status\n' >&2
  exit 1
else
  stale_status=$?
fi
assert_equal '75' "$stale_status" 'Stale deployments use the temporary-failure exit code'

production_source="$(<"$TEST_SCRIPT_DIR/production.sh")"
activation_source="$(sed -n '/^activate_built_release()/,/^rollback_release()/p' "$TEST_SCRIPT_DIR/production.sh")"
assert_contains \
  "$activation_source" \
  'guard_migration_compatibility' \
  'Migration compatibility is checked before automatic migration'
assert_contains \
  "$activation_source" \
  'clean_old_releases' \
  'Successful activation automatically removes obsolete local image tags'
assert_contains \
  "$activation_source" \
  'assert_datastores_unchanged' \
  'Application deployment verifies shared datastore container identity'
assert_contains \
  "$production_source" \
  '--no-recreate' \
  'Application deployment must not recreate shared datastores'
assert_not_contains \
  "$production_source" \
  'docker compose down' \
  'Production automation never tears down the stack'
# The literal shell source is the contract under test.
# shellcheck disable=SC2016
assert_not_contains \
  "$production_source" \
  'Backup verified: $backup_file' \
  'Production logs must not disclose database backup paths'
# shellcheck disable=SC2016
assert_not_contains \
  "$production_source" \
  'file limit: $backup_file' \
  'Production retention logs must not disclose deleted backup paths'
# shellcheck disable=SC2016
assert_not_contains \
  "$production_source" \
  'days: $backup_file' \
  'Production retention logs must not disclose expired backup paths'

printf 'Selective production deployment tests passed.\n'
