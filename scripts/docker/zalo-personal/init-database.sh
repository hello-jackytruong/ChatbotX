#!/bin/sh
set -eu

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${ZALO_DB_NAME:?ZALO_DB_NAME is required}"
: "${ZALO_DB_USER:?ZALO_DB_USER is required}"
: "${ZALO_DB_PASSWORD:?ZALO_DB_PASSWORD is required}"
: "${ZALO_DB_CONNECTION_LIMIT:=30}"

case "$ZALO_DB_NAME" in
  ''|*[!a-zA-Z0-9_]*)
    echo "Zalo database and role names may contain only letters, digits, and underscore." >&2
    exit 1
    ;;
esac
case "$ZALO_DB_USER" in
  ''|*[!a-zA-Z0-9_]*)
    echo "Zalo database and role names may contain only letters, digits, and underscore." >&2
    exit 1
    ;;
esac
case "$ZALO_DB_CONNECTION_LIMIT" in
  ''|*[!0-9]*)
    echo "ZALO_DB_CONNECTION_LIMIT must be a positive integer." >&2
    exit 1
    ;;
esac
[ "$ZALO_DB_CONNECTION_LIMIT" -gt 0 ] || {
  echo "ZALO_DB_CONNECTION_LIMIT must be greater than zero." >&2
  exit 1
}

psql_admin() {
  psql -X --set=ON_ERROR_STOP=1 --host "$POSTGRES_HOST" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
}

# Existing roles are never password-rotated by an ordinary prepare/deploy.
psql_admin \
  --set=zalo_db="$ZALO_DB_NAME" \
  --set=zalo_user="$ZALO_DB_USER" \
  --set=zalo_password="$ZALO_DB_PASSWORD" \
  --set=connection_limit="$ZALO_DB_CONNECTION_LIMIT" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
  :'zalo_user', :'zalo_password', :'connection_limit'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'zalo_user')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'zalo_db', :'zalo_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'zalo_db')
\gexec
SQL

role_contract="$(psql_admin --tuples-only --no-align \
  --set=zalo_user="$ZALO_DB_USER" \
  --set=connection_limit="$ZALO_DB_CONNECTION_LIMIT" <<'SQL'
SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
  AND NOT rolreplication AND NOT rolbypassrls
  AND rolconnlimit = :'connection_limit'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE member = pg_roles.oid
  )
FROM pg_roles
WHERE rolname = :'zalo_user';
SQL
)"
[ "$role_contract" = "t" ] || {
  echo "Existing Zalo role does not match the least-privilege contract." >&2
  exit 1
}

database_owner="$(psql_admin --tuples-only --no-align \
  --set=zalo_db="$ZALO_DB_NAME" <<'SQL'
SELECT pg_get_userbyid(datdba)
FROM pg_database
WHERE datname = :'zalo_db';
SQL
)"
[ "$database_owner" = "$ZALO_DB_USER" ] || {
  echo "Existing Zalo database owner does not match ZALO_DB_USER." >&2
  exit 1
}

# Authenticate with the supplied password to detect credential drift without
# ever changing the existing role's secret.
PGPASSWORD="$ZALO_DB_PASSWORD" psql -X --set=ON_ERROR_STOP=1 \
  --host "$POSTGRES_HOST" --username "$ZALO_DB_USER" --dbname "$ZALO_DB_NAME" \
  --command='SELECT 1' >/dev/null

echo "Zalo PostgreSQL database and least-privilege role are ready."
