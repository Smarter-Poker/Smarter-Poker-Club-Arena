# Lane A - the SQL cluster lifecycle of must-move games

2026-09-09. Audit of `fn_cash_cluster_tick` and everything around it, read from
the LIVE production bodies (`pg_get_functiondef`) rather than from the repo, and
compared against the newest migration on `origin/main` that defines each one.

Production: `kuklfnapbkmacvwxktbh`, read over psql from the Mac
(`/tmp/laneA/psql.sh`, direct host, `application_name=laneA-audit`). Every probe
is inside `BEGIN ... ROLLBACK`. Nothing was applied.

---

## 1. Coverage - what was read line by line

### Live function bodies (dumped to `/tmp/laneA/live_<name>.sql`)

| function | bytes | md5 (live) |
| --- | --- | --- |
| `fn_cash_cluster_tick(uuid,integer)` | 34,999 | `ae91ea39aef3746371029528cb8e343d` |
| `fn_cash_clusters_tick_all(jsonb)` | 7,143 | `56c15668b184c2d79b79fec3303e363d` |
| `fn_cash_clusters_to_tick()` | 1,293 | `a53afb0f2ad173e6da9fc835c80c2d84` |
| `fn_cash_cluster_census(uuid,timestamptz)` | 1,287 | `e8d7f1befc313c17b2f4eead0b69e442` |
| `fn_cash_cluster_open_table(uuid,text,int,text,uuid)` | 5,385 | `93ba1525ad56ce5d3d5f7421f633952b` |
| `fn_cash_cluster_balance(uuid,timestamptz)` | 3,395 | `2becc9f54f99a12641c1fa4aa888dfcf` |
| `fn_cash_stake_band(numeric)` | 411 | `28c6c970f6095901b3713664573fbdb1` |
| `fn_platform_frozen()` | 393 | `d291f8e063975d28d15ccab131b0c4f2` |
| `fn_entry_purchases_frozen()` | - | read in full |
| `fn_active_maintenance_release_boundary()` | - | read in full |
| `fn_cash_seat_move_execute(uuid)` | 8,511 | `64f02e161035c9d9da50ebeae5b11574` |
| `fn_cash_seat_move_execute_before_maintenance_gate(uuid)` | 6,623 | `fdb0bf744ee0c134e3fb235fd68c903f` |
| `fn_cash_seat_swap_execute(uuid)` | 288 | `f7512a5eff8fb4a6fd7d652326ebe6e4` |
| `fn_cash_seat_swap_execute_before_maintenance_gate(uuid)` | 6,968 | `8d78a8e720c5931c9357dba60a06b1a9` |
| `fn_cash_seat_moves_pending(uuid)`, `fn_cash_seat_move_announce(uuid[])`, `fn_cash_seat_move_window(uuid)`, `fn_cash_seat_move_set_window()` | small | read in full |
| `fn_cash_seat_change_request / _plan / _cancel / _status` | 4,837 / 6,601 / 1,180 / 2,028 | read in full |
| `fn_cash_game_join`, `fn_cash_game_lobby`, `fn_cash_game_must_move_list`, `fn_cash_game_create` | - | read in full |
| `fn_thaw_platform(...)` | 14,524 | cluster steps read line by line |
| `fn_cash_apply_ruleset(uuid)` | 5,799 | read |
| `fn_refuse_seat_on_closed_cluster_table()` | 1,629 | read in full |

### Triggers on `public.tables` and `public.table_seats`

All 30 trigger definitions enumerated. Bodies read in full for the ones that
touch `cluster_id` / `role` / `main_index` / `lifecycle` / `current_players` /
seat identity:

- `tables`: `trg_tables_closed_main_releases_index` (`fn_closed_cluster_main_releases_index`),
  `trg_tables_cluster_table_ceiling` (`fn_cluster_table_ceiling`),
  `zzzz_stamp_table_game_scope` (`fn_stamp_table_game_scope`),
  `zzzz_stamp_table_seat_admission` (`fn_stamp_table_seat_admission`),
  `trg_tables_capture_management_contract`, `trg_tables_auto_cashout_on_close`,
  `trg_on_table_status_change`, `trg_tables_managed_lifecycle_guard`,
  `trg_tables_creation_guard`, `poker_arena_table_guard`.
- `table_seats`: `trg_cash_game_roster_track` (`fn_cash_game_roster_track`),
  `trg_refuse_seat_on_closed_cluster_table` + `trg_refuse_seat_revive_on_closed_cluster_table`,
  `zzzz_stamp_active_seat_game_scope` (`fn_stamp_active_seat_game_scope`),
  `zzzzz_require_live_seat_parent` (`fn_require_live_seat_parent`),
  `trg_enforce_four_table_limit`, `zz_freeze_guard`, `zz_freeze_entry_guard`,
  `zzz_bind_cash_seat_move_occupancy` (on `cash_seat_moves`),
  `zz_cash_seat_move_window` (on `cash_seat_moves`).

### Constraints and indexes read

`table_seats`: `one_committed_seat_per_game_player` UNIQUE `(user_id,
active_game_scope)` DEFERRABLE INITIALLY DEFERRED; `active_seat_game_scope_parent`
FK `(table_id, active_game_scope) -> tables(id, seat_game_scope)`;
`live_seat_parent_cannot_close` FK `(table_id, active_parent_key) ->
tables(id, seat_admission_key)`; `active_seat_requires_open_parent` CHECK;
`idx_unique_active_user_per_table`.
`tables`: `table_game_scope_is_derived`, `table_game_scope_parent_key`,
`table_seat_admission_is_derived`, `table_seat_admission_parent_key`,
`tables_lifecycle_check`, `tables_main_index_check`.
`cash_seat_moves`: `cash_seat_moves_one_pending_per_player` UNIQUE `(player_id)
WHERE state='pending'`, `cash_seat_moves_pending_by_from`.
**There is no uniqueness on `(cluster_id, main_index)`.**

### Engine side (read, not owned by this lane)

`server/src/engine/ServerTableEngineBase.ts` lines 2890-3060
(`announcePendingSeatMoves`, `executePendingSeatMoves`, `heldForSwap`,
`wakeClusterGame`), and the call sites in `ServerTableEngineDealing` /
`ServerTableEngineSettlement` / `server/src/services/supabase/seatMoves.ts`.

### Cron

`select * from cron.job` - **one** job matches `fn_cash*`/`cluster`: jobid 259,
`34 * * * *`, `ca-cash-pot-conservation`. Nothing schedules the cluster tick in
Postgres; the tick is driven only by `ClusterController` on the engine leader.

---

## 2. Live vs repo: which bodies differ, and which is right

**The live `fn_cash_cluster_tick` is AHEAD of `origin/main`, not behind it.**

`origin/main`'s newest file that touches the tick is
`supabase/migrations/20260909035726_status_follows_lifecycle_down_as_well_as_up.sql`
(applied to production as version `20260909035745`, plus a correction
`20260909035821_status_follows_lifecycle_without_stealing_the_row_count`). The
live body contains that block, in the corrected position (below the
`lifecycle_followed_status` `GET DIAGNOSTICS` pair, not between it and its
UPDATE). Live and main agree there.

The live body ALSO contains three edits that exist on **no file on `origin/main`**:

| live text | migration that wrote it | on main? | applied? |
| --- | --- | --- | --- |
| `-- Active seats cannot commit against a closed parent; no reopen repair is needed.` (replaces the whole `closed_table_reopened_to_break` loop) | `20260909062236_terminal_tables_cannot_commit_live_occupancies.sql` | no - only on `origin/codex/club-arena-phase-two-occupancy-contract` | yes, as version `20260909172529` |
| `-- Duplicate committed chairs are rejected by one_committed_seat_per_game_player.` (replaces the second-chair cashout) | `..._retire_cluster_duplicate_chair_cashouts_after_native_ownership.sql` | no - same branch | yes, as `20260909172447` |
| `-- Native committed ownership makes duplicate-chair cashout unnecessary.` (in the break loop) | same | no | yes |
| `source_occupancy_id` / `source_seat_number` binding in `fn_cash_seat_move_execute` | `20260909074353_bind_cash_seat_moves_to_original_occupancies.sql` | no - same branch | yes, as `20260909173145` |

**Which is right: production.** Those migrations are applied and the schema they
depend on is real (`one_committed_seat_per_game_player`,
`live_seat_parent_cannot_close`, `table_seats.occupancy_id`,
`cash_seat_move_receipts` all exist on production). What is wrong is that
`origin/main` cannot reproduce production: the eight-file occupancy-contract
family, plus `ca_a_chair_change_is_not_a_fifth_game`,
`ca_a_tournament_seat_moves_in_one_transaction`,
`ca_stranded_players_come_back_to_the_felt`,
`ca_the_cap_is_at_the_door_not_at_the_chair` and
`maintenance_ownership_fits_process_lifetime` are on production and on a branch
only.

**FINDING A1 (P2, NOT FIXED BY THIS LANE - it is a merge, not a defect).**
122 versions are recorded in `supabase_migrations.schema_migrations` at
`>= 20260908` that have no file on `origin/main`, and 72 files on `origin/main`
at `>= 20260908` are not recorded as applied. Most of the second list is version
renumbering (the same slug applied under a different 14-digit version), which is
benign; the first list contains the occupancy-contract family, which is not.
Any agent who reads `origin/main` to learn what the cluster tick does will read a
body that has not been on production since 17:25 UTC today. Recorded here for
the integrator; merging that branch is out of this lane's scope and must not be
done by rewriting the tick from main (that would revert three applied changes).

Every other function in the table above matches its newest `origin/main`
definition.

---

## 3. Board state, measured

```
 status  | lifecycle |  role  | count | seats
---------+-----------+--------+-------+-------
 closed  | closed    | feeder |  1311 |     0
 closed  | closed    | main   |  3064 |     0
 running | live      | feeder |    16 |    74
 running | live      | main   |    52 |   219
 waiting | closed    | main   |     2 |     0     <-- FINDING A4
 waiting | live      | feeder |     1 |     0
 waiting | live      | main   |    67 |     3
```
150 `cash_games`, all `must_move`, 109 enabled, 47 `state='live'`.

### Invariants over the live board (all 14 run; 12 clean)

| check | count |
| --- | --- |
| a table seated over its capacity | 0 |
| a player holding two chairs in one cluster | 0 |
| a roster row open with no chair and no pending move | 0 |
| a chair in the game with no open roster row | 0 |
| two non-closed tables sharing a `main_index` | 0 |
| a gap in a cluster's `main_index` sequence | 0 |
| a live seat on a closed/deleted table | 0 |
| an enabled game with no live Main 1 | 0 |
| `current_players` disagreeing with the seats | 0 |
| a pending move older than 5 minutes | 0 |
| a seat change spent with no request behind it | 0 |
| a live feeder with 1 player while a Main has room | 0 |
| **two feeders live/opening in one game** | **1** (transient, correct - see A6) |
| **`status` and `lifecycle` disagreeing** | **2** (FINDING A4) |

### The move pipeline, 24 hours

`move_planned` 22,474, `seat_moved` 21,940 - **97.6% of planned moves land.**

| state | reason | note | count |
| --- | --- | --- | --- |
| done | must_move | - | 11,738 |
| done | balance | - | 10,094 |
| done | seat_change | - | 46 |
| done | must_move/balance | `retry after 40P01: deadlock detected` | 49 |
| done | balance | `retry after 55P03: lock timeout` | 1 |
| done | break | - | 3 |
| cancelled | balance | `destination_unavailable` | 126 |
| cancelled | must_move | `player_not_seated` | 85 |
| cancelled | must_move | `destination_full` | 68 |
| cancelled | balance | `player_not_seated` | 52 |
| cancelled | balance | `destination_full` | 47 |
| cancelled | must_move/balance | `original_occupancy_not_recorded` | 17 |
| cancelled | must_move | `original_occupancy_gone` | 1 |
| cancelled | balance | `busted` | 1 |
| **expired** | **balance** | **`engine_did_not_execute_before_expiry`** | **92** |
| **expired** | **must_move** | **`engine_did_not_execute_before_expiry`** | **42** |
| expired | must_move | `player_left_before_boundary` | 3 |
| pending | - | - | 8 |

### `cash_cluster_events` kinds, 24 hours

`move_planned` 22,474, `seat_moved` 21,940, `game_dormant` 936, `game_woken` 901,
`table_opening_hold` 355, `table_opening_hold_expired` 216, `feeder_opened` 194,
`table_break_completed` 187, `table_break_started` 187, `feeder_live` 159,
`main_demoted_to_feeder` 100, `feeder_promoted_to_main` 88,
`seat_change_requested` 50, `feeder_abandoned` 35, `ruleset_applied` 23,
`status_followed_lifecycle` 15, `controller_tick_error` 14,
`seat_change_returned` 3, `swap_planned` 2, `main_renumbered` 2.

### `controller_tick_error` taxonomy, 24 hours (14 rows)

| sqlstate | message | count |
| --- | --- | --- |
| 55P03 | canceling statement due to lock timeout | 7 |
| 23505 | duplicate key `cash_seat_moves_one_pending_per_player` | 2 |
| 40P01 | deadlock detected | 2 |
| XX000 | cannot find parent statement on pldbgapi2 call stack | 2 |
| P0001 | This table cannot be closed while players are seated | 1 |

Against ~17,280 passes a day this is noise, and each is retried five seconds
later. The 09-07 audit's headline number (11 deadlocks in six hours cancelling
player moves) is **no longer the shape**: 49 moves carry `retry after 40P01` and
still landed `done`, and only 2 deadlocks reached the controller in 24 hours.
Lock ordering was checked directly and is consistent: the tick takes
`cash_games` `FOR UPDATE` then `tables` then `cash_seat_moves`; the executor
takes advisory(530090) shared, then per-user `table_cap:<uuid>` ordered by uuid,
then `cash_games`/`tables`/`cash_seat_moves` each `ORDER BY id FOR UPDATE`, then
seats. Same resource order, so tick-vs-executor and executor-vs-executor cannot
cycle. **No lock-ordering defect found.**

### The feeder ratio, answered

24 hours: `feeder_opened` 194, `feeder_live` 159, `feeder_abandoned` 35.
**82% of feeders opened go live; 18% are abandoned.** The 09-05 figure the
handoff called "open and unexplained" was the inverse (22 opened, 4 live, 20
abandoned in one hour), and the four ceilings changelog plus the six-minute
abandon window fixed it. The 09-07 audit's "12 opened / 11 live" is the same
shape as today. **Confirmed healthy; no defect.**

---

## 4. Findings

### FINDING A2 (P1) - a move's deadline runs while the platform is parking, and the row then blames the engine. FIX WRITTEN, PROBED.

`fn_cash_cluster_tick` skips everything when `fn_platform_frozen()`. That
function is true only for `phase='counting_down'` - the :55 to :00 window.
`fn_cash_seat_move_execute` refuses on `fn_entry_purchases_frozen() OR
fn_platform_frozen()`, and `fn_entry_purchases_frozen()` is **also** true for
`phase='last_hand'` (from :53) and for the whole post-thaw release boundary.

So between :53 and :55 the tick runs, plans moves and expires moves, while the
executor is guaranteed to refuse every one of them. The move's 3-minute TTL
burns through a window in which nothing can execute it, and the tick then writes
`note='engine_did_not_execute_before_expiry'` - naming the engine for a refusal
the platform made. That is CLAUDE.md 10.86 rule 1 exactly: an "I could not tell"
folded into a confident, wrong answer.

Evidence (48 hours, `cash_seat_moves` where `state='expired'`), bucketed by the
minute of `expires_at`:

```
 minute-of-hour bucket | expired moves
        :50-:54        |  42
        :55-:59        |  60      <-- 38% of all expiries in 2 of 12 buckets
   each other bucket   |  9 - 27
```

A worked example from 2026-09-09 05:5x, all on the same game:

```
 created  | announced |  expires | executed |  reason   | note                                 | next plan for the game
 05:51:27 | 05:51:42  | 05:56:42 |          | must_move | engine_did_not_execute_before_expiry | 06:01:53
 05:52:00 |           | 05:55:00 |          | must_move | engine_did_not_execute_before_expiry | 06:01:53
 05:52:12 |           | 05:55:12 |          | balance   | engine_did_not_execute_before_expiry | 06:01:54
```

Seventeen moves on one game died in the :51-:52 minute and the players waited
until 06:01:53 - about ten minutes - for a replacement plan. CLAUDE.md 13 rule 4
is explicit: "Deadlines are thawed, not burned. If you add a wall-clock deadline
a player can lose to, add it to `fn_thaw_platform` in the same PR". The move
expiry IS in `fn_thaw_platform` (`cluster_move_expires_at`), but the thaw only
shifts rows that are still `state='pending'` and whose `expires_at >
p_freeze_started` (= `break_started_at`, :55:00). A move the tick already expired
at :53:30, or one whose `expires_at` fell before :55:00, is never shifted.

**Fix:** `supabase/migrations/20260909181632_a_move_cannot_be_late_while_the_platform_is_parking.sql`.
While `fn_entry_purchases_frozen()` is true the tick does not expire a pending
move; it holds the deadline forward instead, and emits
`moves_held_for_maintenance` so the hold is visible. The expiry branch is
otherwise byte-identical. This is the live path becoming correct, not a repair
job (CLAUDE.md 10.12).

### FINDING A3 (P2) - two expiry paths still carry no reason, and one lies. FIX WRITTEN, PROBED.

The 09-07 audit closed the gap in the TICK (`20260907171507`). Two executor
paths were missed:

1. `fn_cash_seat_move_execute_before_maintenance_gate`:
   `IF m.expires_at <= clock_timestamp() THEN UPDATE ... SET state='expired' WHERE id=m.id;`
   - **no note at all.** This is the original 09-07 finding, one level down.
2. `fn_cash_seat_swap_execute_before_maintenance_gate`: when a swap cannot
   proceed it writes `note='swap_partner_gone'` for FOUR different causes,
   including "my own TTL expired", and it marks the PARTNER `state='expired'`
   even when the partner is alive and pending - so a perfectly good move is
   recorded in the expiry taxonomy. A count of expiries is therefore not a count
   of expiries.

**Fix:** `supabase/migrations/20260909181642_every_expiry_says_why_including_the_executors.sql`.
Path 1 gains `note='expired_before_the_executor_reached_it'`. Path 2 names its
own cause (`own_ttl_expired` vs `swap_partner_gone`) and marks a still-live
partner `cancelled`, not `expired`.

### FINDING A4 (P1) - a game whose only table is half-closed can never be ticked, so the repair written for it can never run. FIX WRITTEN, PROBED.

Two tables are `status='waiting'` with `lifecycle='closed'`:

```
 name                | status  | lifecycle | enabled | state   | last_tick_at | open tables in game
 FLO8 0.50/1 Madness | waiting | closed    | f       | dormant | (null)       | 0
 FLO8 0.50/1 Action  | waiting | closed    | f       | dormant | (null)       | 0
```

`last_tick_at` is NULL: **neither game has ever been ticked.**
`fn_cash_clusters_to_tick` admits a disabled game only when
`EXISTS (... t.lifecycle <> 'closed' ...)`. These two have `lifecycle='closed'`,
so they are not admitted; the `status_followed_lifecycle` repair that would fix
them lives INSIDE `fn_cash_cluster_tick`, which never runs for them. The repair
and the condition it repairs are mutually exclusive - it is the same circular
shape the `20260906011113` migration fixed in the other direction, in the other
field.

Player-visible: every status-based read (the lobby, `cash_tables_needing_engine`,
the club home card) treats a `waiting` table as joinable, while
`fn_refuse_seat_on_closed_cluster_table` refuses the seat with `TABLE_CLOSING`
because the lifecycle is closed. A player can click a game that cannot be
joined, for ever.

**Fix:** `supabase/migrations/20260909181653_the_worklist_admits_a_game_with_a_half_closed_table.sql`.
The worklist admits a game with any table that is non-terminal by EITHER field.
One tick then closes the status, and the game correctly leaves the worklist
next pass.

### FINDING A5 (P2) - a breaking Main keeps a number a survivor is renumbered into. FIX WRITTEN, PROBED.

The ROLES step renumbers `WHERE c.lifecycle IN ('live','opening') AND
c.role='main' ORDER BY c.created_at`, assigning 1..N. A **breaking** main is not
in that set and keeps whatever `main_index` it had. The break candidate is
chosen `ORDER BY (c.seated = 0) DESC, (c.role='feeder') DESC, main_index DESC` -
**empty first**, so an empty Main 2 is chosen ahead of a populated feeder. Mains
1, 2, 3 with Main 2 empty: Main 2 goes `breaking` keeping index 2, and the same
tick renumbers Main 3 to index 2. Two tables on the board carry `main_index = 2`
and both are named "... Main 2" until the break completes and
`fn_closed_cluster_main_releases_index` nulls the index.

There is **no unique index on `(cluster_id, main_index)`** to stop it, and
`fn_cash_clusters_to_tick` picks `main1_table_id` by `main_index = 1 AND
lifecycle <> 'closed' ORDER BY created_at LIMIT 1` - which can select a breaking
table, and that id is the key of the controller's eligible-horse map, so the
OPEN rule would count buyers against a table that takes no players.

Point-in-time it is clean (0 duplicates now, 0 renumbers during a main break
found in 7 days of `main_renumbered` events) - a latent hole, not an outage.

**Fix:** `supabase/migrations/20260909181704_a_main_keeps_its_number_while_it_breaks.sql`.
After the roles step, a breaking main holding an index that a live main now owns
is moved above the live range in the same transaction. `v_idx` and the
demote-to-feeder test are untouched.

### FINDING A6 (P3, no fix needed) - two live feeders in one game is legal and transient

`NLH 0.50/1 Classic` showed a live feeder (6 seated, `promote_pending=true`) and
an opening feeder created 17 seconds earlier in the same pass. That is the
designed hand-off: OPEN marks the current feeder `promote_pending` and opens the
next; PROMOTE turns the pending one into Main N+1 when the new feeder reaches 2
seated. Not a defect. The invariant query counts it, which is why it reads 1.

### FINDING A7 (P2, NOT FIXED - reported precisely) - the cancelled-move back-off is keyed on plan time, not refusal time

Both the planner and `fn_cash_cluster_balance` skip a player with
`m.state='cancelled' AND m.created_at > v_now - interval '60 seconds'`. The
comment says "a move the engine just refused is not re-planned every 5 s; the
refusal gets a minute". But the clock starts when the move was **planned**, and a
move can be cancelled up to 3 minutes later (5 after `announce`), by which time
the back-off has already lapsed - so the refusal gets no minute at all. 400
cancellations in 24 hours; the landing rate is 97.6%, so the cost today is churn
rather than a stuck player.

Not fixed because the honest fix needs a resolution timestamp
(`cash_seat_moves.executed_at` is NULL on every cancelled row), which means a
column plus edits to the tick, the balancer and both executors - four surfaces,
and three of them are shared files this lane was told to keep surgical. Handing
it to the integrator as a scoped follow-up rather than half-doing it.

### FINDING A8 (P3, no fix) - `original_occupancy_not_recorded`, 17 rows in one minute

All 17 fall between 17:30:57 and 17:31:41 UTC today, and every one has
`source_occupancy_id IS NULL`. That is the cutover minute of the applied
migration `20260909173145_bind_cash_seat_moves_to_original_occupancies`: moves
planned before the binding trigger existed were refused by the executor after it
did. Zero since. Self-limiting cutover artefact, not a defect. From 18:00 onward
100% of new moves carry `source_occupancy_id`.

### Horses (CLAUDE.md 10.5) - clean

`grep -l is_horse` over every dumped live cluster body returns **nothing**. No
cluster function branches on `is_horse`. The OPEN rule counts a horse as a buyer
(`p_eligible_horses`), the must-move planner orders by the roster's `joined_at`
with no horse branch, the balancer likewise, the break moves every seated player,
and `fn_cash_seat_change_request` takes `p_user_id` only for the engine so a
horse uses the identical door. **No violation found.**

### Stranding - clean

`seat on a closed table` 0, `roster row without chair` 0, `chair without roster`
0. Since the applied occupancy-contract family, a live seat on a terminal table
is refused by the FK `live_seat_parent_cannot_close` rather than repaired after
the fact, and the tick's old `closed_table_reopened_to_break` loop was retired
because it can no longer have anything to do. The single P0001
`controller_tick_error` ("This table cannot be closed while players are seated")
is that guard doing its job on a close the tick attempted.

---

## 5. Status of each fix

| finding | severity | fix | state |
| --- | --- | --- | --- |
| A1 main-vs-production migration drift | P2 | none (integrator merge) | REPORTED |
| A2 deadline burns during the park | P1 | `20260909181632` | DONE - written, probed, board 14 |
| A3 expiry paths with no reason / a lie | P2 | `20260909181642` | DONE - written, probed, board 11 |
| A4 worklist cannot reach a half-closed game | P1 | `20260909181653` | DONE - written, probed, board 12 |
| A5 breaking main keeps a taken index | P2 | `20260909181704` | DONE - written, probed, board 13 |
| A6 two feeders | P3 | none needed | CLOSED |
| A7 back-off keyed on plan time | P2 | none | NOT FIXED, scoped below |
| A8 occupancy cutover artefact | P3 | none needed | CLOSED |
| A9 two harness boards pin retired mechanisms | P2 | boards 2 and 8 rewritten | DONE - both pass |
| A10 `fn_platform_frozen` changed under the audit | P2 | none (not this lane) | REPORTED |

### FINDING A9 (P2) - two boards of the probe harness pin mechanisms production retired today. FIXED.

`scripts/dev/probe-cluster-boards.sql` is the harness that proves the tick. Two
of its ten boards assert events that are no longer in the live function, so
both are red by construction:

| board | asserts | in the live tick? |
| --- | --- | --- |
| 2 | `closed_table_reopened_to_break` | 0 occurrences |
| 8 | `second_chair_cashed_out`, `second_chair_leave_pending` | 0 occurrences each |

Both mechanisms were REPAIRS, and both were deliberately deleted today by the
occupancy-contract migrations (Finding A1) that replaced them with constraints -
`live_seat_parent_cannot_close` and `one_committed_seat_per_game_player`. That
is the right direction (CLAUDE.md 10.11/10.12: a guard beats a repair), and the
boards simply were not moved with the mechanism.

Board 2's own SETUP is now impossible as well: it builds its shape with
`UPDATE tables SET lifecycle='closed'` on a table holding a live seat, which the
FK refuses.

**Fixed:** both boards rewritten to pin the new guarantee, and both now PASS
against production with no migration applied:

```
NOTICE:  close refused: update or delete on table "tables" violates foreign key
         constraint "live_seat_parent_cannot_close" on table "table_seats"
NOTICE:  PASS  a table holding a live seat cannot be walked to lifecycle=closed
NOTICE:  PASS  the table is still open (lifecycle=live)
NOTICE:  PASS  and the player still holds the chair - nobody was stranded
NOTICE:  PASS  the retired reopen-to-break repair has not come back
NOTICE:  PASS  the door refuses a second chair in the same game (ALREADY_IN_GAME)
NOTICE:  schema: duplicate key value violates unique constraint
         "one_committed_seat_per_game_player"
NOTICE:  PASS  one_committed_seat_per_game_player refuses the second chair even
         with the executor flag set
NOTICE:  PASS  the older chair is still theirs, and no chip moved
NOTICE:  PASS  the retired duplicate-chair cleanup has not come back
```

Each rewritten board also asserts the retired mechanism has NOT come back, so a
future agent restoring the repair fails the board that documents why it went.

### FINDING A10 (P2, REPORTED, not this lane's to fix) - `fn_platform_frozen` was replaced under the audit

At 18:06 UTC, mid-audit, `20260909180615_maintenance_ownership_fits_process_lifetime`
replaced `fn_platform_frozen()` on production. The body I dumped at 18:05 and
the body at 18:38 are different functions. Three consequences the cluster docs
do not record:

1. **It now returns true for `phase='last_hand'` too**, but only from
   `announced_at + 2 minutes`, while `fn_entry_purchases_frozen()` is true from
   `announced_at - 30 seconds`. The 2.5-minute window in Finding A2 is now
   explicitly encoded in the two definitions rather than implied by them. A2's
   probe uses exactly that gap and it behaves as described.
2. **It now consults `fn_active_maintenance_release_boundary()`**, so the
   cluster tick is also frozen for the whole post-thaw release window - new
   behaviour for the controller that nothing in `docs/changelog` mentions.
3. **It was `STABLE` and is now `VOLATILE`**, and it calls a `SECURITY DEFINER`
   plpgsql function that runs `max()` over `engine_maintenance_thaws`. 27
   functions in `public` call `fn_platform_frozen`, including
   `fn_refuse_while_frozen`, which is the `zz_freeze_guard` BEFORE-ROW trigger
   on `table_seats` and six other money tables. A volatile call per row on
   every seat write, where a stable one used to be cached per statement, is a
   cost nobody measured in the migration that made it. Raising it here rather
   than changing it: the maintenance-ownership programme owns that function.

---

## 6. Boundary conditions checked one by one (the `>=` vs `>` sweep)

| rule | live predicate | intended (OPORD 1.4 s18.3 / changelogs) | verdict |
| --- | --- | --- | --- |
| feeder goes live | `c.seated >= 2` | "live at two seated" | correct |
| OPEN needs buyers | `v_buyers >= 2` | "at least two buyers" | correct |
| OPEN table cap | `v_live_tables < g.cap_mains + 1 (+1)` | mains + one feeder | correct |
| ceiling trigger | `v_live >= cap_mains + 1 + second_feeder + 2` | backstop above the tick's own cap | correct, deliberately looser |
| break fit | `v_seated_total < v_remaining_capacity` | STRICT: everyone fits AND a seat stays open | correct |
| break window (clock) | `break_eligible_since <= v_now - v_window` | 5 min, or 60 s when <= 1 seated | correct |
| break window (orbits) | `v_hands >= 2 * v_orbit` | two completed orbits | correct |
| feeder abandoned | `opened_at < v_now - interval '6 minutes'` | six minutes empty | correct |
| rest after abandon | `e.at > v_now - interval '2 minutes'` | two minutes | correct |
| opening hold | `opening_hold_since < v_now - interval '60 seconds'` | 60 s | correct |
| balance trigger | `hi.n - lo.n >= 2 AND hi.n >= 3 AND lo.n >= 1` | "within one player of each other" | correct |
| move back-off | `m.created_at > v_now - interval '60 seconds'` | "the refusal gets a minute" | **WRONG - Finding A7** |

The one that reads wrong is A7, and it is wrong in the operand rather than in
the operator.

**`v_remaining_capacity` does not subtract inbound pending moves.** The break
can therefore arm on a board where the free seats it counted are already
spoken for. The consequence is bounded: the break loop then finds no
destination (`EXIT WHEN v_shortest IS NULL`) and moves nobody that pass, and
the next pass re-evaluates. Measured over 24 hours: `table_break_started` 182,
`table_break_completed` 182, and **zero tables in `lifecycle='breaking'` on the
board right now** - so no table has been stranded mid-break. Left as-is and
recorded, rather than changed on a hypothesis the rows do not support.

## 7. Commands run, with their tails

Probe of all four migrations, applied and exercised inside ONE transaction,
`ROLLBACK` at the end (`/tmp/laneA/probe.sql`, 961 lines, direct psql to
`db.kuklfnapbkmacvwxktbh.supabase.co`, `application_name=laneA-audit`):

```
===== applying 20260909181632_a_move_cannot_be_late_while_the_platform_is_parking
===== applying 20260909181642_every_expiry_says_why_including_the_executors
===== applying 20260909181653_the_worklist_admits_a_game_with_a_half_closed_table
===== applying 20260909181704_a_main_keeps_its_number_while_it_breaks

---- BOARD A3  PASS  the move executor names its own late arrival
               PASS  the swap executor tells its own timeout from its partner's
               PASS  no expiry anywhere in the move lifecycle is written without a note
---- BOARD A4  table b652e87b (FLO8 0.50/1 Madness): status=waiting lifecycle=closed
               PASS  its game is on the worklist
               tick: {"ok": true, "actions": [{"status_followed_lifecycle": 1}]}
               PASS  one tick made the two fields agree (status=closed lifecycle=closed)
               PASS  and said so with status_followed_lifecycle
               PASS  the game then leaves the worklist: admitted once, not for ever
               NOTICE: worklist admits 2 of 2 games holding a half-closed table
---- BOARD A5  main1 0183f083 main2 dd316839(breaking, 1 seat) main3 338212fa feeder 40d50e47
               tick actions: [{"moves_planned": 1}, {"breaking_main_renumbered": "dd316839"}, {"state": "live"}]
               after: breaking main_index=3 name=PLO4 1/2 Madness Main 3 ; survivor main_index=2
               PASS  the survivor is renumbered into the breaking table's old index (reachable)
               PASS  and the breaking table was moved above the live range (3)
               PASS  its lifecycle is untouched
               PASS  its player is still seated or already planned out
               PASS  no two open tables of the game share a main_index
               PASS  the tick says so
---- BOARD A6  PASS  a three-table live game ticks clean on the patched body: []
---- BOARD A2  PASS  the tick planned a must_move for the feeder player onto Main 1
               PASS  the board is in the :53-to-:55 window: entry purchases frozen, platform not yet frozen
               PASS  and the executor refuses this exact move with platform_frozen
               tick: {"ok": true, "actions": [{"moves_held_for_maintenance": 1}]}
               PASS  the move is still pending, not expired (state=pending)
               PASS  its deadline was held forward past now
               PASS  and never shortened
               PASS  the tick says so: [{"moves_held_for_maintenance": 1}]
               PASS  the park is over
               PASS  outside the park it expires exactly as before
                     (state=expired note=engine_did_not_execute_before_expiry)
===== ROLLED BACK
```

**20 of 20 assertions passed.** Nothing committed, verified after the rollback:

```
 break_rows | fake_thaws | probe_moves |             tick_md5             |          worklist_md5
          0 |          0 |           0 | ae91ea39aef3746371029528cb8e343d | a53afb0f2ad173e6da9fc835c80c2d84
```

Both md5s are the pre-probe values, so both functions are exactly as they were.
The only cluster table created in the window (`NLH 0.05/0.10 Classic Feeder`,
18:21:13) predates the probe and belongs to the live controller.

Rewritten harness boards 2 and 8, run against production with NO migration
applied: **8 of 8 PASS** (output quoted under Finding A9).

**No vitest or tsc was run: this lane changed no TypeScript.** The four
migrations and the probe harness are SQL; the harness is proven by running it,
which is the point its own header makes ("the only thing that proves the tick
is the tick, on the real schema, against real games").

## 8. Files this lane changed

| file | what |
| --- | --- |
| `supabase/migrations/20260909181632_a_move_cannot_be_late_while_the_platform_is_parking.sql` | new - holds a move's deadline through the park (A2) |
| `supabase/migrations/20260909181642_every_expiry_says_why_including_the_executors.sql` | new - names both executor expiry paths (A3) |
| `supabase/migrations/20260909181653_the_worklist_admits_a_game_with_a_half_closed_table.sql` | new - worklist reads both liveness fields (A4) |
| `supabase/migrations/20260909181704_a_main_keeps_its_number_while_it_breaks.sql` | new - breaking main releases a live index (A5) |
| `scripts/dev/probe-cluster-boards.sql` | **SHARED FILE** - boards 2 and 8 rewritten (A9), boards 11-14 appended |
| `docs/audits/2026-09-09-must-move-audit/lane-A.md` | this report |

**Shared-file note for the integrator (brief rule 9):** the only shared file
this lane touched is `scripts/dev/probe-cluster-boards.sql`, and the edits are
three disjoint regions - board 2, board 8, and an append before the closing
banner. Three of the four migrations patch `fn_cash_cluster_tick`; all three
read the LIVE definition and replace one anchored literal, so they compose in
any order and each refuses rather than guesses if its anchor has moved.

**Possible overlap:** another lane reserved
`20260909181259_a_leave_cancels_the_move_and_a_move_says_why_it_expired.sql`
(empty as this was written). If that lane also rewrites the tick's expiry
statement, its anchor and this lane's `20260909181632` are the same lines and
whichever applies second will refuse with "the expiry statement and its
diagnostics are not in the live definition in the shape this migration
expects" - which is the guard working, not a failure. They must be reconciled
into one edit before both are applied.

## 9. What this lane did NOT fix, precisely

1. **Finding A7, the back-off clock.** Needs a resolution timestamp on
   `cash_seat_moves` (`executed_at` is NULL on every cancelled row), so a
   column plus edits to the tick, `fn_cash_cluster_balance` and both executors.
   Four surfaces, three of them shared. Scoped, not started.
2. **Finding A1, main-vs-production migration drift.** 122 applied versions
   have no file on `origin/main`, including the eight-file occupancy-contract
   family that the live cluster tick depends on. Merging that branch is the
   integrator's, and it must NOT be done by re-emitting the tick from `main` -
   that would revert three applied changes and reinstate two repairs the
   schema now makes unnecessary.
3. **Finding A10, `fn_platform_frozen`'s new volatility and release-boundary
   behaviour.** Owned by the maintenance-ownership programme; measured and
   handed over, not changed.
4. **The engine half of the move lifecycle.** `ServerTableEngineBase`'s
   announce/execute loop was read to confirm the SQL contract, not audited;
   that is another lane's.

---

## 10. Follow-up, 2026-09-10 (18:10 to 18:30 UTC)

Three items handed back by the coordinator after the day-1 re-probe (all four
day-1 migrations re-applied clean against the current live bodies, 171 commits
later, anchors intact). Same production database over psql
(`db.kuklfnapbkmacvwxktbh.supabase.co`, direct host, `lock_timeout` 4 s inside
every probe). Nothing applied.

Before starting, every function this follow-up touches was re-dumped and
compared with the day-1 dump. The tick, the balancer, the worklist and
`fn_cash_seat_change_plan` are byte-identical to yesterday. Both executor
gates changed at ~18:00 UTC today (a `cash_player_session` re-point on the
move and swap paths, "A RE-POINT IS NOT ALLOWED TO COLLIDE (2026-09-10)");
neither change touches a line any lane A migration anchors on, and the
sequence probe below proves it.

### 10.1 J-1 (P1): the balancer and step 2 were moving the same players back and forth. FIXED.

Lane J's measurement (lane-J.md section 6) stands and is re-measured below.
The two rules contradicted by construction: step 2 of the tick holds EVERY main
full from the feeder, in must-move order (longest-seated first); the balancer
(`20260906011318`) pooled "everything but Main 1" - so Main 2..N, which step 2
also holds full - and moved the NEWEST arrival off the fullest table onto the
feeder. Step 2 then moved the longest-seated feeder player straight back.

**The rule chosen, written into the migration header:**

> The balancing pool is the LIVE FEEDERS of the game, and nothing else. Mains
> are never in it - neither as the table a player leaves nor as the table a
> player is sent to. With one feeder the pool has one entry and the balancer
> does nothing. With two feeders (`allow_second_feeder`) it keeps them within
> one player of each other, which is what it was written for.

**Should a main with an open seat and an empty feeder ever receive a balance
move? No**, for three reasons written in the header: (1) step 2 is the one
writer of main seats and its order is Dan's must-move order; the balancer's
order is the opposite (newest first), and two writers with opposite orders on
the same seats IS the round trip; (2) a main's open seat is filled by step 2
from the feeder inside one tick, so there is nothing left for a balancer to
add, and a main step 2 could not fill (empty feeder) the balancer could not
fill either; (3) moving a player off a main is never balancing, it is undoing
step 2. An EMPTY feeder never receives one either: `lo.n >= 1` stays.

What is unchanged: the thresholds (`hi.n - lo.n >= 2`, `hi.n >= 3`, `lo.n >= 1`),
the newest-arrival choice, every exclusion, the `move_planned` event, and the
back-off predicate text (kept byte-for-byte so `20260910181447` can anchor on
it). "Mains only when no feeder exists" was considered and rejected as
vacuous: with two or more live tables and no feeder, step 6 of the same tick
demotes the newest main to feeder, and the balancer runs AFTER the tick.

Migration: `supabase/migrations/20260910181433_the_balancer_balances_feeders_and_leaves_the_mains_to_must_move.sql`
(whole body re-emitted, 3.4 KB, guarded on the live md5
`2becc9f54f99a12641c1fa4aa888dfcf`, refuses on any other body).

**The round-trip probe, before and after, in ONE rolled-back transaction.**
The board is built first, the LIVE balancer is called against it and rolled
back to a savepoint, then all seven migrations are applied and the same board
is run again:

```
---- BEFORE THE FIX: the live balancer moves a player OFF a full main onto the feeder
     game a80b38df-58ab-4192-b960-ddadc4ecd382 : Main 1 09ee59dc/2 full, Main 2 84d2fe9a/3 full, feeder 1 (c8678e54)
PASS  LIVE balancer (20260906011318): plans 1 move, balance main -> feeder:
      a player pulled OFF a full main onto the feeder
     (the live balancer's move rolled back to the savepoint; the board stands)
===== applying 20260909181259 ... 20260910181447   (seven, in version order)
---- BOARD 15: the round trip is gone
PASS  the balancer plans 0 moves on Main 1 full / Main 2 full / feeder at 1
PASS  a full tick + balance pass plans nothing (pending=0, balanced=0): no leg to reverse, no round trip
PASS  no move takes a player off a main onto the feeder
PASS  a main with an open seat receives no balance move (that seat is step 2's)
PASS  and step 2 fills it from the feeder, in must-move order, as the rule says
---- BOARD 16: two feeders still balance to within one player of each other
PASS  feeder A (3) -> feeder B (1): 1 balance move planned, feeder -> feeder
PASS  and it is the NEWEST arrival on feeder A who moves
PASS  the tick plans no must_move against it (Main 1 is full); the balance stands
PASS  a second pass plans nothing: A counts 2 outbound-adjusted, B counts 2 inbound-adjusted
```

**Expected drop, from the hour before the probe (17:24-18:24 UTC, `state='done'`,
roles as they are now):**

| | count |
| --- | --- |
| done moves in the hour | 1,123 |
| `balance` main -> feeder | 410 |
| `must_move` feeder -> main | 443 |
| **exact round trips** (balance main->feeder, then the SAME player must_move from that feeder back to that SAME main within 10 min) | **374** |
| `balance` feeder -> feeder | 117 |
| distinct players moved | 81 |

Once applied, every `balance main -> feeder` move and its return leg
disappear: **~784 of ~1,123 moves an hour (~70%)**, leaving roughly 340 an
hour, all of them must-moves that fill a seat or feeder-to-feeder balances.
Caveat on the classification: `role` is the table's role NOW, not at move
time, so the 117 feeder-to-feeder rows include tables that were mains when
the move was planned; lane J's 17:00 figure was read the same way.

### 10.2 A7 (P2): a refusal gets its minute from the moment it was refused. FIXED.

Design, in `supabase/migrations/20260910181447_a_refusal_gets_its_minute_from_the_moment_it_was_refused.sql`:

1. **`cash_seat_moves.resolved_at timestamptz`** - when the row left `pending`,
   whatever it left to. NULL while pending. `COMMENT ON COLUMN` says so.
2. **One authority stamps it**: `zz_cash_seat_move_resolved`, a
   `BEFORE INSERT OR UPDATE OF state` trigger (`fn_cash_seat_move_stamp_resolved`).
   The coordinator asked for a stamp "in every terminal transition"; there are
   eleven such UPDATEs across three executor functions and the tick, and the
   next writer would be a twelfth. A trigger is every transition, present and
   future, in one place - the same shape as `zz_cash_seat_move_window`, which
   owns `expires_at` on insert for the same reason. A row put back to
   `pending` (nothing does today) clears it.
3. **The three planners key the minute on `coalesce(m.resolved_at, m.created_at)`**
   by anchored replacement of the predicate they share: the tick (2
   occurrences, step 2 and step 5), the balancer (1), and
   `fn_cash_seat_change_plan` (2). Each replacement asserts the exact
   occurrence count first, so a body that has drifted refuses rather than
   half-patches.
4. **No backfill.** A historical row with no stamp behaves exactly as today
   (the coalesce falls through to `created_at`), and CLAUDE.md 10.12 forbids
   the job anyway. Board 17 pins that too.
5. **Expired stays outside the back-off** on purpose: an expiry means the
   engine never acted, and the right response is to re-plan at once.

Anchor disjointness, checked by grep before the probe and proven by it: the
back-off text appears 0 times in the replaced text of `20260909181632`,
`20260909181704` and lane B's `20260909181259`; lane B's rewritten
`fn_cash_seat_change_plan` carries the identical predicate, so the anchor
matches before and after that migration. Order: `181447` must follow
`181433` (the balancer's md5 guard would otherwise refuse - the correct
outcome), which version order guarantees.

Manifest fragment: `scripts/ci/schema-manifest.d/a-refusal-gets-its-minute.json`.

```
---- BOARD 17: a refusal gets its minute from the moment it was refused
PASS  a pending move carries no resolved_at
PASS  the refusal is stamped by the trigger: resolved_at=2026-09-10 18:22:28.559307+00
PASS  planned 10 min ago, refused now: the refused player is backed off (keyed on resolved_at) and the balancer takes the next newest
PASS  refused 61 s ago: the first player's back-off has lapsed and they are planned again; the one refused just now is not
PASS  a landed move carries both executed_at and resolved_at
PASS  and historical rows are left unstamped: no backfill (CLAUDE.md 10.12), the planners fall back to created_at for them
```

(The first draft of this board asserted "the balancer plans nothing" after the
refusal and failed - correctly: the back-off is per PLAYER, and the balancer
took the next-newest arrival instead. The board now asserts per player.)

### 10.3 F4: the swap gate never checked its destinations exist. FOLDED INTO `20260909181642`.

Lane B's predicate (lane-B.md section 5) taken verbatim as a second anchored
replacement inside the swap-gate block of `20260909181642`, which is not yet
applied so editing the file is the right place. On a record that was never
found `ta.lifecycle IN (...)` is NULL and NULL OR NULL is not true, so a
vanished destination passed. Now both rows must exist, be open by lifecycle
AND by status - the single-move gate's own test. Each of the block's two
replacements is idempotent on its own marker, independently of the other, and
the migration's final assertion and the "already applied" short-circuit both
demand the F4 marker. Header updated (section 3 of its reasoning, ROLLBACK
note extended).

```
---- BOARD 18: the swap gate refuses a destination that does not exist (F4)
PASS  both destinations must exist and be open by lifecycle AND status (lane B's predicate, verbatim)
PASS  the lifecycle-only test is gone
```

### 10.4 The seven-migration sequence probe

One psql transaction, `lock_timeout` 4 s, applied in version order:
`20260909181259` (lane B), `181632`, `181642` (with F4), `181653`, `181704`,
`20260910181433`, `20260910181447`; then boards 15-18; then `ROLLBACK`.

```
===== applying 20260909181259_a_leave_cancels_the_move_and_a_move_says_why_it_expired
===== applying 20260909181632_a_move_cannot_be_late_while_the_platform_is_parking
===== applying 20260909181642_every_expiry_says_why_including_the_executors
===== applying 20260909181653_the_worklist_admits_a_game_with_a_half_closed_table
NOTICE:  worklist admits 2 of 2 games holding a half-closed table
===== applying 20260909181704_a_main_keeps_its_number_while_it_breaks
===== applying 20260910181433_the_balancer_balances_feeders_and_leaves_the_mains_to_must_move
===== applying 20260910181447_a_refusal_gets_its_minute_from_the_moment_it_was_refused
NOTICE:  public.fn_cash_cluster_tick(uuid, integer) re-keyed (2 occurrence(s))
NOTICE:  public.fn_cash_cluster_balance(uuid, timestamptz) re-keyed (1 occurrence(s))
NOTICE:  public.fn_cash_seat_change_plan(uuid, timestamptz) re-keyed (2 occurrence(s))
... boards 15, 16, 17, 18 ...
===== ROLLED BACK
```

**18 PASS, 0 FAIL** (1 before-fix assertion + 17 after). Production verified
untouched after the rollback: tick `ae91ea39...`, balancer `2becc9f5...`,
seat-change planner `42168eaf...` all the pre-probe md5s; no `resolved_at`
column, no `zz_cash_seat_move_resolved` trigger, no maintenance-break row.

### 10.5 Files changed in this follow-up

| file | what |
| --- | --- |
| `supabase/migrations/20260910181433_the_balancer_balances_feeders_and_leaves_the_mains_to_must_move.sql` | new (J-1) |
| `supabase/migrations/20260910181447_a_refusal_gets_its_minute_from_the_moment_it_was_refused.sql` | new (A7) |
| `supabase/migrations/20260909181642_every_expiry_says_why_including_the_executors.sql` | F4 folded in (second anchored replacement, header, assertions) |
| `scripts/ci/schema-manifest.d/a-refusal-gets-its-minute.json` | new column + trigger function declared |
| `scripts/dev/probe-cluster-boards.sql` | helpers `pick_dormant_game_except`, `fill`, `pending`; boards 15-18 inserted before board 14 (which must stay last: it holds the maintenance advisory lock); banner now "eighteen" |
| `docs/audits/2026-09-09-must-move-audit/lane-A.md` | this section |

Lane A now holds six migrations. Apply order is version order and every
guard refuses out-of-order application rather than guessing. No TypeScript
touched; no tsc/vitest run, per the coordinator's instruction while `main`
is being merged into this worktree.
