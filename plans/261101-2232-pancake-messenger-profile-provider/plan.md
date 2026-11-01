---
title: "Pancake Messenger profile provider"
description: "Write-only Page credentials, non-blocking realtime fallback, and isolated profile backfill"
status: completed
priority: P1
branch: "dev"
tags: [messenger, pancake, contact-profile, security, backfill]
blockedBy: []
blocks: []
created: "2026-11-01T15:32:08.720Z"
createdBy: "ck:plan"
source: skill
---

# Pancake Messenger profile provider

## Overview

Add Pancake as an optional Messenger contact-profile source without changing
message ingestion or the existing Messenger history backfill contract.

Current inbound behavior is already safe: the webhook derives the Page id and
PSID, the worker attempts Meta profile lookup, and profile failure still creates
the contact from the PSID and continues the message pipeline. This plan keeps
that invariant and inserts a Page-scoped policy:

`Pancake (when configured) -> Meta Graph -> PSID-only contact`.

Pancake credentials are stored in a new table, encrypted with AES-GCM and
never returned to the browser/API. A separate profile-enrichment backfill is
shown on the existing Backfill page; it does not reuse or modify the current
history-import run model.

## Scope

- One write-only Pancake token per connected Messenger Page.
- Only a real workspace `superAdmin` may replace/delete it; support sessions
  are denied server-side.
- Exact Page + PSID identity matching before accepting Pancake profile data.
- Name and validated gender enrichment; avatar remains lazy/background.
- Profile backfill policies: `pancake` (default), `meta`, and
  `pancakeThenMeta`.
- Fill only missing profile fields; never overwrite operator-entered data.

## Non-goals

- Changing the Facebook webhook payload/parser or PSID extraction.
- Replacing Meta for message/conversation history discovery.
- Modifying `CoexistSyncRun`, the Messenger range engine, automatic history
  reconciliation, or `apps/worker/scripts/backfill-messenger-avatars.ts`.
- Exposing a token read/reveal endpoint or putting plaintext tokens in jobs,
  caches, logs, URLs, audit details, or client state.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [encrypted-page-credential](./phase-01-encrypted-page-credential.md) | Completed |
| 2 | [realtime-profile-fallback](./phase-02-realtime-profile-fallback.md) | Completed |
| 3 | [isolated-profile-backfill](./phase-03-isolated-profile-backfill.md) | Completed |

## Dependencies

- Existing AES-GCM helper in `packages/encryption/src/encryption.ts`.
- Existing contact profile refresh/fill guards and lazy avatar path.
- Existing Messenger Page integration and integration/low worker queues.
- Related plan `plans/20261101-messenger-backfill/` remains independent; its
  pending production verification does not block this implementation.
- Pancake conversation/profile response shape is not represented in this repo.
  Phase 2 must start from a sanitized real fixture and a one-Page smoke test.

## Acceptance criteria

- No Pancake plaintext token is stored or returned; failed verification does
  not replace the previous valid credential.
- A Page/workspace mismatch, non-admin member, or support session cannot mutate
  the credential or schedule profile backfill.
- Pancake data is used only after an exact PSID match.
- Pancake success skips Meta; missing/unusable Pancake data falls back to Meta;
  both unavailable still preserves contact/message creation from the PSID.
- Realtime processing does not download avatars inline.
- Profile backfill defaults to Pancake, supports Meta/both, is resumable and
  idempotent, and fills only missing fields.
- Existing webhook, Meta-only explicit profile flow, Messenger history
  backfill, automatic reconciliation, and message delivery tests remain green.

## Delivery order

Phases are sequential: credential storage and access control first, shared
provider resolver second, isolated backfill last. Generate migrations but do
not apply them automatically.
