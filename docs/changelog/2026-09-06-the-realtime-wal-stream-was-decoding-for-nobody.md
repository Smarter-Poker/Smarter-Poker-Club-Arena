# The Realtime WAL stream was decoding for nobody

Date: 2026-09-06
Branch: `fix/realtime-wal-lag-root-cause`

**Dan:** "we need to fully fix and get to the root cause of the issues we're
having with the lagging Realtime WAL stream. do a deep dive and find out any
and all issues we're having, get to the root cause and fix any and all issues
so they stop happening."

## The one number that explains it

Supabase Realtime reads every change on every published table through **one
single-threaded poller**: `realtime.list_changes` -> wal2json -> `apply_rls`
per change. Probed against live WAL with a temporary replication slot, the
changes fully materialised first so no lazy-evaluation artefact could distort
the split:

```
15 seconds of WAL, 27 MB, 1,643 published row changes
  wal2json decode of all of them              4,735 ms
  apply_rls, summed over every table         18,146 ms
  ------------------------------------------------------
  TOTAL                                      22,881 ms
```

**22.9 seconds of database time to process 15 seconds of WAL.** One thread
cannot do that. The slot falls behind, and a logical slot that is behind must
read WAL from disk instead of memory, which is slower, so being behind makes it
fall further behind. There is no cliff to notice — which is why this was only
ever found by opening a SQL editor. Since the 09-02 stats reset the poller had
burned 220,823 seconds of database time across 823,737 calls: 68% of one core,
continuously.

Cost tracks **column count**, because `apply_rls` runs roughly one dynamic cast
plus one column-privilege check per column per change, and rebuilds the output
object from `pg_attribute` per delivery:

| table              | changes | ms/change |    ms | cols | replica identity |
| ------------------ | ------: | --------: | ----: | ---: | ---------------- |
| `tables`           |     221 |     28.40 | 6,277 |  154 | default          |
| `tournaments`      |      62 |     39.40 | 2,443 |  110 | **FULL** (x2)    |
| `table_seats`      |     362 |      5.22 | 1,891 |   22 | default          |
| `table_hole_cards` |     571 |      3.30 | 1,883 |    7 | default          |
| `clubs`            |      49 |     35.96 | 1,762 |   92 | default          |
| `profiles`         |      14 |     45.29 |   634 |  120 | default          |

## What was actually wrong, and what was done about each

Every item below removes a cause. None of them is a detector.

### 1. A third of everything decoded was delivered to nobody

`table_hole_cards` was 571 of 1,643 changes — 35% of all decode work — with
`delivered: 0`. Not "few subscribers": none.

The hero's cards have reached the felt on the **engine socket** since PR #3032
(live 2026-09-05 00:55 UTC), sent _before_ the database write and re-pushed on
every SUBSCRIBE, with the bounded recovery poll behind that. The row is still
written and still read by the poll; it just stopped being decoded and
RLS-checked for an audience of zero.

**This is not the 2026-08-31 trim**, which removed the same table while the
Realtime row push was the _only_ delivery path and blinded every table for four
hours. That migration wrote down the precondition for doing it properly —
"deliver hole cards as a private frame on the engine socket the player already
holds and then drop this table from realtime for good" — and #3032 is that
change. Verified before touching it: the engine calls `onResync` on **every**
SUBSCRIBE (first connect, reconnect and mux join), not just on an explicit
RESYNC frame, so a mid-hand reconnect re-pushes the cards. Three independent
paths remain; the fourth is the one that cost 35% of the poller.

The client subscription is removed in the same change, so no dead channel is
left erroring against an unpublished table.

### 2. `tournaments` was paying for its 110 columns twice

`REPLICA IDENTITY FULL` logs the whole old row on every UPDATE, so `apply_rls`
cast and privilege-checked 110 columns **twice** — which is why it was the most
expensive row on the platform at 39.4 ms despite being narrower than `tables`.
Nothing reads `payload.old` beyond the primary key (the only `.old` access on
this table in either repo is `payload.old.id` on DELETE), and the table has
taken zero deletes since the stats reset, which the migration asserts. Now
DEFAULT: **39.40 -> 24.25 ms/change.**

`20260905161915` had already done this for every published table that happened
to have no subscriber at the instant it ran; `tournaments` had one, so it was
skipped. This finished the one that pays.

### 3. The per-hand recount wrote a number the row already held

`updateTableStatus` is the authoritative seat recount at the end of every hand.
It wrote unconditionally: **1,604,259 calls**, each producing a heap tuple, a
WAL record, index entries, two AFTER-UPDATE triggers and a decode of the
**widest published table on the platform**.

Measured across all 472 open tables:

- `current_players` already equalled the live seat count on **468**
- `status` already agreed on **445**
- **93.4% of recounts would write nothing at all**

Fixed with the same filter shape as the time bank (2026-09-02), for the same
reasons: `tableCountChangedFilter`. It is a **filter, not an in-memory diff** —
no cache to go stale, correct across an engine restart and against a concurrent
writer, because the comparison happens inside the UPDATE against the current
row. A recount that genuinely moved still writes exactly as before.

This is the largest single remaining line (6,277 ms per 15 s) and it is fixed
in the engine, not the database, so it lands with this deploy rather than with
the migration.

While there: `processLeavePending` had the same unchecked-count bug that
settlement was fixed for on 2026-08-28 — `count || 0` on an undestructured
error, so one failed read wrote `current_players = 0` on a live table. A count
that cannot be read is now UNKNOWN, and the row is left alone.

### 4. The engine was over the Realtime channel cap, permanently

One engine process holds **one** Realtime socket, and a socket caps at **100
channels**. The engine was opening one channel per bomb-pot table (76) _and_
one per live tournament (425):

**123,219 `ChannelRateLimitReached: Too many channels` in 24 hours** — about
1.4 every second, continuously, every one retried. Past the cap those joins did
not exist, so an unknown share of bomb-pot tables were not listening at all —
the feature the channel existed for was silently degraded on the tables it was
meant to serve.

It also cost the thing this whole change is about: Realtime runs the channel
layer and the WAL poller in the **same Elixir node**, so a rejected-join loop at
1.4/s was CPU taken from a poller that already could not keep up.

Two fixes:

- **Tournament broadcasts stop joining anything.** The engine only ever _speaks_
  on `t-break-<id>`; it never listens. It now uses `httpSend`, which posts to
  Realtime's REST endpoint — the same transport `send()` was already silently
  falling back to (those are the "Sent 202" lines in the Realtime log), asked
  for explicitly instead of through a path the library warns is deprecated.
  Verified against the installed `realtime-js` that the body shape is identical,
  so **the client contract is unchanged**: clients still subscribe to
  `t-break-<tournamentId>` and still receive `tournament_event` shaped
  `{ type, payload }`. 425 channels become 0.
- **Bomb requests share one channel.** `engine:bomb-requests`, opened once and
  dispatched by `payload.table_id` (`server/src/services/BombRequestBus.ts`).
  76 channels become 1. The database half announces on the new topic; in the
  window before the engine deploys, requests arrive through
  `tables.bomb_pot_manual_pending` instead, which is exactly why that column
  exists.

### 5. A temp table every five seconds, and a log full of it

`fn_aggregate_gto_v31_next` created a temp table, indexed it, commented a column
on it and dropped it **on every call** — 648 calls and ~11 temp tables a minute
in the hour before the migration. Each one is DDL, and DDL broadcasts relcache
and syscache invalidations to **every** backend, the poller's connection
included, where they discard the very plans `apply_rls` re-prepares per change.
Now created once per session (`ON COMMIT DELETE ROWS`) and emptied per call.

The body was **patched in place from the catalogue** rather than retyped, so
nothing but the two scratch-table lines could drift.

`ca_ddl_events` had become 97% noise from this: **349,953 of 359,842 rows, 172
MB**, burying the DDL that matters. The event triggers now ignore `pg_temp` and
the existing rows are pruned.

`ca_rebuild_table_chunk` has the same shape (3,175 temp tables in three hours on
09-04) and was **deliberately left alone**: its backfill has finished, it
produced zero DDL events in the hour before this change, and its `CREATE TABLE
AS` form cannot be corrected by a string replace. Hand-retyping 150 lines of
live chip-attribution arithmetic to save nothing today is the wrong trade. It is
the next one to do, and it needs the scratch table declared with explicit column
types.

## Where I was wrong, recorded because it matters

The migration also converted six RLS helper functions from PL/pgSQL to
`LANGUAGE sql`, to take them off the nested-PL/pgSQL path that trips
`plpgsql_check`'s pldbgapi2 statement stack inside `apply_rls` — a bug that
crashed the poller **21 times in 24 hours**, and each crash can drop the
temporary slot and lose every change until it restarts.

Then a probe showed `tables` rising from 28.40 to 42.88 ms/change, and I
reverted the two invoker helpers on the theory that dropping their
`SET search_path` had made them inlinable into the RLS policy.

**The plan says that theory was wrong:**

```
Index Scan using tables_pkey on tables (actual rows=1)
  Filter: (NOT COALESCE(is_private,false)) OR (club_id IS NULL)
          OR is_club_member(club_id, ...) OR EXISTS(SubPlan 3)
          OR fn_union_oversees_club(club_id, ...)
  ... every later branch: (never executed)
Planning Time:  2.236 ms
Execution Time: 0.134 ms
```

`is_club_member` appears as a **call**, not inlined. The policy short-circuits
on the first branch. Execution is 0.134 ms. The real per-change cost of a
`tables` change is **planning** — `apply_rls` DEALLOCATEs and re-PREPAREs
`walrus_rls_stmt` for every change — and the language of the helper does not
change that. The 42.88 ms reading was live-load variance between two windows
taken minutes apart, not a regression I had caused.

The revert stands anyway, on the narrower and honest ground that the
conservative form is right on the hottest path in the database when the
alternative buys nothing measurable. The four SECURITY DEFINER helpers keep the
SQL form: they can never be inlined, and they are the ones that take our code
off the crash path. `table_seats` (5.22 -> 2.22 ms/change) and `profiles`
(45.29 -> 10.11) are the measured benefit.

**The lesson, which is now a rule in the migration header:** a function an RLS
policy calls must not be made inlinable without measuring that policy
afterwards — and measuring means reading the plan, not a timing loop against a
live database whose load moves underneath you.

## Proving the rewrites before applying them

All six helper rewrites were checked against the originals **inline, with no
DDL**, across 1,316 real cases drawn from production — active members, lapsed
members, club owners, union owners and admins, agents with downlines,
self-referential pairs and all-NULL arguments:

```
666 (club,user) pairs      is_club_member 0 mismatches   is_club_admin 0
                           fn_is_union_overseer 0        fn_union_oversees_club 0
650 (club,actor,target)    fn_club_is_in_downline 0      fn_club_cashier_can_transact 0
true answers seen: 402/5/5/3 and 300/450 — not a trivially all-false comparison
```

## Result

Immediately after the migration, same probe:

```
             changes   decode    apply_rls    total
before         1,643   4,735 ms  18,146 ms   22,881 ms
after            925   1,053 ms   8,362 ms    9,415 ms
```

Load was lighter in the second window (13 MB of WAL against 27 MB), so the
honest per-table numbers are the durable part: `table_hole_cards` gone entirely,
`tournaments` 39.40 -> 24.25 ms/change, `table_seats` 5.22 -> 2.22,
`profiles` 45.29 -> 10.11. The `tables` line — the largest one left, and 93.4%
of it avoidable — is removed by the engine change in this pull request, which
has not deployed yet.

## Verification

- Migration `20260906150328` applied to production; its own post-checks assert
  the publication, the replica identity, six helpers on the expected language,
  zero `pg_temp` rows remaining and the new bomb topic.
- Corrective migration `20260906150640` applied, with post-checks.
- `tsc --noEmit` exit 0 for both the client and `server/`.
- 96 tests green across the four touched files.

## Pins

- `server/src/services/supabase/TheRecountWritesOnlyWhatChanged.test.ts` — new,
  8 properties on the filter aimed at the dangerous direction (a filter that
  fails to match when a value HAS changed), plus the two call sites.
- `tests/pineapple-discard-picks-the-right-card.test.ts` — pin **moved** with
  the mechanism: it asserted the hole-card Realtime subscription listened on
  `'*'`; it now asserts the socket frame reaches the same handler, that the
  frame is sent before the write, and that no `table_hole_cards` subscription
  has come back.
- `tests/unit/bombPotGuards.test.ts` — pin **moved**: the broadcast event and
  topic now live in `BombRequestBus`, and the bus must never build a topic from
  a table id.

## Still to do

- `ca_rebuild_table_chunk`'s per-chunk `CREATE TEMP TABLE ... AS` (above).
- `clubs` at ~36 ms/change and 45-68 changes per 15 s, mostly treasury updates
  with 9 of 49 delivered. Worth asking whether the client needs the whole
  92-column row or a narrower published projection.
- The pldbgapi2 poller crash is Supabase's own `apply_rls` calling
  `realtime.cast`; our functions are off that path now, but theirs are not.
  Worth a Supabase support ticket with the 21-crashes-in-24-hours evidence.
