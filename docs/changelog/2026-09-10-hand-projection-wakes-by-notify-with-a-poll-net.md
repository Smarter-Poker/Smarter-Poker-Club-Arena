# 2026-09-10 - the hand projection worker wakes by NOTIFY, with a poll net

Branch `fix/hand-projection-wakes-by-notify-with-a-poll-net` (engine swarm, workstream H,
implementing workstream D's design). Migration `20260910052523_hand_projection_outbox_notifies_its_listener`
is written, NOT applied.

## What changed and why

`public.hand_projection_outbox` takes one INSERT and one DELETE per hand. The engine's
projection worker (`server/src/services/supabase/handProjection.ts`) was woken by a Supabase
Realtime `postgres_changes` subscription on that table, and the callback never read its
payload: it only called `wakeHandProjection()`, which re-reads the outbox ordered by
`hand_number`. To deliver that no-op payload, Realtime's poller logically decodes and
RLS-checks every outbox WAL record. Measured after the 02:34 pg_stat reset on 2026-09-10:
the outbox was 95.5% of all published-table changes (18,478 of 19,349 in 35 min), and the
poller was 8,589 calls, 57 ms mean, 5.16% of all database time (7% over the prior 17 h).

The same "a row was inserted" signal now arrives as a Postgres NOTIFY, and a 5 s poll makes a
dead signal path impossible to notice from the tables' side:

1. **Database** (migration, one BEGIN/COMMIT): `trg_notify_hand_projection_outbox()` +
   `z9_notify_hand_projection_outbox AFTER INSERT FOR EACH ROW` calling
   `pg_notify('hand_projection_outbox', hand_id || ':' || table_id)`. `pg_notify` takes no
   locks, raises only for a bad channel name or a payload over 8000 bytes (ours is 73), and
   is transactional: a settlement that rolls back discards its notification with its row.
   With no listener connected the notification is dropped at commit for free. The existing
   `a0_finish_hand_post_commit_obligations` BEFORE DELETE trigger is untouched.
2. **Engine listener** (`server/src/services/supabase/handOutboxListener.ts`, new): one
   dedicated `pg` client on a session-mode connection running `LISTEN hand_projection_outbox`.
   Every notification calls `wakeHandProjection('listen')`. Jittered exponential reconnect
   (500 ms, 1 s, 2 s ... 30 s cap, +/-25%), a `SELECT 1` heartbeat every 30 s so a half-open
   socket becomes an error, and one `wakeHandProjection('listen_resync')` after every
   (re)connect so a hand committed while disconnected is drained. Enabled ONLY when
   `ENGINE_PG_LISTEN_URL` is set; when unset it logs one warning at start and does nothing.
   The connection string is never logged (spec-pinned).
3. **Engine poll** (`handProjection.ts`): `setInterval` every `HAND_PROJECTION_POLL_MS`
   (default 5000) that calls `wakeHandProjection('poll')` only when no drain is running AND
   no causal retry is armed, so it never queues a redundant pass and never collapses the
   250 ms .. 15 s retry backoff to 5 s. One `limit 100` read of an empty outbox is ~3 ms of
   database time. It runs regardless of the listener.
4. **Metrics** on the existing `/metrics` body (`GameServer.ts`):
   - `poker_hand_projection_wakes_total{source}` with sources `local`, `realtime`, `listen`,
     `listen_resync`, `poll`, `startup`;
   - `poker_hand_outbox_listener_enabled`, `_connected`, `_connects_total`,
     `_disconnects_total`, `poker_hand_outbox_notifications_total`,
     `poker_hand_outbox_notification_age_seconds`.
5. The Realtime subscription is KEPT (source `realtime`) until step 2 of the cutover.

Dependencies: `pg` ^8.23 (runtime) and `@types/pg` (dev) in `server/package.json`. `pg` has
no native build step.

## What Dan must set (name only)

`ENGINE_PG_LISTEN_URL` in `/opt/club-arena/server/.env` on the Hetzner engine host (the file
`server/scripts/engine-up.sh` reads as `ENV_FILE`), then restart the engine. The value is the
**Supavisor session-mode pooler** connection string: Supabase Dashboard > Connect >
"Session pooler" (host `aws-N-<region>.pooler.supabase.com`, **port 5432**, user
`postgres.<project-ref>`). NOT the transaction pooler on port 6543 (LISTEN is session-level
and is refused or silently never delivers there), and NOT the direct `db.<ref>.supabase.co`
host (IPv6-only from Hetzner without the IPv4 add-on).

Optional: `ENGINE_PG_LISTEN_CA_FILE` = path to `prod-ca-2021.crt` (Dashboard > Database >
SSL) if the pooler chain is not publicly trusted. Check before cutover with
`openssl s_client -connect <pooler-host>:5432 -starttls postgres </dev/null | head` (no secret
involved). The client runs `rejectUnauthorized: true` either way.

Optional, least privilege: a LISTEN-only login role (`CREATE ROLE engine_outbox_listener LOGIN
... CONNECTION LIMIT 3; REVOKE ALL ON SCHEMA public FROM engine_outbox_listener;`) and use it in
the URL instead of `postgres`. LISTEN needs no object privileges. Not in the migration because a
role's password is set out of band, never in a file.

Until the variable is set: the engine boots, logs
`[HandOutboxListener] ENGINE_PG_LISTEN_URL is not set - LISTEN hand_projection_outbox disabled`
once, and hands flow on local commit wakes + Realtime + the 5 s poll. That is also the
engine-side rollback state.

## Cutover steps (orchestrator)

1. Apply `supabase/migrations/20260910052523_hand_projection_outbox_notifies_its_listener.sql`
   (any time; zero effect until the engine listens). Verify:
   `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.hand_projection_outbox'::regclass AND NOT tgisinternal;`
   shows `a0_finish_hand_post_commit_obligations` and `z9_notify_hand_projection_outbox`.
2. Set `ENGINE_PG_LISTEN_URL` on Hetzner (above).
3. Deploy this branch on the normal :55 cycle. Both wake paths live.
4. Watch `/metrics` over one full hour of hands:
   - `poker_hand_outbox_listener_connected 1`, `poker_hand_outbox_listener_disconnects_total`
     not climbing;
   - `poker_hand_projection_wakes_total{source="listen"}` >= `{source="realtime"}`, both
     tracking `poker_hands_total`;
   - `{source="poll"}` small (~12/min when idle, near zero under load);
   - `pg_stat_activity` shows one `client backend` whose `application_name` starts
     `club-arena-engine-outbox-listener` (through the pooler it appears under the pooler's
     user).
5. **DB step 2, by hand, at a :55 or another quiet moment** (DDL: one ~28 s PostgREST reload):
   `ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_projection_outbox;`
   The engine logs one `CHANNEL_ERROR`/`CLOSED` for the Realtime channel (expected) and keeps
   running on LISTEN + local wakes + poll. Verify within 10 min: `realtime.subscription` no
   longer lists the outbox; the poller's `mean_exec_time` in `pg_stat_statements` drops from
   ~57 ms toward single digits; `n_tup_del` on the outbox keeps pace with `n_tup_ins`.
6. Cleanup deploy (next :55, separate branch): delete the `supabase.channel(...)` block and the
   `removeChannel` branch in `handProjection.ts`, drop `'realtime'` from
   `HandProjectionWakeSource`.

## Verification query (after step 1, before and after step 2)

```sql
-- The trigger exists and fires: a NOTIFY per insert is visible to any LISTENing session.
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgrelid = 'public.hand_projection_outbox'::regclass AND NOT tgisinternal;

-- The listener is connected (one row) and how long it has been idle.
SELECT application_name, state, now() - state_change AS idle_for
  FROM pg_stat_activity
 WHERE application_name LIKE 'club-arena-engine-outbox-listener%';

-- The drain keeps pace (compare trend, not absolute: the outbox was 64k deep on
-- 2026-09-10 for the throughput reason in the workstream D notes, unrelated to wakes).
SELECT n_tup_ins, n_tup_del, n_live_tup FROM pg_stat_user_tables
 WHERE relname = 'hand_projection_outbox';
```

## Rollback

- Engine: unset `ENGINE_PG_LISTEN_URL` (listener disables itself, warns once) or redeploy the
  previous image. The 5 s poll and local wakes alone are sufficient for correctness.
- DB step 2: `ALTER PUBLICATION supabase_realtime ADD TABLE public.hand_projection_outbox;`
- DB step 1: `DROP TRIGGER IF EXISTS z9_notify_hand_projection_outbox ON public.hand_projection_outbox;
DROP FUNCTION IF EXISTS public.trg_notify_hand_projection_outbox();` Nothing existing was
  redefined.

## How verified

- `cd server && npx tsc --noEmit`: clean.
- `npx vitest run src/services/supabase/handProjection.test.ts src/services/supabase/handOutboxListener.test.ts`:
  24 passed (16 + 8). The listener spec uses a fake `pg` client (an EventEmitter): notification
  -> `wake('listen')`; error/end -> reconnect at 500, then 1000, 2000 ms with the attempt
  counter reset on success; failed connect -> retry; failed heartbeat -> reconnect; `stop()`
  cancels timers and ignores late errors; empty URL -> no client, one warning; the connection
  string appears in no log line, error or metric. The projection spec pins the poll to fire
  only when `drainPromise` is null and no retry is armed, and that six consecutive failures
  (250 ms .. 8 s backoff, 15.75 s total) see zero poll wakes.
- The prior spec `contains no periodic polling loop` pinned the old no-poll design; it is
  replaced in the same commit by `the 5 s safety poll is the only interval and it yields to a
running drain and an armed retry`.
- No database change was applied. No credential is in the branch; `.env.example` gains the
  variable names with empty values.

## What this does not fix

The outbox was 64,485 rows deep at 03:09 because the serial drain (one PostgREST round-trip per
hand, ~195 ms wall) runs at ~300 hands/min against a daytime arrival of ~600/min. NOTIFY neither
helps nor hurts that; the drain could run one chain per `table_id` concurrently (the database
already serialises per table with an advisory lock). Separate work.
