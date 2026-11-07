#!/usr/bin/env bash

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
suffix="$$-$RANDOM"
network="chatbotx-zalo-test-$suffix"
postgres="chatbotx-zalo-postgres-$suffix"
redis="chatbotx-zalo-redis-$suffix"
redis_restore="chatbotx-zalo-redis-restore-$suffix"
restore="chatbotx-zalo-restore-$suffix"
filesystem="chatbotx-zalo-filesystem-$suffix"
filesystem_restore="chatbotx-zalo-filesystem-restore-$suffix"
image="timescale/timescaledb-ha:pg18-all"
rustfs_image="rustfs/rustfs:latest"
rc_image="rustfs/rc:v0.1.22"
artifacts="$(mktemp -d)"

cleanup() {
  docker rm -f "$postgres" "$redis" "$redis_restore" "$restore" \
    "$filesystem" "$filesystem_restore" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$artifacts"
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run -d --rm --name "$postgres" --network "$network" \
  -e POSTGRES_DB=chatbotx \
  -e POSTGRES_USER=chatbotx \
  -e POSTGRES_PASSWORD=chatbotx-test-password \
  "$image" >/dev/null
docker run -d --rm --name "$redis" --network "$network" redis:8-alpine \
  redis-server --appendonly yes --appendfsync everysec \
  --maxmemory-policy noeviction >/dev/null
docker run -d --rm --name "$filesystem" --network "$network" \
  --network-alias filesystem \
  -e RUSTFS_ACCESS_KEY=integration-admin \
  -e RUSTFS_SECRET_KEY=integration-admin-secret \
  "$rustfs_image" server /data >/dev/null

for _ in {1..60}; do
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U chatbotx -d chatbotx >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$postgres" pg_isready -h 127.0.0.1 -U chatbotx -d chatbotx >/dev/null

for _ in {1..60}; do
  if docker run --rm --network "$network" "$rc_image" alias set check \
    http://filesystem:9000 integration-admin integration-admin-secret \
    >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

rustfs_bootstrap() {
  docker run --rm --network "$network" \
    -e RUSTFS_ADMIN_ACCESS_KEY=integration-admin \
    -e RUSTFS_ADMIN_SECRET_KEY=integration-admin-secret \
    -e ZALO_S3_ACCESS_KEY_ID=zalo-integration \
    -e ZALO_S3_SECRET_ACCESS_KEY=zalo-integration-secret \
    -e ZALO_S3_BUCKET=zalo-integration-bucket \
    -v "$REPO_ROOT/scripts/docker/zalo-personal/init-rustfs.sh:/init-rustfs.sh:ro" \
    -v "$REPO_ROOT/scripts/docker/zalo-personal/rustfs-policy.json:/config/rustfs-policy.json:ro" \
    --entrypoint /bin/sh "$rc_image" /init-rustfs.sh
}

rustfs_bootstrap >/dev/null
rustfs_bootstrap >/dev/null

docker exec "$postgres" psql -U chatbotx -d chatbotx \
  -c "CREATE TABLE bootstrap_sentinel(value text); INSERT INTO bootstrap_sentinel VALUES ('unchanged');" \
  >/dev/null

bootstrap() {
  local password="$1"
  docker run --rm --network "$network" \
    -e POSTGRES_HOST="$postgres" \
    -e POSTGRES_DB=chatbotx \
    -e POSTGRES_USER=chatbotx \
    -e PGPASSWORD=chatbotx-test-password \
    -e ZALO_DB_NAME=zalo_personal \
    -e ZALO_DB_USER=zalo_personal \
    -e ZALO_DB_PASSWORD="$password" \
    -e ZALO_DB_CONNECTION_LIMIT=7 \
    -v "$REPO_ROOT/scripts/docker/zalo-personal/init-database.sh:/init-database.sh:ro" \
    --entrypoint /bin/sh "$image" /init-database.sh
}

bootstrap 'zalo:@/?#%-test-password'
bootstrap 'zalo:@/?#%-test-password'
if bootstrap 'wrong-password' >/dev/null 2>&1; then
  echo "FAIL: existing-role credential drift must fail without rotating the password" >&2
  exit 1
fi
bootstrap 'zalo:@/?#%-test-password' >/dev/null

docker exec -e PGPASSWORD='zalo:@/?#%-test-password' "$postgres" \
  psql -U zalo_personal -d zalo_personal \
  -c "CREATE TABLE restore_sentinel(value text); INSERT INTO restore_sentinel VALUES ('zalo-unchanged');" \
  >/dev/null

role_contract="$(docker exec "$postgres" psql -At -U chatbotx -d chatbotx -c \
  "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit = 7 AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) FROM pg_roles WHERE rolname = 'zalo_personal'")"
[[ "$role_contract" == "t" ]] || {
  echo "FAIL: Zalo PostgreSQL role contract drifted" >&2
  exit 1
}
sentinel="$(docker exec "$postgres" psql -At -U chatbotx -d chatbotx -c \
  "SELECT value FROM bootstrap_sentinel")"
[[ "$sentinel" == "unchanged" ]] || {
  echo "FAIL: ChatbotX sentinel changed during Zalo bootstrap" >&2
  exit 1
}
if docker exec -e PGPASSWORD='zalo:@/?#%-test-password' "$postgres" \
  psql -U zalo_personal -d chatbotx -c 'SELECT value FROM bootstrap_sentinel' \
  >/dev/null 2>&1; then
  echo "FAIL: Zalo role can read a ChatbotX table" >&2
  exit 1
fi

# Ordinary bootstrap must reject inherited privileges instead of accepting an
# apparently non-superuser role whose membership grants cross-database access.
docker exec "$postgres" psql -U chatbotx -d chatbotx \
  -c 'GRANT pg_read_all_data TO zalo_personal' >/dev/null
if bootstrap 'zalo:@/?#%-test-password' >/dev/null 2>&1; then
  echo "FAIL: inherited PostgreSQL privileges must fail closed" >&2
  exit 1
fi
docker exec "$postgres" psql -U chatbotx -d chatbotx \
  -c 'REVOKE pg_read_all_data FROM zalo_personal' >/dev/null
bootstrap 'zalo:@/?#%-test-password' >/dev/null

# Verify custom-format dumps, globals and an isolated PostgreSQL 18 restore.
docker exec "$postgres" pg_dump -Fc -U chatbotx -d chatbotx \
  >"$artifacts/chatbotx.dump"
docker exec "$postgres" pg_dump -Fc -U chatbotx -d zalo_personal \
  >"$artifacts/zalo-personal.dump"
docker exec "$postgres" pg_dumpall --globals-only -U chatbotx \
  >"$artifacts/globals.sql"
docker exec -i "$postgres" pg_restore --list <"$artifacts/chatbotx.dump" >/dev/null
docker exec -i "$postgres" pg_restore --list <"$artifacts/zalo-personal.dump" >/dev/null

docker run -d --rm --name "$restore" --network "$network" \
  -e POSTGRES_DB=postgres \
  -e POSTGRES_USER=restore_admin \
  -e POSTGRES_PASSWORD=restore-test-password \
  "$image" >/dev/null
for _ in {1..60}; do
  if docker exec "$restore" pg_isready -h 127.0.0.1 -U restore_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec -i "$restore" psql -v ON_ERROR_STOP=1 -U restore_admin -d postgres \
  <"$artifacts/globals.sql" >/dev/null
docker exec "$restore" createdb -U restore_admin -O chatbotx chatbotx
docker exec "$restore" createdb -U restore_admin -O zalo_personal zalo_personal
docker exec -i "$restore" pg_restore -U restore_admin -d chatbotx \
  <"$artifacts/chatbotx.dump" >/dev/null
docker exec -i "$restore" pg_restore -U restore_admin -d zalo_personal \
  <"$artifacts/zalo-personal.dump" >/dev/null
[[ "$(docker exec "$restore" psql -At -U restore_admin -d chatbotx -c 'SELECT value FROM bootstrap_sentinel')" == "unchanged" ]]
[[ "$(docker exec "$restore" psql -At -U restore_admin -d zalo_personal -c 'SELECT value FROM restore_sentinel')" == "zalo-unchanged" ]]

docker exec "$redis" redis-cli -n 0 SET chatbotx:sentinel db0 >/dev/null
docker exec "$redis" redis-cli -n 1 SET zalo:sentinel db1 >/dev/null
[[ "$(docker exec "$redis" redis-cli -n 0 GET chatbotx:sentinel)" == "db0" ]]
[[ "$(docker exec "$redis" redis-cli -n 1 GET zalo:sentinel)" == "db1" ]]
[[ -z "$(docker exec "$redis" redis-cli -n 0 GET zalo:sentinel)" ]]
[[ -z "$(docker exec "$redis" redis-cli -n 1 GET chatbotx:sentinel)" ]]

# Redis DB 1 cannot be restored independently. Drill the whole snapshot only
# in an isolated Redis 8 container and verify both logical databases together.
docker exec "$redis" redis-cli SAVE >/dev/null
docker cp "$redis:/data/dump.rdb" "$artifacts/redis-dump.rdb" >/dev/null
chmod 644 "$artifacts/redis-dump.rdb"
docker run -d --rm --name "$redis_restore" --network "$network" \
  -v "$artifacts/redis-dump.rdb:/data/dump.rdb:ro" \
  redis:8-alpine redis-server --save '' >/dev/null
for _ in {1..30}; do
  if docker exec "$redis_restore" redis-cli ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
[[ "$(docker exec "$redis_restore" redis-cli -n 0 GET chatbotx:sentinel)" == "db0" ]]
[[ "$(docker exec "$redis_restore" redis-cli -n 1 GET zalo:sentinel)" == "db1" ]]

# Back up and restore actual RustFS bytes for both buckets on an isolated
# target, then prove the scoped Zalo identity cannot read the ChatbotX bucket.
mkdir -p "$artifacts/object-source" "$artifacts/object-backup" "$artifacts/object-restored"
printf 'chatbotx-object\n' >"$artifacts/object-source/chatbotx.txt"
printf 'zalo-object\n' >"$artifacts/object-source/zalo.txt"
docker run --rm --network "$network" \
  -v "$artifacts/object-source:/source:ro" --entrypoint /bin/sh "$rc_image" -ec '
    rc alias set rustfs http://filesystem:9000 integration-admin integration-admin-secret
    rc mb rustfs/chatbotx --ignore-existing
    rc cp /source/chatbotx.txt rustfs/chatbotx/chatbotx.txt
    rc alias set zalo http://filesystem:9000 zalo-integration zalo-integration-secret
    rc cp /source/zalo.txt zalo/zalo-integration-bucket/zalo.txt
    if rc ls zalo/chatbotx >/dev/null 2>&1; then
      echo "Zalo RustFS identity can access the ChatbotX bucket" >&2
      exit 1
    fi
  ' >/dev/null
docker run --rm --network "$network" \
  -v "$artifacts/object-backup:/backup" --entrypoint /bin/sh "$rc_image" -ec '
    rc alias set rustfs http://filesystem:9000 integration-admin integration-admin-secret
    rc cp --recursive --overwrite rustfs/chatbotx/ /backup/chatbotx/
    rc cp --recursive --overwrite rustfs/zalo-integration-bucket/ /backup/zalo-personal/
  ' >/dev/null

docker run -d --rm --name "$filesystem_restore" --network "$network" \
  --network-alias filesystem-restore \
  -e RUSTFS_ACCESS_KEY=restore-admin \
  -e RUSTFS_SECRET_KEY=restore-admin-secret \
  "$rustfs_image" server /data >/dev/null
for _ in {1..60}; do
  if docker run --rm --network "$network" "$rc_image" alias set check \
    http://filesystem-restore:9000 restore-admin restore-admin-secret \
    >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker run --rm --network "$network" \
  -v "$artifacts/object-backup:/backup:ro" --entrypoint /bin/sh "$rc_image" -ec '
    rc alias set restore http://filesystem-restore:9000 restore-admin restore-admin-secret
    rc mb restore/chatbotx --ignore-existing
    rc mb restore/zalo-integration-bucket --ignore-existing
    rc cp --recursive --overwrite /backup/chatbotx/ restore/chatbotx/
    rc cp --recursive --overwrite /backup/zalo-personal/ restore/zalo-integration-bucket/
  ' >/dev/null
docker run --rm --network "$network" \
  -v "$artifacts/object-restored:/restored" --entrypoint /bin/sh "$rc_image" -ec '
    rc alias set restore http://filesystem-restore:9000 restore-admin restore-admin-secret
    rc cp --recursive --overwrite restore/chatbotx/ /restored/chatbotx/
    rc cp --recursive --overwrite restore/zalo-integration-bucket/ /restored/zalo-personal/
  ' >/dev/null
diff -r "$artifacts/object-backup" "$artifacts/object-restored" >/dev/null

docker run --rm --network "$network" --entrypoint /bin/sh "$rc_image" -ec '
  rc alias set rustfs http://filesystem:9000 integration-admin integration-admin-secret
  rc admin policy attach rustfs readwrite --user zalo-integration
' >/dev/null
if rustfs_bootstrap >/dev/null 2>&1; then
  echo "FAIL: RustFS bootstrap accepted an identity with stale broad policy" >&2
  exit 1
fi

printf 'Shared PostgreSQL, Redis and RustFS backup/isolation integration tests passed.\n'
