#!/bin/sh
set -eu

: "${RUSTFS_ADMIN_ACCESS_KEY:?RUSTFS_ADMIN_ACCESS_KEY is required}"
: "${RUSTFS_ADMIN_SECRET_KEY:?RUSTFS_ADMIN_SECRET_KEY is required}"
: "${ZALO_S3_ACCESS_KEY_ID:?ZALO_S3_ACCESS_KEY_ID is required}"
: "${ZALO_S3_SECRET_ACCESS_KEY:?ZALO_S3_SECRET_ACCESS_KEY is required}"
: "${ZALO_S3_BUCKET:?ZALO_S3_BUCKET is required}"

policy_name="zalo-personal-bucket"
policy_file="/tmp/zalo-personal-policy.json"

assert_scoped_identity() {
  user_info="$(rc admin user info --json rustfs "$ZALO_S3_ACCESS_KEY_ID")"
  compact_info="$(printf '%s' "$user_info" | tr -d '[:space:]')"
  case "$compact_info" in
    *'"policies":[]'*'"memberOf":[]'* | \
    *'"policies":["zalo-personal-bucket"]'*'"memberOf":[]'*) ;;
    *)
      echo "Existing RustFS identity has unexpected policy or group grants." >&2
      exit 1
      ;;
  esac
}

printf '%s' "$ZALO_S3_BUCKET" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' || {
  echo "Invalid ZALO_S3_BUCKET identifier." >&2
  exit 1
}
printf '%s' "$ZALO_S3_ACCESS_KEY_ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$' || {
  echo "Invalid ZALO_S3_ACCESS_KEY_ID identifier." >&2
  exit 1
}

rc alias set rustfs http://filesystem:9000 "$RUSTFS_ADMIN_ACCESS_KEY" "$RUSTFS_ADMIN_SECRET_KEY"

# Validate an existing user's credential before mutating bucket or policy.
if rc admin user info rustfs "$ZALO_S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  rc alias set zalo http://filesystem:9000 "$ZALO_S3_ACCESS_KEY_ID" "$ZALO_S3_SECRET_ACCESS_KEY" || {
    echo "Existing RustFS user credential has drifted." >&2
    exit 1
  }
  assert_scoped_identity
fi

rc mb "rustfs/$ZALO_S3_BUCKET" --ignore-existing
# The strict bucket-name validation above makes this replacement JSON-safe.
sed "s/__ZALO_BUCKET__/$ZALO_S3_BUCKET/g" /config/rustfs-policy.json > "$policy_file"
# `policy create` is an upsert in rc; run it every time to reconcile drift.
rc admin policy create rustfs "$policy_name" "$policy_file"
if ! rc admin user info rustfs "$ZALO_S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  rc admin user add rustfs "$ZALO_S3_ACCESS_KEY_ID" "$ZALO_S3_SECRET_ACCESS_KEY"
fi
rc admin policy attach rustfs "$policy_name" --user "$ZALO_S3_ACCESS_KEY_ID"
assert_scoped_identity
rc anonymous set download "rustfs/$ZALO_S3_BUCKET"

rc alias set zalo http://filesystem:9000 "$ZALO_S3_ACCESS_KEY_ID" "$ZALO_S3_SECRET_ACCESS_KEY"
rc ls "zalo/$ZALO_S3_BUCKET" >/dev/null
echo "Zalo Personal RustFS bucket and scoped user are ready."
