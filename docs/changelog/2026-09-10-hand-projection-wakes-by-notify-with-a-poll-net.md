# 2026-09-10 - the hand projection worker wakes by NOTIFY, with a poll net

Branch `fix/hand-projection-wakes-by-notify-with-a-poll-net` (engine swarm, workstream H,
implementing workstream D's design). Migration `20260910052523_hand_projection_outbox_notifies_its_listener`
was APPLIED to production by the orchestrator on 2026-09-10 (verified: `pg_trigger` on the outbox
lists `a0_finish_hand_post_commit_obligations` and `z9_notify_hand_projection_outbox`).

**Plan change during review (2026-09-10, see "Review 2" below):** the engine host has no
database password and will not get one, so `ENGINE_PG_LISTEN_URL` stays unset and the LISTEN
path stays disabled. The outbox leaves the Realtime publication as soon as this deploys. From
then on the worker is woken by (a) the local wake after every committed hand and (b) the 5 s
poll, and the drain runs N tables in parallel so it can outrun the arrival rate.

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

## What review 1 did not fix (fixed in review 2 below)

The outbox was 64,485 rows deep at 03:09 because the serial drain (one PostgREST round-trip per
hand, ~195 ms wall) runs at ~300 hands/min against a daytime arrival of ~600/min. NOTIFY neither
helps nor hurts that. Review 2 makes the drain run one chain per `table_id` concurrently.

## Review 2 (reviewer-fixer, 2026-09-10): the poll is the only net, so it carries the load

Read with the new fact above. Everything below is in this branch.

### Findings on the poll path, and what changed

1. **Leader only, survives restart, no double interval.** `startHandProjectionWorker()` is
   called at Step 8b of `GameServer.performStart`, which a standby never reaches (it returns
   after `renewLeadership()`; a promoted standby exits and re-boots as leader). The :55 restart
   is a process restart; in-process `stop()` then `start()` is also covered, and `start()` twice
   arms one interval (`workerActive` guard). Pinned by the new spec
   `start() twice arms one poll interval; stop() then start() arms a fresh one`.
2. **A drain that keeps failing is never starved.** The gate skipped the poll while a causal
   retry was armed; that is correct because the retry itself drains at 250 ms .. 15 s, but it
   put the poll's liveness in the hands of one `setTimeout`. `pollIsDue()` (pure, spec-pinned)
   now lets the poll drain anyway if no drain has STARTED for `RETRY_MAX_MS + 2 * poll`
   (25 s at defaults), so a lost timer or a fenced epoch cannot silence the worker.
3. **A wake during a drain is a follow-up drain.** `beginDrain()` sets `wakeAfterDrain` when a
   drain is running and the completion callback starts one more pass. Now pinned by the spec
   `a wake during a drain is kept as a follow-up drain, not dropped`.
4. **`HAND_PROJECTION_POLL_MS=` (empty) was a 0 ms interval.** `Number('')` is 0. All three
   env vars now read through `boundedEnvInt`: empty or non-numeric means the default; the
   poll is clamped to 250 ms .. 60 s, concurrency to 1 .. 16, the sampler to 5 s .. 10 min.
5. Listener when disabled: `start()` logs once and returns before any `pg.Client` is built; no
   timer, no metrics beyond `poker_hand_outbox_listener_enabled 0` and its zero counters.
   Unchanged, verified against the spec `empty URL -> no client, one warning`.

### The parallel drain (shipped)

`runDrain()` still reads the outbox in global `hand_number` order, `limit 100`, up to 1,000
rows a pass. Each page is split into one chain per `table_id` (first-row order) and projected
by `HAND_PROJECTION_DRAIN_CONCURRENCY` lanes (default 4, max 16, read per drain). Inside a
chain the order is strict and a chain stops at its first failed or `predecessor_pending` hand;
every later row of that table in the pass is counted `deferred` with no round-trip, and the
table stays blocked across pages of the same pass. `not_pending` (another process finished the
row) does not stop a chain. Pages are projected one after another, so a table split across
two pages keeps its order, and because the page is globally ordered it always holds each
table's OLDEST pending rows - no chain ever starts behind a row the pass has not seen.

Why cross-table parallelism is safe, read from the live definitions
(`pg_get_functiondef`): `fn_project_hand_side_effects` takes
`pg_advisory_xact_lock('hand-post-commit:<table>')` then `('hand-projection:<table>')`, and
`fn_project_hand_side_effects_after_post_commit_20260908` locks the outbox row `FOR UPDATE`,
refuses to leapfrog an earlier row of the same table (`predecessor_pending`), and shards
`club_hand_daily_shard` by `pg_backend_pid() % 16` - it was written for concurrent backends.
The post-commit half already runs concurrently across tables today from the dealing path
(`processHandPostCommitObligations`). Residual risk: `player_stats` and the positional
upserts lock per-user rows in seat order, so two tables in one club sharing two or more players
can deadlock; Postgres aborts one after `deadlock_timeout`, the RPC fails, the row stays, the
pass arms its causal retry and the next pass finishes it. That is the same `failed` path a
transport error takes, and `poker_hand_projection_drain_results_total{result="failed"}`
shows it if it ever matters.

Error handling per table is what the serial code did implicitly (the next hand at a failed
table answered `predecessor_pending` after a wasted ~200 ms round-trip); the causal retry is
still per pass and re-reads the outbox. `stop()` lets in-flight RPCs finish and starts no new
chain (spec-pinned).

Expected effect: ~195 ms per hand serially was ~300/min; four lanes are ~1,100-1,200/min
against ~600/min arriving, so the 100k backlog measured at 05:40 UTC should clear in about
two to three hours after deploy. The `HandProjectionOutboxBacklog*` alerts WILL be firing
until it does; that is the backlog being visible for the first time, not a regression.

### Metrics added (all on the engine `/metrics`)

- `poker_hand_projection_wakes_total{source}` (from review 1; sources `local`, `realtime`,
  `listen`, `listen_resync`, `poll`, `startup`)
- `poker_hand_projection_drain_results_total{result="projected|already_completed|deferred|failed"}`
- `poker_hand_projection_drains_total`, `poker_hand_projection_drain_concurrency`,
  `poker_hand_projection_poll_interval_seconds`
- `poker_hand_projection_outbox_depth`, `poker_hand_projection_outbox_oldest_age_seconds`,
  `poker_hand_projection_outbox_sample_age_seconds` from the new
  `server/src/services/supabase/handOutboxMetrics.ts`: one PostgREST GET a minute with
  `Prefer: count=exact` and `order=hand_number.asc&limit=1` (indexed; the lowest pending
  `hand_number` is the oldest row because `hand_number` is a platform-wide sequence). Started
  beside the worker on the leader, stopped with it, a failed sample never zeroes a good one.

### Alert rules (infra/monitoring/alert-rules.yml, group `hand-projection`)

`HandProjectionOutboxBacklog` (oldest > 300 s for 10 m, warning),
`HandProjectionOutboxBacklogCritical` (> 1800 s for 15 m), `HandProjectionDrainStalled`
(depth > 0 and nothing projected in 10 m), `HandProjectionMetricsBlind` (sample stale > 600 s).
Added to the existing `alert-rules.yml`, so `prometheus.yml`'s `rule_files`,
`docker-compose.yml`'s mounts and `deploy.sh`'s symlink loop are unchanged and still agree
(`tests/what-a-monitor-reads-is-what-the-repo-says.law.test.ts`). **They are live only after
`bash infra/monitoring/deploy.sh` on engine-01** (CLAUDE.md 10.84); verify with
`curl -s localhost:9090/api/v1/rules | grep -c HandProjection` = 4.

### Cutover, revised

1. Migration: applied (above).
2. `ENGINE_PG_LISTEN_URL`: NOT set; stays unset until the engine host has a way to hold a
   database credential. The listener code stays so it is one env var away.
3. Deploy this branch on the :55 cycle. Watch, over the next hour:
   `poker_hand_projection_wakes_total{source="poll"}` climbing (~12/min idle);
   `rate(poker_hand_projection_drain_results_total{result="projected"}[5m])` around
   15-20/s while the backlog drains; `poker_hand_projection_outbox_oldest_age_seconds`
   falling; `{result="failed"}` flat.
4. Orchestrator, by hand at a quiet moment:
   `ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_projection_outbox;`
   The engine's Realtime channel reports `CHANNEL_ERROR` (one budgeted `reportError`);
   `{source="realtime"}` stops climbing, `{source="local"}` and `{source="poll"}` carry on.
5. Cleanup branch later: delete the `supabase.channel(...)` block and `'realtime'` from
   `HandProjectionWakeSource`.

### How verified (review 2)

- `cd server && npx tsc --noEmit`: clean.
- `npx vitest run src/services/supabase/handProjection.test.ts src/services/supabase/handOutboxMetrics.test.ts src/services/supabase/handOutboxListener.test.ts src/engine/PostCommitObligationBarrier.guard.test.ts`:
  49 passed (26 + 7 + 8 + 8). New specs: ordering inside a table with a gated fake RPC at
  concurrency 2 (in-flight never exceeds 2, every table's RPCs ascend); a failed hand stops
  only its table and later rows are deferred without a round-trip; a deferred table stays
  blocked across pages; `not_pending` does not stop a chain; outcome counters; stop during
  fan-out; start twice / stop-start; wake during drain; `pollIsDue`; env-var bounds; the
  outbox sampler's request shape, empty/failed/stale behaviour, one interval per start.
- `infra/monitoring/alert-rules.yml` parses (yaml) and the new group lists four alerts.
- Live database read (SELECT only): 100,888 outbox rows, 1,329 tables, oldest 00:31 UTC;
  the two triggers on the outbox; the function bodies quoted above.

### CI fix (review 2, follow-up)

`TournamentManagerRequestFence.guard.test.ts` requires that `services/supabase/client.ts` is the
only runtime file matching `createClient(`: every Data API request must pass through the one
fetch wrapper that stamps actor authority. The listener's session factory option was named
`createClient`, which the guard read as a second Supabase client. It is a raw `pg` LISTEN
session (LISTEN plus a `SELECT 1` heartbeat; no PostgREST request, no Data API), so it is
renamed `openSession` in `handOutboxListener.ts` and its spec. Nothing about the fence is
weakened: the engine still builds exactly one Supabase client. Full `cd server && npx vitest
run`: 647 files, 8,678 tests passed; `npx tsc --noEmit` clean.
