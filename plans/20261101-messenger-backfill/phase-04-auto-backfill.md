# Phase 4: Automatic 15-minute reconciliation

## Context

- `apps/worker/src/schedule/worker.ts`
- `apps/worker/src/schedule/handlers/scan-contact-scans.ts`
- `packages/worker-config/src/queues/schedule/index.ts`
- The range engine delivered in Phase 2.

## Requirements

- Check connected Messenger Pages every 10 minutes.
- Reconcile at least the preceding 15 minutes of activity.
- Import both Contacts and Messages.
- Treat webhooks as realtime and auto backfill as a repair path.
- Avoid duplicate Page jobs and avoid overlapping a manual backfill for the
  same integration.
- Catch up safely after worker downtime without imposing a date limit.

## Files to modify or create

- `packages/worker-config/src/queues/schedule/index.ts`
- `packages/worker-config/src/queues/integration/`
- `apps/worker/src/schedule/worker.ts`
- `apps/worker/src/schedule/handlers/reconcile-messenger-history.ts`
- `apps/worker/src/integration/handlers/messenger-backfill/auto.ts`
- `apps/worker/src/env.ts`
- Scheduler/worker tests.

## Implementation

1. Register a ten-minute schedule job protected by a Redis distributed lock.
2. Enumerate connected Messenger integrations in stable order and enqueue with
   deterministic integration/time-bucket job IDs.
3. Process Page jobs with global concurrency one on the production worker.
4. Compute the range as:
   - capture one fixed `toAt = now` for the whole Page run;
   - start at the older of `now - 15 minutes` and
     `lastAutoBackfillAt - 5 minutes`;
   - when no successful checkpoint exists, start at `now - 15 minutes`.
   This preserves the normal 15-minute reconciliation window while a delayed,
   interrupted, or lock-skipped job catches up from its last successful point
   with a five-minute safety overlap.
5. Probe conversations in descending activity order. Return quickly when no
   conversation changed in the effective range.
6. When activity exists, call the same exact-range engine with Contacts and
   Messages enabled.
7. Use the same per-integration lock as manual runs. If locked, leave the
   checkpoint unchanged; the next schedule catches up.
8. Advance `lastAutoBackfillAt` only after successful reconciliation. Expected
   unavailable-account skips still count as a successful pass.
9. Use structured aggregate logs; do not create a permanent run/history row
   for every no-op check.
10. Add environment controls with production values:
    - `MESSENGER_AUTO_BACKFILL_ENABLED=true`
    - `MESSENGER_AUTO_BACKFILL_INTERVAL_MINUTES=10`
    - `MESSENGER_AUTO_BACKFILL_WINDOW_MINUTES=15`

## Verification

- Consecutive 15-minute windows overlap but insert no duplicates.
- No-activity Pages perform no message imports and advance their checkpoint.
- Missed webhooks appear after the next successful reconciliation.
- A one-hour worker outage catches up from the last successful checkpoint.
- A manual run blocks auto execution for only that integration; other Pages
  continue in stable sequence.
- A failed Page does not prevent later Pages from being checked.

## Risks and rollback

- Page count growth increases Graph calls. Stable sequential processing,
  deterministic jobs, and usage throttling bound pressure.
- Rollback: set `MESSENGER_AUTO_BACKFILL_ENABLED=false`; manual backfill remains
  available and no data rollback is necessary.

