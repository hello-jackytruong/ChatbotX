---
title: "Realtime contact profile sync"
status: completed
priority: P1
effort: small
branch: "fix/pancake-conversations-profile-backfill"
tags: [messenger, pancake, realtime, contact-profile]
created: "2026-11-02"
---

# Realtime contact profile sync

## Scope

- Emit a workspace realtime event only after an existing contact profile is successfully enriched.
- Merge the refreshed display name into the loaded conversation row without requiring a click.
- Render username/PSID as a temporary fallback while enrichment is pending or unavailable.
- Keep message persistence and broadcast non-blocking; no database or backfill changes.

## Acceptance criteria

- [x] Incoming messages remain visible even when profile enrichment fails.
- [x] A successful profile refresh updates the loaded conversation name automatically.
- [x] A nameless contact never renders as a blank conversation title or blank initials.
- [x] Existing avatar proxy/lazy hydration behavior remains unchanged.
- [x] Focused realtime, worker, and conversation-row tests pass sequentially.
