# Phase 3: Workspace-admin web experience

## Context

- `apps/builder/src/features/contact-scan/`
- `apps/builder/src/app/space/[workspaceId]/contacts/scan/`
- `apps/builder/src/features/inboxes/provider/inbox-hook.ts`
- Workspace authorization helpers under `apps/builder/src/lib/`.

## Requirements

- Keep the form limited to Page, time range, Contacts, and Messages.
- Show accurate progress and terminal counters without exposing credentials or
  raw provider payloads.
- Permit only workspace owner/admin access.
- One manual run targets one Page.

## Files to modify or create

- `apps/builder/src/app/space/[workspaceId]/(settings)/settings/backfill/page.tsx`
- `apps/builder/src/features/messenger-backfill/`
- The workspace settings navigation/registry used by the current settings UI.
- Locale message files used by the builder.
- Builder tests for access, form validation, actions/APIs, status polling, and
  history rendering.

## Implementation

1. Add a workspace settings entry named Messenger Backfill.
2. Build a form with:
   - connected Messenger Page/inbox;
   - `fromAt` and `toAt` date-time pickers;
   - Contacts checkbox;
   - Messages checkbox;
   - submit button.
3. Require at least one resource. Explain that Messages automatically prepares
   the required contact/conversation records.
4. Submit ISO instants and perform the same validation on client and server;
   do not apply a maximum lookback.
5. Poll and render phase, scanned conversations, contacts imported/existing,
   messages imported/duplicate, unavailable skips, real failures, started time,
   and finished time.
6. Add a compact history table and actions to cancel a live run or retry a
   failed/partial run with the same parameters.
7. Show a clear provider limitation: the run imports everything Meta still
   exposes, but cannot recover deleted or inaccessible content.
8. Sanitize provider errors. Never display access tokens, raw Graph URLs, or
   full provider response bodies.

## Verification

- Non-admin users receive a server-side denial/404 even with a copied URL.
- Date/time values retain the administrator's intended instant across timezone
  conversion.
- The form rejects an empty resource selection and `fromAt >= toAt`.
- Progress polling stops on terminal status.
- Cancel/retry actions are workspace scoped and race safe.

## Risks and rollback

- Avoid adding configuration unrelated to the two requested data types.
- Rollback: remove the navigation entry and disable the create action; existing
  history remains readable for audit.

