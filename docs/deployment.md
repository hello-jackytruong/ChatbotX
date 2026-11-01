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

Run every first deployment and upgrade through the guarded script:

```bash
cd /root/apps/ChatbotX
./scripts/deployment/production.sh deploy
```

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

The script never runs `docker compose down`, removes volumes, or prunes images.
Old images and database backups are deliberately retained for recovery.
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

Normal deployments retain build cache because that makes subsequent builds
substantially faster. `clean` never removes volumes, active images, the current
release, the rollback release, or the latest completed build. Review old
database backups manually when disk usage approaches the 25 GB safety threshold.
Rollback restores application images only; database migrations are not reversed.
Use the timestamped PostgreSQL backup when a schema rollback is actually needed.

## Automatic database backups

Install the root cron job once after the first successful deployment:

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
