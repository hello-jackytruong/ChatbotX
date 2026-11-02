---
title: Realtime contact profile sync
date: 2026-11-02 17:20
severity: Medium
component: Worker, realtime protocol, Builder conversation list
status: Resolved
tags: [messenger, realtime, contact-profile, privacy]
---

# Realtime contact profile sync

## Context

Messenger could persist an inbound message before its existing contact profile
was enriched. The conversation appeared immediately, but a nameless row could
remain blank until the user opened or reloaded it.

## What happened

The root cause was blunt: `messageCreated` was queued before the post-save
profile refresh, and we had no realtime contact sync afterward. The database
eventually held `fullName`, while the loaded Builder store kept stale contact
data. We added a validated `contactUpdated` payload
(`{ contactId, changes: { fullName } }`) after successful persistence and
refresh, then merged it through `ChatRealtime.updateContact`.

Review caught a real security mistake in the first delivery shape. A contact
name is PII, and a workspace-wide broadcast could expose it to members who only
have assigned-contact access. The event now uses `routeForConversation` with
the inbox plus assigned team/user scope.

## Reflection

This was frustrating because persistence was correct while the UI still looked
broken; the missing link was lifecycle ordering, not another backfill or query.
Worse, the obvious “just broadcast the new name” fix initially ignored the
authorization boundary. Realtime routing is part of data access control, not a
delivery optimization.

## Decisions

- Emit `contactUpdated` only after the refreshed profile has been persisted.
- Keep publishing fire-and-forget through `queueWorkspaceRealtimeEvent`; a
  Redis failure is logged but must never delay or fail inbound message handling.
- Reject a global workspace broadcast in favor of conversation routing because
  `fullName` must respect assigned-scope visibility.
- Render the first nonblank name, email, or phone; then channel username, PSID,
  and finally an em dash. This prevents blank titles and initials while refresh
  is pending or unavailable.
- Leave avatar proxying and lazy hydration unchanged; this fix was for identity
  text, not media behavior.

## Next

- Realtime maintainers must preserve conversation routing before adding more
  fields to `contactUpdated`; treat every added field as PII during review.
- Builder maintainers should keep the fallback-order regression test with the
  conversation row. No follow-up migration, API, or backfill work remains.
- Verification completed sequentially: 313 focused tests passed with zero
  failures, followed by passing protocol, Worker, Builder, and realtime gateway
  typechecks.
