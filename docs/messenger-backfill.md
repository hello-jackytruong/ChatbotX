# Messenger Backfill

Messenger backfill imports contacts and message history that Meta still exposes
for a connected Facebook Page. It supports an administrator-selected time range
and an automatic repair pass for recent messages that webhooks may have missed.

## Manual backfill

Open **Workspace Settings → Backfill**, select one connected Messenger Page,
choose an exact start and end time, then select Contacts, Messages, or both.
There is no application-level maximum lookback. A range older than three years
is accepted, but deleted, expired, revoked, or otherwise inaccessible Meta data
cannot be recovered.

Only workspace `superAdmin` members may view, create, cancel, or retry these
runs. One run may be active for a Messenger integration at a time. The status
view refreshes while a run is active and shows imported, duplicate, unavailable,
and failed counts.

Selecting Messages also creates the contact, inbox, and conversation records
needed to store those messages. Imported history is passive: it does not emit
new-contact automation events or make old messages unread. Source identifiers
make repeated and overlapping ranges idempotent.

## Automatic reconciliation

By default, the worker checks connected Messenger Pages every ten minutes.
Each Page gets at least a fifteen-minute lookback. After interruption, the next
run starts from the last successful checkpoint with a five-minute overlap, so
downtime does not create a gap. The checkpoint moves only after a successful
pass.

Manual and automatic work share the same per-integration lock, and Messenger
backfills run serially to keep Graph requests and PostgreSQL connections bounded.
Known unavailable-object responses (`100/33` and `230`) skip that object; token
or permission failures stop the run and require reconnecting the Page.

## Worker configuration

```dotenv
MESSENGER_AUTO_BACKFILL_ENABLED=true
MESSENGER_AUTO_BACKFILL_INTERVAL_MINUTES=10
MESSENGER_AUTO_BACKFILL_WINDOW_MINUTES=15
```

These are also the application defaults; automatic reconciliation is enabled
when the variables are unset. For a staged rollout, set
`MESSENGER_AUTO_BACKFILL_ENABLED=false` before starting the worker. Changing
the enabled flag or interval requires restarting the schedule worker; changing
the window requires restarting the integration worker. Restart the standalone
worker when both workloads share that process.

## Operations

Before enabling production reconciliation, apply pending database migrations,
including both Messenger backfill migrations:

```bash
pnpm --filter @chatbotx.io/database db:migrate
```

For an initial check, run a short known time range on one Page, repeat the same
range, and confirm the second run creates no duplicate messages. During a long
run, monitor worker memory, Graph throttling, and active PostgreSQL connections.

On each reconciliation tick, the scheduler requeues pending runs and running
runs whose heartbeat has been stale for one hour. Do not reset the checkpoint
to recover an interruption; the next successful automatic pass will catch up
from the stored checkpoint.
