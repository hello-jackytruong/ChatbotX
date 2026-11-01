---
phase: 1
title: "Encrypted Page credential"
status: completed
effort: "medium"
---

# Phase 1: Encrypted Page credential

## Overview

Create an isolated, write-only credential boundary for each connected
Messenger Page, plus a small settings card on the Page edit screen.

## Files

- Create `packages/database/src/schema/messenger-pancake-credential.ts`.
- Create `packages/database/src/relations/messenger-pancake-credential.ts` and
  `packages/database/src/repositories/messenger-pancake-credential/`.
- Update schema/repository/type exports and both the import and spread entries
  in `packages/database/src/relations/index.ts`.
- Create `packages/business/src/messenger-pancake-credential/` and add a
  Node-only package export.
- Create credential card, schema, query/actions, and tests under
  `apps/builder/src/features/integration-messenger/pancake-credential/`.
- Modify
  `apps/builder/src/app/space/[workspaceId]/messengers/[id]/edit/page.tsx` and
  builder locale files.
- Generate a migration and update workspace-purge/FK coverage; do not run it.

## Tests before implementation

- Add failing schema/repository tests for one credential per
  `integrationMessengerId`, Page/workspace-scoped reads, indexes, and cascade
  deletion.
- Add failing service tests for AES-GCM encryption with AAD
  `messenger-pancake:{workspaceId}:{integrationMessengerId}`, tamper/cross-Page
  rejection, verify-before-upsert, and retaining the old credential when
  verification fails.
- Add failing builder tests proving only a real workspace `superAdmin` can
  replace/delete; synthetic support sessions and copied action calls fail.
- Add DTO/action tests proving neither plaintext nor `EncryptedData` reaches
  props, action results, logs, or validation errors.

## Implementation

1. Store `workspaceId`, `integrationMessengerId`, encrypted token, verification
   status/timestamps, and updater id in a separate table. Use FK cascade and a
   unique integration index; never add a plaintext column.
2. Keep two repository projections: public status metadata and an internal
   encrypted row. Do not export a generic secret reader.
3. Expose service methods `getStatus`, `verifyAndReplace`, `delete`, and a
   backend-only callback such as `withToken`. Decrypt just in time inside the
   callback and never return the token to callers.
4. Verify a new token against the Page with a minimal authenticated Pancake
   request before the atomic upsert. Sanitize errors and never log a request
   URL containing `page_access_token`.
5. Render configured/unconfigured/last-verified status. The password input is
   always blank; save means replace, and delete requires confirmation.
6. Enforce Page ownership and real-superAdmin authorization in every action,
   independent of page visibility. Support sessions may view status but cannot
   mutate.
7. Do not add a workspace-token/public procedure for secret mutation: document
   the invariant-23 exemption that an unbound workspace token must never manage
   provider credentials.

## Tests after implementation

- Run focused database, business, builder action/component, encryption/AAD,
  workspace isolation, and purge tests.
- Verify the generated migration contains the expected table, unique/index/FK
  constraints and no plaintext token field.

## Regression gate

- `pnpm --filter @chatbotx.io/database check-types`
- `pnpm --filter @chatbotx.io/business test -- messenger-pancake-credential`
- Relevant builder tests and typecheck.
- Existing Messenger Page edit and disconnect tests; deleting an integration
  must remove the credential without changing integration behavior.

## Success Criteria

- [x] DB and all public DTOs contain no plaintext token.
- [x] Failed verification cannot destroy a working token.
- [x] Workspace/Page isolation and real-superAdmin-only mutation are enforced
  server-side.
- [x] No existing Messenger integration schema or auth JSON is changed.

## Risks and rollback

- Credential disclosure is high impact: use write-only DTOs, AAD, safe logging,
  and explicit internal projections.
- Rollback by hiding/denying mutations and disabling credential reads; the
  encrypted table may remain until a later migration removes it safely.
