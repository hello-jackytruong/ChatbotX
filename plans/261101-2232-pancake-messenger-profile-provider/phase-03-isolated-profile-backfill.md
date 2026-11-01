---
phase: 3
title: "Isolated Messenger profile backfill"
status: completed
effort: "medium"
---

# Phase 3: Isolated Messenger profile backfill

## Overview

Add a separate, resumable profile-enrichment run to the existing Backfill page.
It scans existing Messenger contacts missing profile fields and never imports
messages or changes the current history-backfill run model.

## Files

- Create a dedicated run schema/relation/repository such as
  `messenger-profile-backfill-run` with cursor, policy, status, counters,
  heartbeat/cancel/retry fields, and workspace/Page indexes.
- Create `packages/business/src/messenger-profile-backfill/` and a keyset
  candidate read in the Contact/ContactInbox repository layer.
- Add `messengerProfileBackfill` job types/job ids in
  `packages/worker-config/src/queues/low/` and handle it in
  `apps/worker/src/low/worker.ts`.
- Create `apps/worker/src/integration/handlers/messenger-profile-backfill.ts`.
- Create `apps/builder/src/features/messenger-profile-backfill/` with schema,
  actions/query, form, progress/history, tests, and locale messages.
- Minimally compose the new card/history into
  `apps/builder/src/features/messenger-backfill/components/messenger-backfill-page.tsx`
  and its page-data query.
- Generate, inspect, but do not apply the migration.

## Tests before implementation

- Add failing action/service tests for real-superAdmin authorization, Page
  ownership, one live run per Page, default `pancake`, explicit `meta`, and
  `pancakeThenMeta` with Pancake first.
- Add failing repository tests for keyset pagination over that Page's
  Messenger `ContactInbox.sourceId`, candidates missing name/gender/avatar,
  stable resume cursor, and no cross-workspace rows.
- Add failing engine tests for provider order, exact PSID, bounded rate,
  cancel/retry/worker restart, blocked-owner guard, and no token in job data.
- Add failing atomic fill tests: update each missing field only; never overwrite
  a non-empty/manual value; retry/race stays idempotent.
- Snapshot existing Messenger history form/action/run/auto-reconcile tests as a
  regression boundary.

## Implementation

1. Keep a dedicated run table and queue action instead of extending
   `CoexistSyncRun`. Persist only ids, policy, cursor, counters, and safe errors.
2. The new card selects one connected Page and policy:
   - `pancake` (default)
   - `meta`
   - `pancakeThenMeta`
3. Claim a run, wrap execution with `withBlockedOwnerGuard`, read candidates in
   small keyset batches, and use the Phase 2 resolver per PSID with bounded
   per-Page concurrency/rate. Re-read the credential per chunk; never serialize
   plaintext into Redis/BullMQ.
4. Add a service/repository conditional update that fills missing name, gender,
   and avatar independently. Preserve non-empty fields and discard any newly
   uploaded avatar when a conditional write loses a race.
5. Persist progress/heartbeat/cursor, sanitize provider errors, yield within the
   job lock budget, and support cancel/retry without double-counting.
6. Render progress and history in the new card. Existing history backfill form,
   range engine, run history, and automatic reconciliation remain untouched.
7. Follow the existing admin-only Messenger backfill surface and document why
   this operational action is not exposed to an unbound workspace API token.

## Tests after implementation

- Run run-lifecycle, candidate isolation, provider-order, rate-limit,
  idempotency, worker restart, cancellation, and UI permission tests.
- Verify default policy is Pancake and `both` always calls Pancake before Meta.
- Verify Page disconnect/delete terminates or safely no-ops the run and cascades
  its rows without affecting contacts/messages.

## Regression gate

- Existing Messenger history-backfill builder/business/worker suites remain
  unchanged and green.
- Existing contact refresh, contact update race, workspace purge, low-worker,
  queue union/job-id, and Page disconnect tests pass.
- Typecheck affected database, business, worker-config, worker, and builder
  packages.

## Success Criteria

- [x] Admin can choose Pancake, Meta, or both; Pancake is the default/first.
- [x] Run is workspace/Page scoped, resumable, cancelable, and idempotent.
- [x] Existing profile values and all message/history flows are preserved.
- [x] Jobs and status surfaces never contain plaintext credentials.

## Risks and rollback

- Large workspaces can create provider pressure. Use small batches, Page-level
  throttling, resumable cursors, and the low-priority queue.
- Rollback by denying new schedules and draining/no-oping profile jobs; history
  backfill remains independently operational.
