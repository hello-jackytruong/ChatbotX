# Phase 1: affected services

Status: complete

- Use Turborepo's dependency graph between the latest successful production
  deployment and the current head SHA, so overlapping pushes remain cumulative.
- Map affected app packages to Builder, Worker, Realtime, and JavaScript
  Executor image definitions.
- Treat deployment infrastructure and ambiguous detection failures as a full
  deployment.
- Treat database and migration package changes as a full deployment so no
  long-running service remains on an older schema contract.
- Produce a validated dynamic GitHub Actions matrix and service list.
