# Zalo Personal Docker runbook

Zalo Personal and ChatbotX use the same physical PostgreSQL 18, Redis 8 and
RustFS containers. Their state remains logically separated:

| Resource | ChatbotX | Zalo Personal |
|---|---|---|
| PostgreSQL | database/role `chatbotx` | database/role `zalo_personal` |
| Redis | DB 0 | DB 1 |
| RustFS | bucket `chatbotx` | bucket `zalocrm-attachments`, scoped IAM user |

Redis databases are collision namespaces, not security or recovery boundaries.
Pub/Sub is instance-wide and a privileged client can select another DB. A live
Redis snapshot is therefore restored only as coordinated recovery for both
applications, never as a Zalo-only rollback.

## Development

Install dependencies once:

```bash
pnpm install --frozen-lockfile
pnpm zalo-personal:install
```

First setup, or after a committed migration, requires an explicit prepare:

```bash
pnpm docker:dev prepare zalo   # bootstrap DB/bucket, then Prisma migrate
pnpm docker:dev:zalo           # steady-state container start
```

To run both products:

```bash
pnpm docker:dev:prepare        # explicit schema/data preparation
pnpm docker:dev:full           # steady-state one-command start
```

For source-mode Zalo development, `pnpm zalo-personal:dev:migrate` bootstraps
the shared database and applies only Zalo Prisma migrations; then run
`pnpm zalo-personal:dev`. Host mode uses PostgreSQL `localhost:5432` and Redis
`localhost:6379/1`. Container mode uses `postgres:5432` and `redis:6379/1`.

Stopping Zalo does not stop PostgreSQL, Redis or RustFS:

```bash
pnpm zalo-personal:dev:down
pnpm docker:dev stop zalo
```

Never use `down --volumes`. Legacy `zalo-postgres-data`, `zalo-redis-data` and
`zalo-file-storage` volumes are retained until their inventory and retention
window are approved for cleanup.

## Existing Zalo data

The operator must choose `fresh` or `migrate`; absence of a running container
does not prove the installation is empty. Before selecting:

1. inventory every Docker project and volume, external database, proxy/DNS
   route, Zalo row/migration count, Redis keys, and attachment URL prefix;
2. for an existing PG16 database, quiesce writes and create `pg_dump -Fc`;
3. restore it into a disposable PG18 database and run the full Zalo suite;
4. import into `zalo_personal` only after row/count/checksum verification;
5. keep old volumes read-only through the agreed retention window.

## Production prerequisites

Populate `.env` with independent Zalo secrets. `ZALO_DATABASE_URL` must point
to `postgres:5432/zalo_personal` and percent-encode reserved password
characters; `ZALO_REDIS_URL` must be `redis://redis:6379/1`. Set
`ZALO_DEPLOYMENT_MODE=fresh` or `migrate` only after the inventory above.

The Zalo role is non-superuser, cannot create databases/roles, and has a
connection limit. Ordinary deploys verify an existing role and password but do
not rotate it. Credential rotation is a separate operator procedure.

Set `ZALO_BACKUP_OFFSITE_DIR` to an independently encrypted mount. Production
deploy refuses a local-only backup unless an operator explicitly sets
`ZALO_ALLOW_LOCAL_BACKUP_ONLY=1`. Backup files and manifests use modes
`0700/0600`; never upload dumps or PostgreSQL globals as CI artifacts.

When `ZALO_MEDIA_AV_ENABLED=0`, ClamAV is not a startup dependency. When set to
`1`, one existing shared ClamAV must be healthy and fail-closed mode is the
default.

## Safe production rollout

Configure the production reverse proxy to route the app and Socket.IO to
loopback port `3080`. If attachments are public, expose only the
`zalocrm-attachments/<object-key>` RustFS path through loopback port `9000` and
deny bucket-root listing and non-read HTTP methods. Merge the fail-closed Zalo
variables from the root `.env.example` into the server's existing
`/root/apps/ChatbotX/.env`; do not replace existing ChatbotX settings or commit
the populated file.

Configuration validation is read-only:

```bash
pnpm zalo-personal:prod:config
pnpm test:docker:zalo-personal
```

Before the first rollout, capture identity/capacity and Redis sentinels:

```bash
node scripts/docker/zalo-personal/shared-state-smoke.mjs --before
```

After the one-time inventory and unattended-production checklist is complete,
set `PRODUCTION_AUTOMATION_READY=1`. Every later merge to `dev` automatically
pulls, backs up, migrates, activates, probes, rolls back on failure, and cleans
obsolete images. A manual equivalent is:

```bash
export CHATBOTX_IMAGE_TAG="sha-<approved-40-character-git-sha>"
export CHATBOTX_EXPECTED_GIT_SHA="<approved-40-character-git-sha>"
export CHATBOTX_IMAGE_PREFIX="ghcr.io/<registry-owner>"
pnpm docker:prod:zalo
node scripts/docker/zalo-personal/shared-state-smoke.mjs --after
pnpm docker:prod:status
```

The deploy order is fixed: preflight → snapshot shared identities → database
and RustFS bootstrap → verified custom-format backup + globals → byte-level
backup of both RustFS buckets → Prisma migration → `up --no-deps
zalo-personal` → PostgreSQL/Redis/RustFS readiness → identity recheck. It never
starts, restarts or recreates PostgreSQL, Redis, RustFS or a ChatbotX
application.
If activation or dependency readiness fails, the script restores the recorded
previous immutable Zalo image automatically; on a first-ever deployment it
stops the failed Zalo container. Database migrations are never reversed.

CI activates every affected ChatbotX/Zalo service in one operation through the
existing `production` environment. Only after that operation succeeds does
it record separate successful baselines in `production-chatbotx` and
`production-zalo`. A failed mixed release therefore advances neither baseline.
The host deployment lock is acquired before `git fetch`, checkout and
activation.

All selected scopes are preflighted before either scope mutates production. A
missing Zalo env value or backup mount therefore stops a mixed deployment
before ChatbotX backup, migration, or activation begins.
If Zalo or the final shared-state smoke fails after ChatbotX has activated, the
dispatcher restores both scopes to their previous application images and keeps
their successful GitHub baselines unchanged. SQL migrations remain applied and
must therefore pass the expand/contract compatibility guard.

### CI log privacy

GitHub Actions receives only the deployment outcome and exit code. Detailed
checkout, backup, Docker and readiness output stays on the production host in a
mode `0600` log under `/var/log/chatbotx-production/`; the containing directory
is mode `0700`, and deployment logs older than 30 days are removed automatically.
The workflow deliberately does not publish `docker compose ps`, backup paths,
container identities, image inventory or host disk information after a failure.
An operator with production access can inspect the restricted host log when a
deployment needs diagnosis.

## Backup, rollback and recovery

```bash
scripts/docker/zalo-personal/production.sh backup
scripts/docker/zalo-personal/production.sh install-backup-cron
scripts/docker/zalo-personal/production.sh rollback
pnpm zalo-personal:prod:status
pnpm zalo-personal:prod:logs
```

`backup` is complete: it stores the Zalo custom-format dump, PostgreSQL
globals and byte copies of both RustFS buckets. The data/object target and the
administrator-only globals target must be different, pre-existing encrypted
mounts with mode `0700`, each containing a
`.chatbotx-encrypted-backup-target` attestation marker. Set the matching
`*_VERIFIED=1` values only after an operator verifies those mounts. The cron
command installs this same locked backup daily at 03:17.

Image rollback never reverses SQL. Migration SQL must stay compatible with the
previous image; destructive changes require stopped traffic and a verified
database restore. Drill both database dumps plus PostgreSQL globals on an
isolated PG18 target. Drill Redis AOF/RDB only on an isolated Redis 8 target as
whole-instance recovery. A RustFS inventory/checksum is not a backup: copy the
actual object bytes for both buckets to an independent encrypted target and
verify a restore.

Logical separation is not host privilege isolation. Redis DB0/DB1 share one
unauthenticated Redis trust boundary, ChatbotX still uses its PostgreSQL
cluster-administrator role, and the production Docker/SSH principal can affect
all containers. Use a dedicated constrained deploy principal or forced SSH
command if CI credential isolation is required. The Zalo RustFS bucket remains
anonymous-download to preserve its current public attachment contract; its IAM
identity is scoped for authenticated list/write operations.

For the first cutover, retain old volumes and watch PostgreSQL connections/locks,
Redis memory/clients/latency/evictions, BullMQ stalls, Zalo API/socket errors
and both buckets for 24 hours. Cleanup is a later, separately approved action.

## Regression gates

```bash
pnpm zalo-personal:source:check
pnpm zalo-personal:contracts:check
pnpm zalo-personal:test:full
pnpm test:docker:zalo-personal
node --test scripts/deployment/detect-affected-services.test.mjs
bash scripts/deployment/production-selective.test.sh
```

These tests and config validation do not apply database migrations.
