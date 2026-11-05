#!/bin/sh
set -eu

# Standalone output has no pnpm workspace; use /migrate-runner and /seed-runner (see Dockerfile).
# --enable-source-maps resolves production stack traces back to original TypeScript source.
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-node-snapshot --enable-source-maps"

run_migrate() {
  echo "Running database migrations..."
  node /app/migrate-runner/scripts/run-migrations.mjs
  echo "Running message shard migrations..."
  CHATBOTX_SHARD_MIGRATIONS_DIR=/app/migrate-runner/sharding-migrations \
    node /app/migrate-runner/migrate-shards.mjs
}

run_seed() {
  echo "Running database seed..."
  SKIP_ENV_CHECK="${SKIP_ENV_CHECK:-true}" node /app/seed-runner/seed.cjs
}

start_server() {
  # Backward-compatible env gating (no command passed): migrate/seed, then serve.
  if [ "${RUN_DB_MIGRATE:-}" = "true" ]; then run_migrate; fi
  if [ "${RUN_DB_SEED:-}" = "true" ]; then run_seed; fi
  HOSTNAME="${BUILDER_HOST:-0.0.0.0}" PORT="${PORT:-3000}" \
    exec node apps/builder/server.js
}

case "${1:-}" in
  migrate)       run_migrate ;;            # one-shot, exits
  seed)          run_seed ;;               # one-shot, exits
  migrate-seed)  run_migrate; run_seed ;;  # one-shot, exits
  serve|"")      start_server ;;           # default: env-gated + server
  *)             exec "$@" ;;              # escape hatch (e.g. sh/debug)
esac
