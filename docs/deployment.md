# Production deployment

This repository is deployed from `/root/apps/ChatbotX` on a single Ubuntu
server with 4 CPU cores, 8 GB RAM, Docker, and host Nginx.

## Host preparation

Keep at least 25 GB of disk space free. A swap file is required so a failed or
unusually large source build cannot trigger the host OOM killer. Create 4 GB of
swap when the server does not already have it:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Verify the host before the first deployment:

```bash
free -h
df -h /root/apps/ChatbotX
docker version
docker compose version
docker buildx version
```

## Deploy

Keep production secrets in `/root/apps/ChatbotX/.env`. The file must not be
committed and should have mode `600`.

Set `S3_ENDPOINT` to the browser-reachable HTTPS origin used for presigned
uploads. The production Compose stack passes this value through to Builder and
Worker; an internal Docker hostname such as `http://filesystem:9000` cannot be
used by browsers. When storage shares `APP_URL`, host Nginx must proxy the
bucket path to RustFS without rewriting the request path or `Host` header.

Run every first deployment and upgrade through the guarded script:

```bash
cd /root/apps/ChatbotX
./scripts/deployment/production.sh deploy
```

When Zalo Personal is configured on the same host, deploy both application groups through the merged configuration with:

```bash
pnpm docker:prod:full
```

Use `pnpm docker:prod:chatbotx` or `pnpm docker:prod:zalo` for a scoped deployment. Zalo requires `CHATBOTX_IMAGE_TAG=sha-<git-sha>`, the matching `CHATBOTX_EXPECTED_GIT_SHA`, and `CHATBOTX_IMAGE_PREFIX`; it pulls and verifies that immutable image instead of accepting a local tag. The full command validates both Compose files first, then preserves the backup and migration gates owned by each deployment script.

Zalo is an app-only production overlay over the existing PostgreSQL, Redis and
RustFS containers. A Zalo-only deploy snapshots their container IDs,
`StartedAt` values and restart counts, bootstraps logical namespaces through
one-shot containers, activates only `zalo-personal` with `--no-deps`, and then
verifies the shared identities again. It never calls the ChatbotX datastore,
backup or Drizzle migration path. CI records successful baselines separately
in `production-chatbotx` and `production-zalo`.

The first Zalo rollout additionally requires the inventory, encrypted backup,
restore drill, capacity gate and one-time automation readiness flag in
[`docs/zalo-personal/docker-runbook.md`](zalo-personal/docker-runbook.md). Do not
apply production migrations while merely validating this configuration.
Zalo's complete backup command includes its database, separately custodied
PostgreSQL globals, and bytes from both RustFS buckets; install its daily
schedule with `scripts/docker/zalo-personal/production.sh install-backup-cron`.

The script:

1. prevents concurrent deployments;
2. requires 8 GB RAM, at least 4 GB swap, and 25 GB free disk;
3. builds each application image sequentially in a BuildKit container limited
   to 4.5 GB RAM and 3 CPU cores;
4. keeps the current application running until all images have built;
5. creates a PostgreSQL backup under `/var/backups/chatbotx-production/`
   before migration;
6. runs migrations before replacing application containers;
7. waits for health checks and automatically restores the previous application
   image tag when the new containers fail to become healthy.

The deployment commands never run `docker compose down`, remove volumes, or
prune Docker globally. After a successful activation they retain the current,
rollback and recent release images, then remove only obsolete local release
tags owned by this project. Database backups remain governed by their explicit
retention policy.
The script provides explicit operational commands:

```bash
# Validate the server without building
./scripts/deployment/production.sh check

# Fast normal deployment; reuses BuildKit cache
./scripts/deployment/production.sh deploy

# Refresh base images, then deploy
./scripts/deployment/production.sh deploy --refresh

# Build now and activate later
./scripts/deployment/production.sh build
./scripts/deployment/production.sh up

# Inspect or follow logs
./scripts/deployment/production.sh status
./scripts/deployment/production.sh logs worker

# Roll back to the previously recorded application images
./scripts/deployment/production.sh rollback

# Create and verify a database backup immediately
./scripts/deployment/production.sh backup

# Install twice-daily backups at 02:00 and 14:00 Vietnam time
./scripts/deployment/production.sh install-cron
./scripts/deployment/production.sh cron-status

# Safely remove cache older than seven days and obsolete release tags
./scripts/deployment/production.sh clean
```

## Automatic deployment from GitHub Actions

The preferred production path uses Turborepo's dependency graph to build only
the application images affected by a push on GitHub's runners. It publishes
commit-addressed `sha-<commit>` tags to GHCR and makes the Ubuntu server pull
and activate only those services. The server does not compile the application
and continues to use the existing Compose file, `.env`, database, volumes,
backup policy, migration step, health checks, and rollback state.

Every non-documentation push to `dev` runs
`.github/workflows/deploy-production.yml`. The repository's existing reusable
CI workflow type-checks, lints, and tests in parallel with the affected image
builds; deployment starts only when both the quality gate and every requested
image build succeed. Configure these GitHub Actions secrets before enabling the
first run:

| Secret | Value |
| --- | --- |
| `PROD_HOST` | Production server IP or DNS name |
| `PROD_PORT` | SSH port, normally `22` |
| `PROD_USER` | `root` while the checkout remains under `/root/apps/ChatbotX` |
| `PROD_SSH_KEY` | Dedicated private SSH key used only by GitHub Actions |
| `PROD_SSH_KNOWN_HOSTS` | Verified `known_hosts` entry for the server |

Keep these secrets on the existing `production` GitHub environment. The
`production-chatbotx` and `production-zalo` environments are automatic baseline
markers only; they do not need SSH secrets. For fully unattended deployment,
do not configure required reviewers on these environments.

Generate a dedicated key on a trusted workstation and install only its public
half on the server:

```bash
ssh-keygen -t ed25519 -C chatbotx-github-actions -f ./chatbotx-github-actions -N ''
ssh-copy-id -i ./chatbotx-github-actions.pub root@SERVER_IP
ssh-keyscan -H -p 22 SERVER_IP > ./chatbotx-known-hosts
```

Verify the host fingerprint through the server console before saving the
private-key and known-hosts file contents as GitHub secrets. Delete the local
private-key copy after storing it in GitHub if it is no longer needed.

GHCR packages are private by default. Create a classic GitHub personal access
token with only `read:packages`, then authenticate Docker once on the server:

```bash
printf '%s' 'GHCR_READ_TOKEN' | docker login ghcr.io \
  --username hello-jackytruong --password-stdin
```

Do not store that token in the repository or `.env`. Docker retains the login
under the server account. The workflow uses its built-in `GITHUB_TOKEN` with
`packages: write` to publish images and does not need a separate write token.

### One-time unattended-production checklist

Automatic deployment is disabled until `/root/apps/ChatbotX/.env` has mode
`0600` and contains `PRODUCTION_AUTOMATION_READY=1`. Set that flag only after
all items below pass. It is a one-time gate; later merges to `dev` need no SSH
or migration command.

Core ChatbotX values:

- `APP_URL` and the browser-reachable `S3_ENDPOINT` use HTTPS;
- `BETTER_AUTH_SECRET` and `REALTIME_BROADCAST_SECRET` contain at least 32
  random characters;
- `ENCRYPTION_KEY` is exactly 64 hexadecimal characters;
- `POSTGRES_USER`, a strong `POSTGRES_PASSWORD`, `S3_ACCESS_KEY_ID`, a strong
  `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, and a 32-character-or-longer
  `JAVASCRIPT_EXECUTOR_TOKEN` are set;
- production values do not contain `change-me`, `replace-with`,
  `insecure-default`, or the development value `secretkey`.

Zalo values:

- `ZALO_APP_URL` and `ZALO_S3_PUBLIC_URL` use HTTPS;
- `ZALO_DB_USER=zalo_personal`, a strong `ZALO_DB_PASSWORD`, and
  `ZALO_DATABASE_URL` target `postgres:5432/zalo_personal`, with reserved
  password characters percent-encoded;
- `ZALO_REDIS_URL=redis://redis:6379/1`;
- `ZALO_DEPLOYMENT_MODE=migrate` when importing existing Zalo data, or `fresh`
  only after an empty-install inventory;
- `ZALO_JWT_SECRET` contains at least 32 characters,
  `ZALO_ENCRYPTION_KEY` is 64 hexadecimal characters, and the Zalo database
  role, RustFS identity, and bucket differ from ChatbotX;
- `ZALO_AUTOMATION_STUB_MODE=false`.

Prepare two different encrypted backup mounts:

```bash
install -d -m 700 \
  /mnt/encrypted-offsite/chatbotx/zalo-personal \
  /mnt/encrypted-admin/chatbotx/postgres-globals
touch \
  /mnt/encrypted-offsite/chatbotx/zalo-personal/.chatbotx-encrypted-backup-target \
  /mnt/encrypted-admin/chatbotx/postgres-globals/.chatbotx-encrypted-backup-target
chmod 600 /root/apps/ChatbotX/.env
```

Configure and verify:

```dotenv
ZALO_BACKUP_OFFSITE_DIR=/mnt/encrypted-offsite/chatbotx/zalo-personal
ZALO_BACKUP_OFFSITE_VERIFIED=1
ZALO_GLOBALS_BACKUP_OFFSITE_DIR=/mnt/encrypted-admin/chatbotx/postgres-globals
ZALO_GLOBALS_BACKUP_OFFSITE_VERIFIED=1
PRODUCTION_AUTOMATION_READY=1
```

Do not use `ZALO_ALLOW_LOCAL_BACKUP_ONLY=1` for unattended production. Verify
Nginx routes, Node.js 24, `flock`, free disk, swap, current container health,
and GHCR login, then run the read-only gate:

```bash
cd /root/apps/ChatbotX
./scripts/docker/production-full.sh check
```

### What every merge to `dev` does

1. Run type-check, lint, ChatbotX tests, Zalo contracts/tests/build,
   deployment shell tests, and workflow lint.
2. Compare each scope with its own successful production baseline and build
   only affected immutable `sha-<commit>` images.
3. Acquire one host lock before checkout and reject superseded commits.
4. Validate the complete `.env`, encrypted backup mounts, Compose model,
   shared-service health, host capacity, and every selected scope before the
   first application mutation.
5. Ensure ChatbotX and Zalo backup schedules are installed.
6. Pull images, verify OCI Git revisions, back up data, reject destructive
   non-expand/contract migrations, and apply Drizzle/Prisma migrations.
7. Activate only affected services with `--no-deps`, run readiness probes,
   and automatically restore previous images when activation fails.
8. Preserve current and rollback images, remove obsolete local release tags,
   and move a scope's successful baseline only after its environment job
   succeeds.

No deployment system can guarantee every release succeeds: a bad secret, full
disk, unavailable registry, or incompatible migration must fail. This workflow
fails before mutation where possible and fails closed with service-scoped
image rollback otherwise, while leaving the previous ChatbotX services
running.

The deployment job updates the server checkout only when `origin/dev` still
matches the image commit. The production script checks the remote branch again
after pulling the images and before touching the database, so a superseded
workflow exits without deploying stale images. The server then performs the
equivalent of:

```bash
cd /root/apps/ChatbotX
CHATBOTX_IMAGE_PREFIX=ghcr.io/hello-jackytruong \
CHATBOTX_IMAGE_TAG=sha-<full-git-sha> \
CHATBOTX_EXPECTED_GIT_SHA=<full-git-sha> \
CHATBOTX_DEPLOY_SERVICES=builder,worker \
  ./scripts/deployment/production.sh pull-deploy
```

`detect-affected-services.mjs` compares the latest successful GitHub deployment
for each of `production-chatbotx` and `production-zalo` with the current
commit. The workflow activates every affected service together under one host
lock, then records the two scope baselines independently only after the whole
activation succeeds. Using deployed commits instead of only the preceding push
keeps changes cumulative when pushes overlap, builds are cancelled, or a stale
workflow is rejected. A Builder-only
change therefore builds and restarts only Builder; a shared-package change
includes every application that depends on that package. Changes to the
lockfile, Compose, production scripts, root build configuration,
dependency-detection logic, or the database/migration package intentionally
fall back to all four services. Missing or unavailable deployment history and
dependency-detection errors also fall back to all four instead of risking an
incomplete release. A documentation-only change does not run this workflow,
and a change with no production application consumer passes the quality gate
without activating anything.

`pull-deploy` first preflights every selected scope, then downloads only the
selected images. It verifies that every image's embedded Git revision matches
the requested commit before recording it as deployable. Untouched services
retain their exact running image tags.
PostgreSQL is backed up and migrations run before cutover; selected services
then activate one at a time in dependency-safe order with `--no-deps`, so
Compose cannot restart an unrelated application or datastore. Each selected
service has independent current and previous image state. A failed health check
rolls back all services touched by that release while leaving every other
container unchanged. If a later Zalo scope or the final shared-state smoke
fails, the dispatcher also restores any ChatbotX scope activated earlier in
the same combined release. Existing commit tags are never rewritten by a
workflow rerun.

A workflow superseded by a newer `dev` commit exits with a temporary-failure
status rather than reporting a successful deployment. The next workflow then
continues comparing from the last production commit that actually completed.

The first deployment on a new server must include all four application
services. A selective deployment refuses to proceed when any untouched
application service is not already running. Manual service-scoped operations
use validated names:

```bash
# Pull and activate only Builder (database safety steps still run).
CHATBOTX_DEPLOY_SERVICES=builder \
CHATBOTX_IMAGE_TAG=sha-<full-git-sha> \
  ./scripts/deployment/production.sh pull-deploy

# Roll back the services touched by the latest deployment.
./scripts/deployment/production.sh rollback

# Or explicitly roll back a subset.
CHATBOTX_DEPLOY_SERVICES=builder,realtime \
  ./scripts/deployment/production.sh rollback
```

A successful manual rollback marks the server for reconciliation. Selective
activation is then refused until one full deployment succeeds, because GitHub's
last successful deployment no longer represents the images actually running
on the server. Run the workflow manually once (manual runs are full deploys)
before returning to normal selective pushes.

Normal deployments retain build cache because that makes subsequent builds
substantially faster. `clean` never removes volumes, active images, the current
release, the rollback release, or the latest completed build. Review old
database backups manually when disk usage approaches the 25 GB safety threshold.
Rollback restores application images only; database migrations are not
reversed automatically because restoring a database after traffic resumes can
discard new writes. Production migrations must remain backward-compatible with
the immediately previous application version. Use the verified timestamped
PostgreSQL backup for a deliberate schema/data recovery when required.

On the 4 CPU / 8 GB production profile, Builder uses a 1024 MB V8 old-space
limit inside a 1536 MB container (`BUILDER_MEMORY_LIMIT`). This leaves native
allocation headroom and avoids the restart/502 loop caused by V8 reaching its
smaller cgroup-derived default. Override `BUILDER_MAX_OLD_SPACE_MB` only with a
matching container and host capacity; the heap must remain below the container
limit. `BUILDER_HOST` defaults to `0.0.0.0` independently of Docker's
container-ID `HOSTNAME`, keeping the loopback health check reachable. Worker,
Realtime, and JavaScript Executor retain their existing cgroup-aware behavior;
in particular, the multi-process `worker all` mode has no implicit per-child
heap cap.

## Automatic database backups

The unattended deploy installs or reconciles the backup schedules before the
first application mutation. These commands remain available for manual repair
and inspection:

```bash
cd /root/apps/ChatbotX
./scripts/deployment/production.sh backup
./scripts/deployment/production.sh install-cron
./scripts/deployment/production.sh cron-status
```

The generated `/etc/cron.d/chatbotx-production-backup` runs at 02:00 and 14:00
in `Asia/Ho_Chi_Minh`. Backups are stored under
`/var/backups/chatbotx-production/`, validated with `pg_restore --list`, and
retained for at most 15 days and 30 files. Extra manual or pre-migration
backups still count toward the same 30-file limit.

Cron output is written to `/var/log/chatbotx-production-backup.log`; a logrotate
rule is installed automatically. To remove only the schedule while preserving
all existing database backups:

```bash
./scripts/deployment/production.sh remove-cron
```

## Host Nginx routes

TLS terminates in host Nginx. The single public domain routes to loopback-only
container ports:

```nginx
# Place this map in Nginx's http context, outside the server block.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# Place these directives inside the HTTPS server block.
client_max_body_size 21m;

location ^~ /storage/ {
    proxy_pass http://127.0.0.1:9000/chatbotx/;
    proxy_buffering off;
    proxy_request_buffering off;
}

# Browser-direct presigned uploads. Keep the signed bucket path and Host intact.
location ^~ /chatbotx/ {
    client_max_body_size 110m;
    proxy_pass http://127.0.0.1:9000;
    proxy_set_header Host $http_host;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
}

location ^~ /ws/ {
    proxy_pass http://127.0.0.1:1999/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 3600s;
}

location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

Do not configure Nginx with `root /root/apps/ChatbotX`; source files and `.env`
must never be served as static files. Next.js static assets are already bundled
inside the Builder image, while uploaded files persist in the RustFS Docker
volume.

## Operations

```bash
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs -f --tail=200 builder worker
curl -fsS http://127.0.0.1:3123/api/health
curl -fsS http://127.0.0.1:1999/health
```

Do not use `docker compose down --volumes` or `docker system prune --volumes` on
the production server.
