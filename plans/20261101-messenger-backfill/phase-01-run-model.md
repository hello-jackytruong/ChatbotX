# Phase 1: Run model, lifecycle, and authorization

## Context

- `docs/contact-scan.md`
- `packages/database/src/schema/coexist-sync-run.ts`
- `packages/database/src/partials/coexist-sync-run.ts`
- `packages/database/src/repositories/coexist-sync-run/`
- `packages/business/src/contact-scan/`

## Requirements

- Reuse the proven `CoexistSyncRun` lifecycle instead of introducing a second
  job framework.
- Keep coexist, contact scan, and manual backfill queries strictly type-scoped.
- Allow only workspace owner/admin users to create, view, cancel, or retry a
  manual backfill.
- Permit one active manual backfill per Messenger integration.
- Keep auto-reconciliation checkpoints per Messenger integration without
  creating a permanent run row for every no-op ten-minute check.

## Files to modify or create

- `packages/database/src/partials/coexist-sync-run.ts`
- `packages/database/src/schema/coexist-sync-run.ts`
- `packages/database/src/schema/integration-messenger.ts`
- `packages/database/src/repositories/coexist-sync-run/repository.ts`
- `packages/database/src/repositories/integration-messenger/repository.ts`
- `packages/database/drizzle/<generated>_messenger_backfill/migration.sql`
- `packages/business/src/messenger-backfill/`
- `packages/database/__tests__/coexist-sync-run-type-scoping.test.ts`
- Focused business/repository tests under `packages/business/__tests__/` and
  `packages/database/__tests__/`.

## Implementation

1. Add `backfill` to the shared run-type enum.
2. Add nullable/manual-backfill fields to `CoexistSyncRun`:
   - `rangeFromAt`, `rangeToAt`
   - `includeContacts`, `includeMessages`
   - `skippedUnavailableCount`
   - reuse `requestedByUserId`, counters, heartbeat, claim token, phase,
     cursor, and timestamps where their semantics match.
3. Add a partial unique index preventing more than one live `backfill` run per
   integration.
4. Add `lastAutoBackfillAt` to the Messenger integration. It is the last
   successful reconciliation checkpoint, not merely the last attempted time.
5. Implement a type-scoped repository/service for create, claim, progress,
   continuation, finish, cancel, retry, status, and history.
6. Validate `fromAt < toAt <= now`; deliberately apply no maximum age.
7. Validate the Messenger integration and inbox belong to the requested
   workspace and remain connected.
8. Add owner/admin authorization at the server action/API boundary; do not
   rely on hiding the page in navigation.
9. Extend type-scoping tests so a `backfill` row cannot influence coexist
   resume ceilings or contact-scan selection.

## Verification

- Migration applies to an existing database without rewriting message tables.
- Concurrent creates for the same integration yield one live run.
- A run from another workspace cannot be read, canceled, or retried.
- Coexist and contact-scan repository tests remain unchanged and passing.
- `lastAutoBackfillAt` advances only after a successful auto reconciliation.

## Risks and rollback

- Risk: a missed `type` predicate could affect coexist/contact-scan behavior.
  Mitigation: expand the existing type-isolation test matrix before adding the
  worker handler.
- Rollback: disable the new API/UI and scheduler first. Nullable columns and
  the enum value may remain safely until a later cleanup migration.

