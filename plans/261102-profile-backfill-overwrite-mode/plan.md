---
title: Messenger profile backfill overwrite mode
status: completed
priority: P1
effort: small
branch: fix/pancake-conversations-profile-backfill
tags: [messenger, pancake, backfill]
created: 2026-11-02
---

# Messenger profile backfill overwrite mode

## Scope

- Add an admin-selectable `missingOnly`/`overwrite` mode to Messenger profile backfill.
- Keep `missingOnly` as the default and preserve realtime profile enrichment behavior.
- Store the selection on each run so history and retries retain it.

## Implementation

1. Add `overwriteExisting boolean NOT NULL DEFAULT false` to the run schema and migration.
2. Thread the option through UI validation, schedule/retry, query output, and worker execution.
3. In overwrite mode scan every Page contact and replace only fields supplied by the selected provider; preserve existing values for provider fields that are absent.
4. Add focused repository/service/UI-contract tests and update English/Vietnamese UI copy plus operator docs.

## Acceptance criteria

- Existing callers and new runs default to missing-only behavior.
- Overwrite mode scans all Page contacts and can replace existing name, gender, and avatar.
- A missing provider value never erases an existing contact field.
- Retry preserves the original mode and history displays it.
- Realtime webhook enrichment is unchanged.
- Affected tests, typechecks, lint, and migration drift checks pass.

## Out of scope

- Changing Pancake/Meta provider selection, token handling, or realtime callbacks.
- Automatically running overwrite mode.

## Verification

- Database repository tests: 2 passed.
- Business profile backfill/provider tests: 10 passed.
- Builder schema test: 1 passed.
- Worker regression tests: 221 passed.
- Database, business, builder, and worker typechecks passed.
- Migration drift, i18n, full repository lint, and diff checks passed.
