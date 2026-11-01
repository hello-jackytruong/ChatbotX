---
phase: 2
title: "Non-blocking realtime profile fallback"
status: pending
effort: "medium"
---

# Phase 2: Non-blocking realtime profile fallback

## Overview

Add one shared Messenger profile resolver that tries Pancake first, preserves
the current Meta implementation as a callback fallback, and returns no profile
rather than interrupting message processing.

## Files

- Create `packages/business/src/messenger-profile-provider/` with the Pancake
  client, response schemas, exact-identity mapper, provider policy, and tests.
- Add a narrow Node-only export in `packages/business/package.json`; avoid the
  Edge-traced top-level barrel if the dependency graph is Node-only.
- Add a small worker adapter and minimally modify
  `apps/worker/src/integration/handlers/received-message.ts` for new-contact
  and existing-nameless-contact fetches.
- Modify only the Messenger entry in
  `apps/builder/src/features/contacts/lib/profile-fetcher-factories.ts`.
- Modify the Messenger lazy-avatar branch in
  `packages/channel-registry/src/media-hydration.ts` to use the shared resolver
  while preserving its lock/sentinel/storage behavior.
- Add sanitized Pancake contract fixtures and focused unit/integration tests.

## Tests before implementation

- Add failing resolver tests for: no credential keeps Meta-only behavior;
  Pancake success skips Meta; not-found/timeout/401/429/malformed response or
  unusable profile calls Meta; both unavailable returns `null`.
- Add exact identity tests: accept only the requested Page + PSID through
  conversation id, `conv_from.id`, customer `fb_id`, or equivalent documented
  field; reject mismatch and ambiguous records even if names match.
- Add mapping tests for split/full names, validated gender, missing fields, and
  no secret/raw response leakage.
- Add worker regression tests showing provider failures still create/resolve
  the PSID contact, persist the inbound message, and continue downstream work.
- Add a test proving realtime calls use `includeAvatar: false` and do not upload
  avatar bytes inline.

## Implementation

1. Start with a sanitized response fixture and one authorized Page smoke test
   to lock the Pancake endpoint, query-token contract, and response schema.
2. Resolve credential by workspace + Messenger integration, decrypt only within
   the backend callback, and apply a short timeout, zero realtime retries, and
   the Page rate limit.
3. Require exact PSID equality before mapping `firstName`, `lastName`, and
   validated `gender`. Treat mismatch/empty profile as unavailable.
4. Implement `pancakeThenMeta` composition by accepting the existing Meta
   `getProfile` call as a lazy callback. Do not move credential access into
   `integrations/messenger` or duplicate Meta Graph behavior.
5. Use the resolver at the worker creation/refresh, builder manual refresh, and
   lazy-avatar boundaries. Expected provider failures become `null`; existing
   outer safeguards remain as the final unexpected-error boundary.
6. For avatar, use the existing Pancake public avatar behavior already proven
   by `apps/worker/scripts/backfill-messenger-avatars.ts`; keep fetch/storage in
   the existing lazy/background path.

## Tests after implementation

- Run provider contract/mapping/order tests, worker receive-message tests,
  builder contact-refresh tests, and channel-registry avatar hydration tests.
- Verify logs and errors with token-shaped fixtures contain no token, Pancake
  URL query, or raw provider body.

## Regression gate

- Existing `integrations/messenger/src/apis/user.ts` tests remain unchanged and
  green; explicit Meta-only callers retain current behavior.
- Existing contact profile cooldown, atomic name-fill, avatar sentinel, media
  hydration, and Messenger receive-message suites pass.
- Typecheck business, builder, worker, channel-registry, and Messenger
  integration packages.

## Success Criteria

- [ ] Provider order is deterministic and exact-identity safe.
- [ ] Both providers failing never drops the inbound message.
- [ ] A missing credential produces the same Meta behavior as today.
- [ ] Realtime path never downloads or stores avatar bytes inline.

## Risks and rollback

- Provider latency could delay inbound processing. Bound the Pancake attempt
  tightly and never retry synchronously.
- Disable Pancake resolution or delete the Page credential to return
  immediately to the existing Meta-only path.
