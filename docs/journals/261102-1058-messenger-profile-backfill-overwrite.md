---
title: Messenger profile backfill overwrite mode
date: 2026-11-02
tags: [messenger, pancake, backfill]
---

# Messenger profile backfill overwrite mode

## Context

Profile backfill originally filled only missing contact fields. Administrators
needed an explicit way to refresh existing names, gender, and avatars from the
selected Pancake/Meta provider.

## What happened

- Added a persisted `overwriteExisting` run option with a safe `false` default.
- Added an admin UI switch and retained the selected mode in history and retry.
- Added a full-Page candidate path and a non-destructive overwrite query.
- Generated the Drizzle migration and added focused cross-layer tests.

## Reflection

Persisting the mode on the run avoids hidden queue behavior and makes retries
deterministic. Separate missing-only and overwrite repository methods keep the
existing conservative SQL unchanged.

## Decisions

- Missing-only remains the default for backward compatibility.
- Overwrite updates only fields returned by the provider; absent values never
  clear existing contact data.
- Realtime webhook enrichment remains unchanged.

## Next

- Apply the pending database migration before starting the updated services.
- Monitor the first overwrite run's update and avatar counts.
