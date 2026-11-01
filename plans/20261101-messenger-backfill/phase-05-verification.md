# Phase 5: Verification, rollout, and operations

## Context

- `docs/contact-scan.md`
- Production Docker worker environment and deployment scripts.
- Existing tests around coexist Messenger sync, contact scan, and Graph error
  policy.

## Requirements

- Prove correctness at range boundaries, retries, resume, deduplication,
  authorization, and production resource limits.
- Roll out without interrupting webhook processing or existing coexist jobs.
- Document only the new administrator workflow and operational controls.

## Files to modify or create

- Focused tests in `apps/worker/__tests__/`, `apps/builder/__tests__/`,
  `packages/business/__tests__/`, `packages/database/__tests__/`, and
  `integrations/messenger/__tests__/`.
- `docs/messenger-backfill.md`
- `.env.example`
- Production environment/compose documentation only where the new worker
  variables must be surfaced.

## Verification sequence

1. Run focused repository/business tests for lifecycle and type isolation.
2. Run range-engine tests with multi-page conversations and exact boundaries.
3. Run error-policy tests for `100/33`, `230`, rate limits, token expiry, and
   unknown per-conversation failures.
4. Run builder authorization/form/status tests.
5. Run scheduler tests for overlap, deterministic job IDs, downtime catch-up,
   and per-integration locking.
6. Run lint/typecheck for touched workspaces, then the relevant builder and
   worker build targets.
7. In staging/production, start with one Page and a short known range; compare
   imported counts and sampled source IDs against Graph responses.
8. Repeat the same range and confirm zero duplicate messages.
9. Exercise a long range and restart the worker mid-run; confirm continuation
   and bounded PostgreSQL connections.
10. Enable auto reconciliation, intentionally suppress one test webhook, and
    confirm the message appears during the next pass.

## Verification status

- Completed locally on 2026-11-01: 16 focused test files, 287 tests, all pass.
- Completed: database, business, worker-config, worker, and builder typechecks;
  focused Ultracite, builder i18n, and `git diff --check` all pass.
- Completed: review fixes for per-message durable resume/counters, passive
  unread-state preservation, safe public errors, unavailable Page handling,
  bounded unknown-provider retry, and non-blocking concurrent indexes.
- Pending production rollout: steps 7-10 above. Docker was intentionally not
  started during implementation verification.

## Operational defaults

- Manual backfill: one active run per integration.
- Worker-wide Messenger backfill concurrency: one.
- Per-conversation Graph concurrency: no more than two initially; adaptive
  throttling may reduce it.
- Five-minute schedule and minimum fifteen-minute lookback, extended from the
  last successful checkpoint after interruption.
- No maximum manual lookback.
- Existing production database pool limits remain unchanged.

## Rollout

1. Deploy schema and code with automatic reconciliation disabled.
2. Verify manual backfill on one Page and an overlapping rerun.
3. Enable automatic reconciliation for production.
4. Monitor PostgreSQL connections, worker memory, Graph rate-limit headers,
   run duration, unavailable skips, and real failures.
5. Keep the feature enabled only if webhook latency and normal worker queues
   remain healthy.

## Rollback

- Disable the scheduler environment flag.
- Disable the manual create action/navigation while allowing live runs to be
  canceled or drain safely.
- Do not delete imported data: it is deduplicated, valid Messenger history.
- Nullable schema additions can remain until a later migration.

