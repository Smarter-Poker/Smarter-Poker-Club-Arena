# Realtime write amplification: what shipped, and what I refused to build

2026-09-04 · branch `docs/sentry-realtime-programme`

Dan asked for all five items in `docs/SENTRY-AND-REALTIME-PROGRAMME.md` section 3
to be built, wired in and tested — and for anything I judged high risk to code or
to other pages to be left alone. Three shipped. Four are declined in writing at
the bottom, with the evidence for each refusal, because "not built" with no
reason is indistinguishable from "forgotten".

---

## THE MEASUREMENT THAT CHANGED THE PLAN

Both handoffs, and my own first pass, blamed the wrong things. Measured against
production today:

|                   |                                   |
| ----------------- | --------------------------------- |
| Slot lag at 09:15 | 136 MB restart / 104 MB flush     |
| Slot lag at 10:30 | **703 MB restart / 305 MB flush** |

It is not stable and it is not linear. That is the spiral the programme
describes: a slot that falls behind reads WAL from disk rather than memory,
which is slower, so being behind makes it fall further behind.

The two things actually driving it, neither of which cares whether a horse or a
human sat in the seat:

1. **In-place updates of very large rows.** `hand_state_snapshots` is 7,357 MB,
   1,702 bytes a row, and took **1,209,476 inserts against 2,419,902 updates** —
   two updates per insert, at only 16.5% HOT.
2. **A table nobody prunes.** `ca_settlements` is 1,296 MB, **entirely three days
   old**, with `n_tup_del = 0`. There is no prune for it anywhere — not in
   `cron.job`, not in either repo, not in any migration.

---

## 1. THE SLOT CAN BE SEEN — `20260904103223`

The realtime slot was 136 MB behind and **nothing on the platform could see it**.
The host already runs Prometheus, Grafana, Alertmanager and node-exporter, and
Prometheus already scrapes this engine every 15 seconds. The series simply did
not exist, so the number was only ever discovered by a human opening a SQL editor.

- `public.fn_replication_slot_metrics()` — read-only, `service_role` only.
  The engine has no direct Postgres connection (everything goes through
  PostgREST), so a `SECURITY DEFINER` function is the only route to
  `pg_replication_slots`.
- `server/src/services/ReplicationMetrics.ts` — its **own** collector, on the
  house pattern (60 s refresh, cached render, `stale_seconds` companion,
  report-once-per-outage). Deliberately not folded into `fn_spin_metrics`:
  `service_role` has an 8 s statement timeout, and a slow catalog read must
  never be able to blind the spin fairness gauges, or be blinded by them.
- Six gauges, one per slot where it makes sense:
  `poker_pg_replication_slot_restart_lag_bytes`,
  `..._flush_lag_bytes`, `..._active`, `poker_pg_replication_slots`,
  `poker_pg_wal_position_bytes`, `poker_pg_replication_metrics_stale_seconds`.
- Five alert rules appended to `infra/monitoring/alert-rules.yml` (an existing
  file, so `check-monitoring-drift.mjs` stays satisfied without touching
  `prometheus.yml` and `docker-compose.yml`). The two that could fire during the
  scheduled stop carry `unless max_over_time(poker_maintenance_break_active[6m]) == 1`.

A lag reading that is unavailable is **absent, never zero** — zero bytes of lag
is the perfect score, and a collector that reports perfect health while blind is
worse than no collector.

**Verified end to end:** applied to production; called through PostgREST as
`service_role`, exactly as the engine calls it, returning real slot lag; called
as `anon` and correctly refused with `42501 permission denied`. 9 unit tests.

## 2. THE HAND SNAPSHOT IS WRITTEN ONCE, NOT TWICE — `20260904103243`

`saveSnapshot()` inserted the snapshot row and then, four lines later in the same
function body, issued a second statement against the row it had just inserted, to
fill in two columns it already had in hand. From `pg_stat_statements`:

```
save_hand_state_snapshot  (the upsert)              1,210,799 calls
UPDATE ... pending_deadlines, disconnect_states     1,210,782 calls
complete_hand_snapshot    (settlement)              1,209,663 calls
```

1,210,782 + 1,209,663 = 2,420,445 ≈ the 2.42M measured updates. The arithmetic
closes exactly. Postgres writes a whole new ~1.7 KB heap tuple however few
columns you name, and at 16.5% HOT roughly 83% of them also rewrote all three
indexes.

Folded into one statement. **This removes ~1.2 million row versions per stats
window from the largest table in the database**, and the row that lands is
byte-identical to the row that lands today.

Why it is safe, specifically: the only reader of those two columns is
`getActiveHandSnapshotFull` at engine start, which today can catch the row in the
window between the INSERT and the UPDATE and read empty defaults — after this it
cannot, so it strictly gains information. `TournamentManager.waitForHandComplete`
reads only `id`. And a snapshot cannot rebuild a hand in flight and is not meant
to: `checkCrashRecovery` restores the disconnect FSM and then **abandons** the
hand, the deck is stripped before the row is ever written, and
`RestartFidelity.test.ts` pins that as deliberate. Hands in flight are protected
by `GameServer.drainHands()`, not by this table.

**Deploy order is handled and was proven against production.** The two new
parameters are defaulted and `COALESCE`d to the column defaults, so the engine
currently running — which passes seven arguments and then issues its own UPDATE —
keeps working unchanged. After applying the migration the live engine wrote
**597 snapshots in the following 60 seconds**, most recent 0 seconds old. The
saving arrives when the engine ships at the next `:55` break. Neither order breaks.

The old seven-argument signature is dropped rather than left beside the new one,
because `CREATE OR REPLACE` with a different argument list creates an **overload**
and PostgREST refuses an ambiguous overload — which would have stopped every
snapshot write on the platform. The migration asserts exactly one overload exists
afterwards.

## 3. `ca_settlements` IS PRUNED — `20260904103233`

1,296 MB, 1,777,140 rows, **all of it three days old**, `n_tup_del = 0`. At
~430 MB/day it passes `hand_state_snapshots` as the largest table on the instance
inside three weeks, and every one of those rows is also WAL for a slot that is
already struggling to keep up.

`sp_prune_ca_settlements(p_batch, p_retain_days = 30)` plus the pg_cron job
`sp_prune_ca_settlements_10m`, batched and advisory-locked exactly like the six
prunes already running here.

What it will never delete:

- **`state = 'failed'` — 137,409 rows in three days.** See the finding below.
  That is evidence of an open defect and it is worth more than the disk it sits
  on; a retention job must not quietly sweep it away while somebody is still
  working out what it means.
- Any row not yet `final` — that is a settlement still in progress.

It refuses a retention window under 7 days rather than obeying it, and returns 0
without touching anything while `fn_platform_frozen()` is true. It is scheduled
at `7,17,27,37,47` so it never collides with the `:55` break.

This is **not** a money edit. The 6.9M `ca_settlements` updates move no chips —
they are the audit breadcrumbs of the state machine; the chip movement is
`UPDATE table_seats SET stack` in the same function. This prune runs entirely
outside that transaction, on its own schedule. Verified before writing it: zero
inbound and outbound foreign keys, not in the realtime publication, no view
references it, and of the six functions that touch it none reads a historical row
(`fn_ca_midway_burnin_gate` reads `WHERE updated_at > v_since` — a window of
minutes).

The migration asserts the prune deletes **zero** rows on install, because nothing
in the table is 30 days old yet. A prune that removed rows on the day it shipped
would mean the window was wrong.

## 4. Already shipped earlier today — `20260904101140`

`ca_hand_player_idx` (3,872 MB, 4,488,677 inserts) was in the `supabase_realtime`
publication with **zero subscribers, ever**. Unpublished. 113 → 112 tables.

---

## TESTS

`server`: **94 files, 1,078 tests, all passing**, including `RestartFidelity`,
`EngineStartResilience` and `DisconnectEngine`. `npx tsc --noEmit` clean.

Both new suites were proven to fail against the broken version, not just to pass
against the fixed one:

- Reverting the omit-on-null guard in `ReplicationMetrics` so a missing reading
  renders as `0` fails **"OMITS a lag series rather than reporting zero when
  there is no reading"** — 1 failed, 8 passed. Restored: 9 passed.
- `HandSnapshotIsWrittenOnce` asserts the engine contains no
  `saveHandSnapshotExtras` and exactly one `saveHandStateSnapshot(` call, which
  is false of the previous code by construction.

---

## NOT BUILT, AND WHY

### Partitioning — declined for every table proposed

The programme listed this as the second-biggest win. On inspection it is a trap
on five of the six tables, and pointless on the sixth:

- **`hand_state_snapshots`** carries `UNIQUE (table_id) WHERE is_complete = false`
  — a **partial unique index Postgres cannot enforce across partitions**. That
  index _is_ the invariant "one live snapshot per table", the thing that stops
  the engine resurrecting a stale hand. Losing it is a correctness failure on the
  live hand path, not a performance regression. This table has already stalled
  the whole instance once (2026-08-22).
- **`ca_hand_player_stat`**: the PK is `(user_id, hand_id)` and excludes
  `created_at`, so partitioning forces the PK to widen and **breaks
  `ON CONFLICT (user_id, hand_id) DO NOTHING`** — the dedupe that keeps the
  forward roll idempotent. That is silent double-counted player statistics. And
  its retention is a per-user top-1000, not a date, so no partition would ever be
  droppable: all of the risk, none of the prize.
- **`table_hole_cards`**: in the realtime publication, a unique constraint the
  upsert depends on that excludes the time column, and four RLS policies guarding
  other players' hole cards — for a **20 MB** table whose 24-hour prune already
  works perfectly. Highest blast radius, lowest reward of anything here.
  Unpublishing this table once cost every player their hole cards for four hours.
- **`ca_hand_player_idx`**: PK excludes `created_at`, and the prune deletes by
  `hand_id = any(...)` following its parent, so partition pruning would never
  apply to the delete.
- **`ca_club_tournament_player_daily`** is the one table where partitioning is
  genuinely safe — `stat_date` is already in the PK, no FKs, no policies, not
  published. It is also 156 MB, so it would be cosmetic.

### `ca_club_tournament_player_daily` — the real bug is a trigger, and I left it

8,435,668 deletes against 1,034,590 lifetime inserts. You cannot delete eight
times what you inserted unless the same rows are deleted and re-inserted
repeatedly — and they are: `ca_reporting_wallet_change` and
`ca_reporting_rake_change` are **`FOR EACH ROW`** triggers on `wallet_transactions`
and `rake_records` that each fire a whole-day delete-and-recompute. Update N rows
for one day and you get N complete rebuilds of that day.

Making them statement-level would remove ~99.9% of that churn. I did not do it:
they are triggers on two money tables, the output is user-visible Club Data
reporting, and the advisory lock they take on every fire is currently hiding
whatever ordering assumptions the rebuild makes. That is a change that needs its
own PR and its own proof, not a rider on this one.

### `daily_challenge_event_outbox` — 4M insert/delete pairs, and I left it alone

`enqueue_daily_challenge_event` inserts a row and deletes it **in the same
transaction** on the happy path: ~4M rows of WAL, index churn and dead tuples for
rows that were never visible to anything. The fix is one an outbox is supposed to
have — only write the row when the inline call fails.

I am not touching it. This is the exact function PR #2913 broke eight hours ago,
the revert Dan wrote _"daily challenges should be done by horses"_ on. Mission
progress is subtle, it is horse-sensitive, and the failure mode is silent. It
deserves a dedicated change with someone watching the enqueue rate, not a
paragraph in a performance PR.

### Broadcast migration — declined as scoped

148 `postgres_changes` call sites against 17 broadcast ones. This is the right
structural fix and it is a refactor of the realtime layer for the entire
application. It cannot be done safely as part of anything else.

### `settlement_idempotency_keys.result` — declined

404 MB of cached settlement payloads, 0% HOT updates, and zero replays have ever
occurred (`max(attempt_count) = 1` across 1.78M settlements). Nulling the old
payloads is tempting and probably safe. It is also a money path's idempotency
cache, and I could not establish from the code what a caller does when a replay
returns a NULL result. Not on a guess.

---

## TWO FINDINGS THAT ARE NOT MINE TO FIX

**1. 137,409 failed settlements in three days — a 7.7% hand-settlement failure
rate.** Every row carries its own `error_detail`: `conservation violation`,
`seat missing or left`, `seat write failed`. This is sitting in plain sight in
`ca_settlements` and it is more urgent than anything in this changelog. The prune
above deliberately cannot delete these.

**2. `ca_noop_update_stats` and `fn_skip_noop_update` exist in production with no
migration in this repo.** Someone diagnosed a no-op update storm on `table_seats`
(330,623 suppressed since 2026-09-03) and applied the fix straight to the
database. It works, and a Midway master reset rebuilt from these files would not
have it.

Also: `sp_sweep_ca_hand_player_idx_orphans` exists, is granted, and is scheduled
nowhere. Either wire it up or delete it.
