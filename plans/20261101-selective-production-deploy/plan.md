# Selective production deployment

Status: complete

## Goal

Build, pull, restart, health-check, and roll back only application services
affected by a `dev` push, while preserving the existing database backup,
migration, locking, and stale-release protections.

## Phases

1. [Affected-service detection](./phase-01-affected-services.md)
2. [Service-scoped activation and rollback](./phase-02-service-activation.md)
3. [Workflow, tests, and operations documentation](./phase-03-verification.md)

## Acceptance criteria

- Builder-only changes do not rebuild or restart Worker, Realtime, or the
  JavaScript Executor.
- Shared-package and global build changes conservatively include every affected
  application, with a full-deploy fallback if detection cannot prove safety.
- Overlapping pushes compare from the latest successful production deployment,
  so a stale or cancelled workflow cannot make a service change disappear.
- A manual rollback blocks selective activation until a full deployment
  reconciles GitHub deployment history with the running server images.
- PostgreSQL, Redis, RustFS, Nginx, and Docker volumes are never recreated by an
  application-only deployment.
- Images are verified against the requested Git SHA before activation.
- A failed health check restores the previous image of every touched service.
- Database backup and migration complete before application cutover.
