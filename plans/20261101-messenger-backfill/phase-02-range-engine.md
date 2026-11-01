# Phase 2: Exact-range Messenger import engine

## Context

- `apps/worker/src/integration/handlers/coexist/messenger-sync.ts`
- `apps/worker/src/integration/handlers/coexist/messenger-helpers.ts`
- `apps/worker/src/integration/handlers/coexist/bulk-historical-import.ts`
- `apps/worker/src/integration/handlers/contact-scan/engine.ts`
- `integrations/messenger/src/apis/sync.ts`
- `integrations/messenger/src/lib/http-client.ts`

## Requirements

- Import every provider-accessible contact/message in the selected range.
- Apply the date range to message `created_time`, not only conversation
  `updated_time`.
- Do not inherit Coexist's cross-run ceiling, global lookback, or minimum-100
  recent-message behavior.
- Preserve existing deduplication and historical-import side-effect isolation.
- Continue past an unavailable account/conversation without hiding real
  authentication or database failures.

## Files to modify or create

- `apps/worker/src/integration/handlers/messenger-backfill/engine.ts`
- `apps/worker/src/integration/handlers/messenger-backfill/error-policy.ts`
- `apps/worker/src/integration/handlers/messenger-backfill/range.ts`
- `apps/worker/src/integration/handlers/coexist/messenger-helpers.ts`
- `apps/worker/src/integration/handlers/coexist/bulk-historical-import.ts`
- `integrations/messenger/src/apis/sync.ts`
- `packages/worker-config/src/queues/integration/`
- Focused worker and Messenger integration tests.

## Implementation

1. Extract/reuse a Messenger range walker with explicit `fromAt` and `toAt`.
2. Walk conversations newest to oldest. A conversation newer than `toAt` must
   still be inspected because it can contain older messages inside the range;
   stop only once conversation `updated_time` is older than `fromAt`.
3. Walk each conversation's messages newest to oldest:
   - skip messages newer than `toAt`;
   - import messages inclusively within `[fromAt, toAt]`;
   - stop paging once messages are older than `fromAt`;
   - when only Contacts is selected, inspect enough messages to prove the
     participant was active in the selected period without storing messages.
4. Remove the minimum-100 behavior only for the new backfill mode; preserve
   existing Coexist behavior.
5. Normalize all available fields already supported by the import path:
   participant id/name/email, best-effort profile/avatar, phone/email found in
   message text, direction, timestamps, attachments, and button templates.
6. If Messages is selected, always upsert the required contact/link/conversation
   records before message insert.
7. Keep imports idempotent through the existing contact resolution and message
   source-id uniqueness. Existing rows are not overwritten with older or empty
   values.
8. Preserve historical semantics: no automation/webhook/unread side effects,
   and advance the AI context marker so imported history is ignored by AI.
9. Persist the conversation cursor only after the current page is durably
   handled. Reprocessing after a crash must be safe. Persist a per-conversation
   message cursor only if a single conversation cannot reliably finish inside
   the chunk budget.
10. Handle Graph responses by context:
    - per-account/conversation `100/33` or `230`: count unavailable and continue;
    - `429`, `5xx`, `4`, `17`, `613`: bounded retry/backoff;
    - Page/token/permission failures: fail with reconnect guidance;
    - unknown per-conversation failures: bounded retry, then record a real
      failure and finish partial.
11. Allow the message API page size to shrink when Meta reports a response is
    too large, rather than retrying the same oversized request.
12. Use a per-integration Redis lock and worker concurrency of one for the
    production deployment.

## Verification

- Boundary tests cover exactly-at-`fromAt`, exactly-at-`toAt`, before, and
  after.
- A conversation updated after `toAt` still contributes messages in range.
- A conversation older than `fromAt` stops the outer walk.
- Contacts-only and Messages-only selections behave as specified.
- Duplicate and overlapping reruns insert zero duplicate messages.
- Attachments/templates follow only newly inserted messages.
- `100/33` and `230` produce successful-with-skips counters, not partial runs.
- Token expiry and workspace mismatch fail the run.
- Worker termination mid-page resumes without missing data.

## Risks and rollback

- Meta may no longer expose deleted/revoked content. Count it as unavailable
  and state this limitation in the UI.
- Very old ranges may take hours or days. Chunking and persisted progress keep
  runtime unbounded without holding a BullMQ lock indefinitely.
- Rollback: stop enqueueing new jobs; idempotent rows already imported remain
  valid application data.

