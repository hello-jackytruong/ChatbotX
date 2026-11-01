---
title: Messenger manual and automatic backfill
status: in-progress
priority: P1
effort: large
branch: dev
tags: [messenger, backfill, worker, reconciliation]
created: 2026-11-01
---

# Messenger manual and automatic backfill

Status: in progress

Progress: 4/5 phases complete. Implementation and focused automated
verification are complete; production rollout checks in Phase 5 remain.

## Goal

Let a workspace administrator backfill Facebook Messenger contacts and
messages for any explicit date range, while continuously reconciling the last
15 minutes of Messenger activity every 10 minutes to recover delayed or missed
webhooks.

The implementation stays Messenger-only and reuses the existing historical
import, queue, progress, retry, and deduplication paths. It does not impose a
three-year lookback limit.

## Scope

- One manual run targets one connected Messenger Page.
- A manual run accepts `fromAt`, `toAt`, `includeContacts`, and
  `includeMessages`.
- Selecting messages implicitly prepares the required contact, inbox, and
  conversation records.
- The range is exact for stored messages: `fromAt <= createdAt <= toAt`.
- Contact and message enrichment includes every field already supported by the
  historical import path: participant identifiers and names, available email
  and profile data, phone/email discovered from message text, direction,
  timestamps, attachments, and button templates.
- Automatic reconciliation runs every 10 minutes with a minimum 15-minute
  lookback and processes connected Pages sequentially.
- Known unavailable-object errors (`100/33` and `230`) skip only the affected
  account or conversation and do not fail the run.
- Deleted, revoked, or provider-inaccessible data is reported as unavailable;
  the product cannot recover data Meta no longer returns.

## Non-goals

- Instagram, WhatsApp, Zalo, or other channels.
- Deleting or replacing existing contacts/messages.
- Triggering flows, automations, unread notifications, or webhooks from
  imported history.
- A multi-Page batch-management UI. Pages may be scheduled separately and the
  worker serializes execution.

## Phases

1. [x] [Run model, lifecycle, and authorization](./phase-01-run-model.md)
2. [x] [Exact-range Messenger import engine](./phase-02-range-engine.md)
3. [x] [Workspace-admin web experience](./phase-03-admin-ui.md)
4. [x] [Automatic 15-minute reconciliation](./phase-04-auto-backfill.md)
5. [ ] [Verification, rollout, and operations](./phase-05-verification.md)

## Dependencies

- Existing `CoexistSyncRun` claim/heartbeat/retry lifecycle.
- Existing Messenger `listConversations` and `listMessages` Graph clients.
- Existing `bulkImportChannelContacts` and `bulkImportMessages` idempotent
  import functions.
- BullMQ integration and schedule workers, Redis distributed locks, and the
  production worker database-pool limits.

## Acceptance criteria

- A workspace owner/admin can select a connected Messenger Page, any valid
  past `fromAt`/`toAt` range, and Contacts, Messages, or both.
- There is no application-level maximum lookback in days or years.
- Messages outside the selected range are never stored by the manual run.
- Re-running the same or overlapping range creates no duplicate contacts or
  messages.
- Selecting Messages imports the required Contact/ContactInbox/Conversation
  records even if Contacts is not selected explicitly.
- Attachments and supported structured-message data are imported with newly
  inserted messages.
- Per-conversation `100/33` and `230` errors increment an unavailable counter,
  do not consume retry budget, and do not make the run partial.
- Page-level authentication or permission failure stops the run with an
  actionable reconnect error.
- A run survives worker restart, resumes without skipping a page, and reports
  progress and terminal counters in the web UI.
- Every connected Messenger Page is checked every 10 minutes; the effective
  range looks back at least 15 minutes and catches up from the last successful
  checkpoint after downtime.
- Manual and automatic jobs for the same integration never execute
  concurrently.
- The production server processes Messenger backfills serially and does not
  exhaust PostgreSQL connections.

