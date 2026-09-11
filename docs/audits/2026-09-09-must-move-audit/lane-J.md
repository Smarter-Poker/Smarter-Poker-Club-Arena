# Lane J - read-only production verification of the must-move floor (2026-09-09)

Lane J writes no code and no migrations. Everything below is a READ, stamped with
the UTC minute it was taken (CDT = UTC minus 5 hours today). Where a number was
re-taken later in the session the later read is stamped separately; nothing in
this file is a recollection.

## 0. Which database, and a correction to the brief

- The BRIEF names Supabase project `ydsaqnnuwyvtyxgvrnys`. That project is
  `pepnationlab-prod` (us-east-1, 180 public tables such as `agent_invoices`,
  `compound_clinical_trials`). Read at 18:04 UTC: it holds NO `cash_*`
  relation and no `fn_cash_*` function. An empty answer from it is not a healthy
  floor; it is the wrong database (CLAUDE.md 10.86).
- Every measurement in this file was taken against `kuklfnapbkmacvwxktbh`
  (`PokerIQ-Production`, us-west-2, the project CLAUDE.md section 2 names).
  The two calls made against the wrong project (a schema listing and a
  `relname ilike '%cash%'` listing) returned empty and were discarded; nothing
  from them is used anywhere below.
- Git reads were taken on the host in
  `~/Documents/.agent-trees/club-arena/cowork-mustmove` after `git fetch origin main`.

## 1. Census of `cash_games` (read 18:05:01 UTC / 13:05 CDT)

| measure | value |
| --- | --- |
| rows | 150 |
| enabled | 109 |
| closed (`closed_at` set) | 41 (all 41 are `dormant/false`) |
| enabled by template | classic 69, action 20, madness 20 |
| all rows by template | classic 88, action 31, madness 31 |
| enabled by band (`fn_cash_stake_band(bb)`) | micro 59, low 33, mid 16, high 1 |
| enabled by variant | nlh 20, plo4 18, plo5 18, plo6 18, pineapple 8, short_deck 8, plo8 7, flh 6, flo8 6 |
| enabled by state | live 49, dormant 60 |
| every enabled game | `must_move = true` (109/109) |

Per template x band x variant (read 18:05:06 UTC): every action and madness
combination is exactly ONE game (20 each: low 7, micro 9, mid 4); classic holds
the duplicates (up to 8 for NLH micro). Live/dormant by template at that minute:
action 4 live / 16 dormant; madness 4 live / 16 dormant; classic 41 live / 28
dormant. Compared with the 2026-09-07 18:15 UTC handoff (79 live, 71 dormant,
150 enabled): 41 games have since been closed and the live count has fallen
from 79 to 49.

## 2. Tables and lifecycle/status agreement (read 18:05:20 UTC)

| measure | value |
| --- | --- |
| tables with `cluster_id` (all time) | 4,514 |
| open cluster tables (`lifecycle <> 'closed' AND status <> 'closed'`) | **137** (main 120, feeder 17) |
| lifecycle/status pairs over all 4,514 | live/running 69, live/waiting 68, closed/closed 4,375, **closed/waiting 2** |
| `lifecycle='closed' AND status<>'closed'` | **2** |
| `status='closed' AND lifecycle<>'closed'` | 0 |
| open but `is_deleted` | 0 |
| open table whose `cluster_id` has no `cash_games` row | 0 |
| open table on a DISABLED game | 0 |
| cash table (no tournament) open with NO `cluster_id` | 0 |
| tables in `lifecycle IN ('opening','breaking')` | 0 (re-read 18:15:50) |

The two closed/waiting rows (read 18:05:27 UTC), both on disabled dormant games,
both `main_index NULL`, both with `updated_at` inside the last ten minutes
(18:00:00 and 17:56:59), so something is still touching them every tick:

| table id | name | game | enabled | seated |
| --- | --- | --- | --- | --- |
| `fd9335bb-894c-451f-8514-59e15d0785d1` | FLO8 0.50/1 Action | `14dfcb84-7d6c-43bd-8976-58ce59b3e715` | false | 0 |
| `b652e87b-36eb-4f30-9181-8cb02b52f7a8` | FLO8 0.50/1 Madness | `1ff1ef89-a29f-41a1-b7f8-9cf123baf09b` | false | 0 |

The live `fn_cash_cluster_tick` (section 9) carries a `status_followed_lifecycle`
repair for exactly this shape; 15 `status_followed_lifecycle` events fired in the
last 24h (last 04:00:41 UTC), but these two rows are on DISABLED games and
`fn_cash_clusters_to_tick` / the pass appear not to reach them (their game rows
carry `last_tick_at` older than 90 s at 18:09:17, see section 8). Player impact:
none (0 seated, game disabled, not in the lobby). Severity P2.

## 3. Seats vs roster, and the nine invariants (read 18:05:46 UTC / 13:05 CDT)

| check | result |
| --- | --- |
| open seats on open cluster tables | **306** |
| open seats on ANY cluster table | 306 |
| `cash_game_roster` rows with `left_at IS NULL` | **306** (306 on enabled games, 0 on disabled) |
| distinct (game_id, user_id) open roster pairs | 306 (0 duplicates) |
| a table seated over `max_players` | 0 |
| a player holding two chairs in one cluster | 0 |
| roster row with no chair in the game | 0 |
| chair with no open roster row | 0 |
| duplicate `main_index` inside a cluster | 0 |
| gap in a cluster's `main_index` sequence (or min <> 1) | 0 |
| open main with `main_index NULL` | 0 |
| `seat_change_used_at` stamped with no request behind it | 0 |
| `cluster_id` pointing at no game (any table) | 0 |
| open cash table with no `cluster_id` | 0 |
| cash table (no cluster) still holding a seat | 0 |
| pending move past its own `expires_at` | 0 |
| `fn_unaccounted_seat_exits()` | 0 |

Seats vs roster drift: **zero**. All nine invariants clean at that minute. For
scale: the 2026-09-07 handoff read 572 seats on 182 tables; today the floor is
306 seats on 137 tables (-46% seats).

## 4. `cash_cluster_events` by kind (read 18:05:54 UTC / 13:05 CDT)

| kind | last 1h | last 24h | last at (UTC) |
| --- | --- | --- | --- |
| move_planned | 820 | 22,505 | 18:05:48 |
| seat_moved | 801 | 21,984 | 18:05:48 |
| game_dormant | 31 | 935 | 18:05:13 |
| game_woken | 35 | 901 | 18:04:48 |
| table_opening_hold | 19 | 352 | 18:04:49 |
| table_opening_hold_expired | 18 | 214 | 18:04:28 |
| feeder_opened | 5 | 194 | 18:01:28 |
| feeder_live | 3 | 159 | 18:01:43 |
| feeder_abandoned | 2 | 36 | 18:00:10 |
| table_break_started | 0 | 187 | 14:46:45 |
| table_break_completed | 0 | 187 | 14:46:45 |
| main_demoted_to_feeder | 0 | 100 | 13:13:28 |
| feeder_promoted_to_main | 2 | 88 | 17:18:11 |
| seat_change_requested | 1 | 50 | 17:11:08 |
| ruleset_applied | 0 | 23 | 03:54:45 |
| status_followed_lifecycle | 0 | 15 | 04:00:41 |
| controller_tick_error | 0 | 15 | 11:16:14 |
| seat_change_returned | 0 | 3 | 14:19:08 |
| swap_planned | 0 | 2 | 02:44:24 |
| main_renumbered | 0 | 2 | 2026-09-08 19:06:45 |

Feeder ratio, 24h: 194 opened / 159 live / 36 abandoned = **82% of feeders
went live**, 18.6% abandoned. Last hour: 5 / 3 / 2. Breaks: 187 started and 187
completed in 24h (every break completed), none in the 3h19m before the read.

## 5. Move outcomes over 24h (read 18:06:00 and 18:06:13 UTC / 13:06 CDT)

Totals by state, moves created in the last 24h: **done 21,955, cancelled 404,
expired 137, pending 11** (22,507). Expired = **0.609%** (the 2026-09-07 handoff
measured 6.54% after its fix; the four-hand-length window has since cut that by
another 10x). Cancelled = 1.795%. Last hour: done 787, cancelled 21, pending 11,
expired 0 (0.000%).

Taxonomy (state / note / reason, 24h):

| state | note | reason | n |
| --- | --- | --- | --- |
| done | (none) | must_move | 11,758 |
| done | (none) | balance | 10,100 |
| done | (none) | seat_change | 46 |
| done | retry after 40P01: deadlock detected | must_move | 27 |
| done | retry after 40P01: deadlock detected | balance | 22 |
| done | (none) | break | 3 |
| done | retry after 55P03: lock timeout | balance | 1 |
| cancelled | destination_unavailable | balance | 126 |
| cancelled | player_not_seated | must_move | 85 |
| cancelled | destination_full | must_move | 69 |
| cancelled | player_not_seated | balance | 52 |
| cancelled | destination_full | balance | 47 |
| cancelled | original_occupancy_not_recorded | must_move | 9 |
| cancelled | original_occupancy_not_recorded | balance | 8 |
| cancelled | destination_unavailable | must_move | 4 |
| cancelled | destination_full | seat_change | 2 |
| cancelled | original_occupancy_gone | must_move | 1 |
| cancelled | busted | balance | 1 |
| cancelled | destination_unavailable | seat_change | 1 |
| expired | engine_did_not_execute_before_expiry | balance | 92 |
| expired | engine_did_not_execute_before_expiry | must_move | 42 |
| expired | player_left_before_boundary | must_move | 3 |
| pending | (none) | balance | 5 |
| pending | (none) | must_move | 3 |

- `player_not_seated` cancels, 24h: 85 + 52 = **137** (this is lane B's number,
  see section 17).
- Deadlocks (40P01): 49 in 24h, ALL retried to `done` (`retry after 40P01` note);
  0 moves cancelled for a deadlock. The 2026-09-07 defect (a deadlock cancelling
  the player's move) is not recurring.
- Pending at 18:06:13: 11 rows, oldest **105 s** (`1c3f2f42-2f60-4946-afc4-9c482f8c83e7`,
  balance, expires in 264 s); none older than its own window; 0 pending older
  than 24h.
- The 17 `original_occupancy_not_recorded` cancels all fall between 17:30:57 and
  17:31:41 UTC: they are moves planned BEFORE migration `20260909173145
  bind_cash_seat_moves_to_original_occupancies` (recorded on production at
  ~17:31:45) and executed by the new executor, which refuses a move with no
  `source_occupancy_id`. A one-time transition cost: all 17 players were
  re-planned within 60-120 s and every one is seated now (read 18:06:35). Row
  ids: `6beb4cd4-30f9-4c4e-83e4-42fdb3254a43`, `58b66d4d-64af-4b43-8e72-ca6011be3b4a`,
  `8fc880bc-6ba5-4d20-bf7f-c1b109065d0c`, `caf3ef96-c3bd-4561-9fdc-53ceb5215cec`,
  `bd4de2af-00a2-469e-8933-dca50dd8865a`, `bdaa71c8-f300-4c3c-bcbf-4751ec30a448`,
  `fe6a38c0-de93-4ef6-8e2a-0c7895a6c240`, `0734fd7c-fcce-4a4b-be34-eb6a8c8e9912`,
  `81183f1c-ea0e-4744-8ad5-73b3c0c06efd`, `cc640733-4ce2-428f-b34e-ef2b75646e0c`,
  `fbf942e3-7692-4267-88af-75f9914d59ee`, `1d67b51b-7b3f-4440-b4fd-52cafabfefbd`,
  `b6df00ce-fbbc-481d-ac15-2a994d561dd6`, `7261cdae-606f-47f1-85f6-0ea92d3bef31`,
  `8ca193e3-eba7-4b43-912e-aa5c3128e028`, `12860d77-86ff-4815-bbaa-f5368cc79851`,
  `7c91e1b3-3648-4802-b0be-5d9e32580a0d`. The one `original_occupancy_gone`
  (`8ba7e44a-6134-4590-935c-db5b49f67299`, 18:00:21) is the new executor doing its
  job: the chair the move was planned from had already been vacated.

## 6. FINDING J-1 (P1): the balancer and the must-move step move the same players back and forth, every hand

This is the largest thing on the floor right now and it is not in any handoff.

Direction of every DONE move in the last hour, by reason and by the roles of
the two tables (read 18:06:53 UTC / 13:06 CDT):

| reason | direction | n |
| --- | --- | --- |
| balance | main -> feeder | **381** |
| must_move | feeder -> main | **394** |
| must_move | main -> main | 9 |
| seat_change | main -> feeder | 1 |

Exact round trips in that hour (a `balance` move main->feeder followed by a
`must_move` move of the SAME player from that feeder back to that SAME main):
**355 of 383** balance moves (read 18:07:05 UTC). Median gap between the two
legs **37.7 s**, mean 69 s. 47 players were moved 787 times in the hour; the top
two (`3ebbefd2-c468-4853-8576-10104335b319` and
`4e6679f8-7ad4-4551-8ab6-8a1168ed95e3`, both in game
`e942e4c1-3573-423e-9a4b-d25040ddf3a3` NLH 0.25/0.50 Classic) were moved **55
times each** in 60 minutes, one move every 65 s. Per game: NLH 0.50/1 Classic
217 moves / 16 players; NLH 0.25/0.50 Classic 213 / 15; NLH 1/2 Classic 207 / 12;
PLO5 0.50/1 Classic 132 / 12. In NLH 0.25/0.50 Classic the feeder saw 103 seats
leave and 105 arrive in the hour while the game gained nobody (read 18:08:33).

Worked example, one player (`d6cd970a-844a-4531-ae66-479583567335`, game
`e31c71e4-315e-4970-8f1b-3a465062ef08` PLO5 0.50/1 Classic), read 18:06:35 UTC:
18 consecutive DONE moves between 17:33:01 and 18:04:25, strictly alternating
`balance` / `must_move` / `balance` / `must_move`, e.g. `3bf55514` balance
17:33:45 -> `1d55eda6` must_move 17:34:14 -> `9883d1f1` balance 17:37:06 ->
`96410390` must_move 17:38:04 -> ... -> `ebf61633` must_move 18:04:25.

Mechanism, read from the LIVE function bodies (md5 of `pg_get_functiondef`:
`fn_cash_cluster_tick` ae91ea39aef3746371029528cb8e343d,
`fn_cash_clusters_tick_all` 56c15668b184c2d79b79fec3303e363d,
`fn_cash_cluster_balance` read in full at 18:07):

1. `fn_cash_clusters_tick_all` calls `fn_cash_cluster_tick(game)` and then
   `fn_cash_cluster_balance(game)` on every pass, ~every 5 s.
2. Step 2 of the tick (MUST-MOVE, 1.3 s9.5) plans the longest-seated feeder
   player onto EVERY main with an unreserved open seat, Main 2..N included.
3. `fn_cash_cluster_balance` (migration `20260906011318`) builds its pool from
   every live table EXCEPT Main 1, so the pool is Main 2..N PLUS the feeder;
   when the fullest table has 2 more than the emptiest table with room
   (`hi.n - lo.n >= 2 AND hi.n >= 3 AND lo.n >= 1`) it moves the NEWEST arrival
   from the fullest table to the emptiest. With Main N full at 6 and the feeder
   at 4, that moves a player Main N -> feeder.
4. That vacates a seat on Main N. The next tick's step 2 sees a main with an open
   seat and plans the longest-seated feeder player back onto it. The feeder is
   back to 4, Main N back to 6, and the balancer fires again.

The two rules contradict each other by construction: must-move holds every
main FULL (the migration's own header says "Main 1 is held FULL on purpose and
is not part of the balancing pool"), but the balancing pool includes Main 2..N,
which must-move also holds full, and the feeder, which must-move drains. The
migration header intended "the must-move tables are balanced among themselves"
(the FEEDER tables, in a room with several); with `allow_second_feeder = false`
on all 109 games (read 18:08:33) there is never more than one feeder, so the
only thing the balancer can ever do here is fight step 2.

What a player sees: a table that stops for a move every hand or two, a seat
change they never asked for every 65 s, and the "Moving After This Hand"
interstitial as the normal state of the game. Dan's 10.5 standard is "people
would notice"; this is noticeable in one orbit. Not a money defect: every move
in the sample conserved the stack (the new executor asserts
`SEAT_MOVE_CONSERVATION_FAILED` otherwise) and no move expired in the hour.

How long it has been happening (hourly, DONE moves, from 2026-09-08 12:00 UTC,
read 18:07:20): balance main->feeder has been present every hour of the last 30
(low 0-10 per hour overnight, 168-227 per hour on 2026-09-08 12:00-14:00 and on
2026-09-09 09:00-10:00 and 16:00), and peaked at **377 in the 17:00 UTC hour**
with 46 players on the floor. It scales with how full the mains are, which is why
it is worst exactly when the floor is healthiest.

Fix owner: the integrator / lane owning `fn_cash_cluster_balance`. Lane J's
reading of the two written rules (OPORD 18.2 step 2 and the 20260906011318
header): the pool must exclude every table that must-move holds full, i.e. it
should balance FEEDERS among themselves (and mains only when no feeder exists),
or the balancer must never move a player OFF a main while that main's seat would
be refilled from the feeder. Whichever is chosen needs the round-trip test:
"after a balance move, the next tick plans no must_move that reverses it".

## 7. `controller_tick_error` taxonomy, 24h (read 18:09:02 UTC / 13:09 CDT)

| sqlstate | message | n | games | last at (UTC) |
| --- | --- | --- | --- | --- |
| 55P03 | canceling statement due to lock timeout | 8 | 6 | 04:26:10 |
| 23505 | duplicate key value violates unique constraint "cash_seat_moves_one_pending_per_player" | 2 | 2 | 05:08:03 |
| 40P01 | deadlock detected | 2 | 2 | 04:00:37 |
| XX000 | cannot find parent statement on pldbgapi2 call stack | 2 | 1 | 11:16:14 |
| P0001 | This table cannot be closed while players are seated | 1 | 1 | 2026-09-08 19:48:46 |

15 errors in 24h against ~1.9M game-ticks; 0 in the last hour. Every one is
retried on the next pass. Rows worth a look by the owning lane: event 198994
(P0001, NLH 1/2 Action table `cae0f40f-c5d0-4a8b-8715-204faab2ada7`: the tick
tried to close a table that still had a seat); events 206819 and 226166 (23505:
two planners in one pass inserted a second pending move for one player, the
constraint held).

## 8. Games ticked vs enabled, and the engine leader (read 18:09:17 UTC / 13:09 CDT)

| measure | value |
| --- | --- |
| enabled games | 109 |
| enabled games with `last_tick_at` in the last 90 s | **109 / 109** |
| in the last 30 s | 108 |
| live enabled games ticked in 90 s | 47 / 47 |
| disabled games ticked in 90 s | 0 |
| newest `last_tick_at` | 18:09:17.456 (the read minute) |
| oldest enabled `last_tick_at` | 18:08:43 |
| `engine_leader` | instance `1-931ef9fb`, **engine_version `5dd902e9`**, acquired 17:56:23 UTC (the :55 restart), heartbeat 18:09:14 (3 s old) |

The two FLO8 closed/waiting tables of section 2 sit on DISABLED games, which is
why "0 disabled games ticked" is consistent with them not being repaired.

Git, host terminal, read 18:08-18:09 UTC (`git fetch origin main` first):

- `origin/main` = `320246c91a` (18:08:14 UTC, #3984). The worktree base
  `98ef24c6a1` (#3757, 17:41:40 UTC) IS an ancestor of origin/main; origin/main
  is 4 commits past it (#3616, #3977, #3979, #3984: native app assets, cashier
  history recovery, native audio, diamond docs).
- `git merge-base --is-ancestor 5dd902e9 origin/main` -> **yes**. The engine
  runs #3971 (`agent/codex poker audit sep09/fix/phase three break ownership`,
  17:29:27 UTC).
- The engine is **7 commits behind origin/main**: #3973 (a player the felt has
  lost is out of the event), #3972 (diamond custody), #3757, #3616, #3977,
  #3979, #3984. `git diff --stat 5dd902e9..origin/main -- server/src` touches
  ONLY `server/src/services/DiamondCustody.ts` and its test; **no
  `server/src/cluster/**`, `HorseFleetManager`, `HorseSessionRotator`, engine
  seat or must-move code is missing from the running engine as of 18:09 UTC.**
  (Re-checked at the end of the session in section 16.)

## 9. Production function bodies that are NOT on `origin/main` (read 17:31-18:10 UTC)

`supabase_migrations.schema_migrations` (read 18:06:40) records these versions
applied between 17:21 and 18:06 UTC today, i.e. DURING this audit:
`20260909172143 bind_cashout_requests_to_seat_occupancy`,
`172241 table_close_requires_every_occupancy_cashout_to_commit`,
`172312 admin_departure_authority_is_recorded_before_cashout`,
`172350 one_committed_cash_game_seat_per_player`,
`172447 retire_cluster_duplicate_chair_cashouts_after_native_ownership`,
`172529 terminal_tables_cannot_commit_live_occupancies`,
`172615 retain_original_admin_departure_outcomes`,
`173145 bind_cash_seat_moves_to_original_occupancies`,
`175543 ca_a_chair_change_is_not_a_fifth_game`,
`175754 ca_a_tournament_seat_moves_in_one_transaction`,
`175822 ca_stranded_players_come_back_to_the_felt`,
`180316 ca_the_cap_is_at_the_door_not_at_the_chair`,
`180615 maintenance_ownership_fits_process_lifetime`.

`git ls-tree origin/main -- supabase/migrations` (18:09 UTC) holds a file for
NONE of those 13 versions, and the worktree contains no file mentioning
`source_occupancy_id`, `one_committed_seat_per_game_player` or
`original_occupancy_not_recorded`. The live `fn_cash_seat_move_execute`
(8,511 chars, receipts table `cash_seat_move_receipts`, occupancy-bound source
row, `SEAT_MOVE_CONSERVATION_FAILED` assertion, per-user advisory locks) and the
live `fn_cash_cluster_tick` (comments "Active seats cannot commit against a
closed parent", "Native committed ownership makes duplicate-chair cashout
unnecessary") are therefore ahead of every file on `main`. Also under a version
`main` does not have: `035407 a_classic_game_has_no_antes_and_no_bombs`
(worktree has `20260909035303_...`), `035745`/`035821 status_follows_lifecycle`
(worktree has `035726`), `051111 retire_sql_eviction...` (worktree has `045227`):
the MCP `apply_migration` timestamp drift the 2026-09-07 handoff describes.

Integrator: whichever lane/branch owns the 13 above must land those files, or
the next agent will "restore" the older bodies from the repo. Ten of them were
applied inside 45 minutes of US daytime, one statement-batch each; section 10
shows what that cost.

## 10. `financial_alerts` unresolved mentioning cash / cluster / seat / settlement_barrier (read 18:11:25-18:11:32 UTC / 13:11 CDT)

Sources matching the lane's terms, unresolved:

- `ServerTableEngine.post_commit_obligations_pending` (critical): **15 rows**, all
  created 18:04:14-18:04:17 UTC, ALL on cluster tables, plus 2 mirrored
  `drift_incident:financial_alerts:ServerTableEngine.post_commit_obligations_pending`
  rows at 18:04:14. Context on `43df56de-1743-4f00-83e5-7fc34631662c`: "post-commit
  obligations RPC failed: Error: supabase_timeout", attempts 1; the other 14 say
  attempts 0, error null. Table ids: `9395346e-7695-4f16-82fc-4e21f260fb83`,
  `2402ef6a-8e66-4e13-96f0-fd0eabab80b8`, `0065ba44-cd38-4190-86a0-e56ffe032caf`,
  `926c5a4f-343e-4157-86a0-2b13fea8c865`, `0c68c138-c3ed-4088-ad5e-318fea4b9e7e`,
  `58b2c844-9057-445e-ae0b-7850edcf9078`, `c7125559-b474-4931-b8cb-6b0899c51d8d`,
  `4effdeb2-ae6e-4e9d-bb27-997fee51d2bf`, `15104cdb-0c5e-47f1-b5c1-a9f42d29f1b6`,
  `c6ddae05-defe-48ae-abef-0da2f338b26f`, `15251a24-d0ca-4391-9c85-9b0f851470f3`,
  `42ad5814-ae7a-4fc8-9fa8-666ca6092c69`, `28dfed65-d85f-4566-98f9-9070cdab5f8d`,
  `096047a1-c9e2-4877-a28c-e3845451d587`, `4b2c6694-241d-47ef-8513-6983045dbc94`.
  The minute matches migration `20260909180316` being applied (~18:03-18:04);
  every DDL statement reloads the PostgREST schema cache (~28 s on this
  database, CLAUDE.md section 2), and the engine's post-commit RPC timed out
  behind it. All 15 hands exist in `hand_history` and all 15 were still in
  `hand_projection_outbox` at 18:12:00.
- `fn_ca_release_broke_seats` (warning, 17:30:01 UTC, `1e8b304b-076e-4668-b1a6-9c216b7065a3`):
  "10 chair(s) held at exactly zero chips were released and their players recorded out".
- `fn_cash_pot_conservation_check` (warning, 2026-09-06 14:34, 1 row, old).
- Everything else unresolved is tournament / satellite / spin / diamond
  (533 `Satellite.stuck_completing_unawarded`, etc.) and outside this lane.

### FINDING J-2 (P1, adjacent to the lane): the hand projection outbox was not drained for ten hours

`hand_projection_outbox` (read 18:12:00 UTC / 13:12 CDT): **108,823 rows, oldest
08:13:11 UTC**, i.e. EVERY hand committed since 08:13 was still waiting for its
side-effect projection (`fn_project_hand_side_effects`: stats, missions,
rakeback basis; the "stats leave the hot path" design of `20260908042100`).
Per hour of arrival: 08:00 17,577; 09:00 23,113; 10:00 18,157; 11:00 8,763;
12:00 4,840; 13:00 5,682; 14:00 6,212; 15:00 7,234; 16:00 7,562; 17:00 7,899;
18:00 1,784 (partial). Re-read 18:13:21: 108,523 rows, oldest 08:14:13, so the
drainer is running again since the 17:56 cutover at ~300 rows / 81 s
(~13k/h) against ~7.5k/h arriving: at that rate the backlog clears in roughly
20 hours. The drainer (`server/src/services/supabase/handProjection.ts`) is
event-driven from a realtime INSERT subscription plus `DRAIN_MAX = 1000` per
pass; a stall from 08:13 to 17:56 means the engine process that held the
subscription stopped draining and nothing measured it (10.86 rule 3: a guard
with no reader). Every player's stats, missions and rakeback basis for hands
between 08:13 and now are late by up to ten hours. Owner: the engine lane;
this lane only measured it.

## 11. Template compliance right now

### 11a. Game snapshot vs `fn_cash_template_defaults` (read 18:13:38 UTC / 13:13 CDT)

109 enabled games, 0 with a null snapshot. Comparing snapshot keys to the
defaults function (live body: classic ante `none` / bombs off / VPIP 0; action
ante `sb` / bombs `timed_15m` x2 / VPIP 30; madness ante `bb` / bombs
`every_orbit` x3 / VPIP 50; seats PLO 6 locked, holdem classic 9 with choices
[9,6], others 6):

| key | games disagreeing |
| --- | --- |
| regular_ante | **0** |
| bombs.enabled | **0** |
| bombs.trigger | 0 |
| bombs.ante_bb | 0 |
| vpip_floor | **0** |
| seats | 9 (all NLH/FLH classic snapshots say 6, default 9; 6 is inside the template's `seat_choices` [9,6] and 8 of the 9 were `adopted_from` an existing 6-max table) |
| min_buyin_bb / max_buyin_bb | 5 (FLO8 0.25/0.50 Classic and FLO8 0.50/1 Classic snapshot 400/1000 vs default 40/200; PLO4 1/2, PLO6 0.25/0.50, PLO6 2/5 Classic 100 vs 40) |
| seat_choices | 14 (locked to [6] on adopted tables) |

Every other differing key (`sb`, `bb`, `options`, `table_mode`, `adopted_from`,
`resolved_at`, `created_by`) is a snapshot-only key the defaults function does
not emit. **On the three keys that define the template (ante, bombs, VPIP) all
109 agree.** The seat and buy-in differences are choices the snapshot was
allowed to make at creation, not drift.

### 11b. Open tables vs their template (read 18:14:15 UTC / 13:14 CDT)

137 open tables on enabled games (classic 97, madness 20, action 20):

| template | tables | ante_enabled | ante > 0 | bomb_pot_enabled | nit_game | bb_ante | bomb config | ante config |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| classic | 97 | **0** | **0** | **0** | **0** | 0 | (columns still say every_n_hands x2, 1 board, but enabled=false) | ante 0 / maintain 0% |
| action | 20 | 20 | 20 | 20 | 20 | 0 | timed x2, 2 boards, 900 s, min 2 players | ante = sb (0.25 / 0.50 / 1 / 2; ante_bb 0.5 or 0.4 at 2/5), maintain 30%, 10 hands |
| madness | 20 | 20 | 20 | 20 | 20 | 20 | once_per_orbit x3, 2 boards, min 2 | ante = bb (0.5 / 1 / 2 / 5; ante_bb 1), maintain 50%, 10 hands |

Classic tables carrying an ante, a bomb or a VPIP floor: **0 of 97**. Action /
Madness tables missing any of them: **0 of 40**. The 2026-09-09
`a_classic_game_has_no_antes_and_no_bombs` migration holds on the live board.

Two exceptions on capacity (read 18:14:37): `max_players` disagrees with the
snapshot's `seats` on **2 tables**, both PLO5 classic Main 1 rows carrying
`max_players = 7` on a 6-handed, seats-locked PLO template:
`096047a1-c9e2-4877-a28c-e3845451d587` (PLO5 0.10/0.25 Classic, 3 seated) and
`2755c54c-d55f-4400-babe-e9bd97ae532a` (PLO5 0.50/1 Classic, **7 seated**, one
more than the template allows). `fn_cash_apply_ruleset` corrects antes, bombs
and the VPIP floor every tick (section 9 of the tick) but evidently not
`max_players`. **FINDING J-3 (P2)**: a seventh chair on a six-max PLO table; the
snapshot says `seats_locked = true`.

Straddle: `straddle_enabled` 0 and `auto_utg_straddle` 0 on all 137 (the two
columns the engine reads, `ServerTableEngineBase.ts:2364`, `ServerTableEngineSeating.ts:1510`);
the legacy `enable_straddle` / `allow_straddle` columns are `true` on 133 of 137
and `straddle_type = 'utg'` on all 137, but nothing in `server/src` reads them.
P3 hygiene, no player effect. `run_it_twice` on 104 of 137.

## 12. Horse band distribution vs enabled games per band (read 18:15:14-18:15:25 UTC / 13:15 CDT)

| band | enabled games | horses seated at cash (distinct) | human seats at cash |
| --- | --- | --- | --- |
| micro | 59 | 75 | 0 |
| low | 33 | 105 | 0 |
| mid | 16 | 7 | 0 |
| high | 1 | 0 | 0 |

- Horses at cash cluster tables: **154 distinct** (297 on 2026-09-07, 348 on
  2026-09-06). Human seats at cash: **0**, unchanged from the handoff.
- `ca_horse_fleet_state`: 637 `seated` rows, every one backed by a real open
  chair (0 stale); of those **136 are at cash tables and 501 at tournament
  tables**; 363 `idle` (micro 76, low 165, mid 122). By lane: cash 329, events
  329, both 342. `ca_horse_fleet_policy` (global): enabled, no caps, bias 1.0,
  no band/variant/schedule restriction, `pause_new_seatings = false`.
- The floor is therefore small today because the fleet is at tournaments, not
  because horses are barred from bands: mid has 16 enabled games and 122 idle
  mid-band horses, yet only 7 horses at mid cash.

## 13. Seat change requests, 24h (read 18:15:39 UTC / 13:15 CDT)

| status / note | n |
| --- | --- |
| moved / seat_open | 42 |
| moved / swap | 4 |
| cancelled / left_table | 3 |
| cancelled / left_game | 1 |

Open (`requested`) right now: 0. `left_table` cancels since the 2026-09-07
16:45 UTC fix: 5; of those, requests whose player still holds the game with the
allowance NOT restored and no later request: **0**. Roster rows open with the
allowance spent: 2, both with a delivered (`moved`) request behind them; spent
with no live or delivered request: 0. The three 24h `left_table` cancels took
43 min, 10 min and 5 min from request to cancel
(`f284f8f7-0dab-490c-812c-dcdf63bc30d7`, `2b01f719-3d83-41c6-af35-b2f094884342`,
`13f72213-bc8b-44c0-9070-a8664b02a23f`), which is the cluster moving the player
off the chair they asked from before the change could be planned (section 6 is
why).

## 14. Players on closed / breaking tables (read 18:15:50 UTC / 13:15 CDT)

Seated on a closed cluster table: 0. Seated on a breaking table: 0 (0 breaking,
0 opening). Seated on any closed cash table: 0. Cluster seats at zero stack: 0.
Cluster seats `leave_pending`: 0.

## 15. CORRECTION to section 9, read 23:49-23:52 UTC (18:49 CDT) after the session was resumed

Section 9 was written at 18:10 UTC against a worktree based on `98ef24c6a1`
(17:41 UTC). It said the 13 migrations applied 17:21-18:06 had no file on
`origin/main`. That was true of the tree I could see and is NOT true of
`origin/main` as of 23:49: PR #3974 `Bind Cash Departures And Seat Transfers To
Atomic Occupancy Receipts` (`bb4401d5ca`, merged **18:29:29 UTC**) carries eight
of them, and PR #3994 (`15552f9ce5`, merged 23:10:08) carries four more. What
remains true, and matters to the integrator:

| ledger version (production) | file on origin/main | note |
| --- | --- | --- |
| 20260909172143 bind_cashout_requests_to_seat_occupancy | `20260908220604_...` (#3974) | ledger version <> file version |
| 20260909172241 table_close_requires_every_occupancy_cashout_to_commit | `20260909024909_...` (#3974) | same |
| 20260909172312 admin_departure_authority_is_recorded_before_cashout | `20260909040806_...` (#3974) | same |
| 20260909172350 one_committed_cash_game_seat_per_player | `20260909052547_...` (#3974) | same |
| 20260909172447 retire_cluster_duplicate_chair_cashouts_after_native_ownership | `20260909054702_...` (#3974) | same |
| 20260909172529 terminal_tables_cannot_commit_live_occupancies | `20260909062236_...` (#3974) | same |
| 20260909172615 retain_original_admin_departure_outcomes | `20260909072021_...` (#3974) | same |
| 20260909173145 bind_cash_seat_moves_to_original_occupancies | `20260909074353_...` (#3974) | same |
| 20260909175543 ca_a_chair_change_is_not_a_fifth_game | same version (#3994) | ok |
| 20260909175754 ca_a_tournament_seat_moves_in_one_transaction | same version (#3994) | ok |
| 20260909175822 ca_stranded_players_come_back_to_the_felt | same version (#3994) | ok |
| 20260909180316 ca_the_cap_is_at_the_door_not_at_the_chair | same version (#3994) | ok |
| 20260909180615 maintenance_ownership_fits_process_lifetime | **MISSING** | no file on origin/main at 23:49 |
| 20260909035821 status_follows_lifecycle_without_stealing_the_row_count | **MISSING** | no file on origin/main at 23:49 |
| 20260909035407 a_classic_game_has_no_antes_and_no_bombs | `20260909035303_...` | ledger drift only |
| 20260909035745 status_follows_lifecycle_down_as_well_as_up | `20260909035726_...` | ledger drift only |
| 20260909051111 retire_sql_eviction_that_bypasses_the_live_hand | `20260909045227_...` | ledger drift only |

So: eight cash-occupancy migrations are recorded on production under a version
that no file carries (the MCP `apply_migration` timestamp drift the 2026-09-07
handoff describes, section 4 item 4), and TWO applied migrations have no file on
`main` at all. Lane E's `20260909181230` (its E2 fix) also has no file on
`origin/main` at 23:49; it is presumably still on a lane branch.

## 16. Engine version, re-read 23:48:14-23:49 UTC (18:48 CDT)

- `engine_leader`: instance `1-a6f38901`, **engine_version `b53ad9b2`**, acquired
  **21:56:17 UTC** (the 21:55 restart), heartbeat 23:48:13 (1 s old).
- `git merge-base --is-ancestor b53ad9b2 origin/main` -> **yes**. `b53ad9b2`
  is #4032 (`docs: verify Diamond phase four publication and acceptance`,
  21:41:49 UTC). `98ef24c6a1` (the audit's worktree base) IS an ancestor of the
  running engine, so everything on main up to 17:41 UTC is running.
- `origin/main` at 23:49 = `01339ef13f` (#4051, 23:49:03). The engine is
  **17 commits behind**. `git diff --stat b53ad9b2..origin/main -- server/src`
  changes 26 files (2,140 insertions): `HorseLogic.ts` (+236), `HandController.ts`
  (+91), `ServerTableEngineTurns.ts` (+329), `PokerEngine.ts`, `VariantRules.ts`,
  `HorsePreflop.ts`, `HorseDataLedger.ts`, `horseDecision/*` (phase-5 worker),
  `services/supabase/rake.ts` (#4049), `tournament/blindEscalation.ts`, `types.ts`,
  plus tests. Of the cash/cluster/must-move surface the brief names, the engine
  lacks exactly two commits: **#4034** `feat(horses): add canonical phase five
  decision state` (21:55:29) and **#4051** `fix(horses): close Phase 5 Round 1
  safety gaps` (23:49:03). Nothing under `server/src/cluster/**`,
  `HorseFleetManager.ts`, `HorseSessionRotator.ts`, `HorseGameLoad.ts`,
  `services/supabase/seatMoves.ts`, `nitGame.ts`, `handProjection.ts` or
  `tables.ts` differs between the running engine and `origin/main`.
- What the engine DOES already carry from today (all `E` = ancestor of
  `b53ad9b2`): #3974 (occupancy receipts, 18:29), #4002 (V31 horse audit
  defects, 19:39), #3716 (atomic settlement authorities, 20:10), #4013 (20:37).
- Lanes D, E and F: as of 23:49 none of your engine fixes is on `origin/main`
  under the file names your reports cite (verified 23:56 UTC on `origin/main`:
  `HorseSessionRotator.ts` last changed by #3733 on 2026-09-08 14:30, so the
  embed fix is not there; `HorseVpipFloor.test.ts` last changed by #4034;
  `refreshRakeConfig` in `ServerTableEngineBase.ts:5388-5404` still selects
  `rake_percent, rake_cap_bb` plus the thirteen bomb columns and none of the
  ante / VPIP columns, so lane E's E1 is not there either).
  Until they merge AND a :55 cutover adopts them, players are on `b53ad9b2`.
  Never read this off `/health`; it is cache-frozen (CLAUDE.md 11.1).

## 17. Cross-checks of the other lanes' live findings

**17a. Lane A: "102 of 269 move expiries in 48h fall in the two 5-minute buckets around :55".** Read 23:50:46 UTC.
Bucketing `cash_seat_moves.state='expired'` by the 5-minute bucket of
`expires_at`, window 2026-09-07 18:44 to 2026-09-09 18:44 (lane A's window):
**268 expiries, 102 in the :50-:54 (42) and :55-:59 (60) buckets = 38.1%**;
every other bucket 9 to 27. Same shape in the 48h ending 23:50: 283 expiries,
103 in :50-:59 (44 + 59), other buckets 11 to 31. **CONFIRMED** (268 vs 269 is
a window-edge row). Note taxonomy in the current 48h: 278
`engine_did_not_execute_before_expiry`, 4 `player_left_before_boundary`, 1 with
no note.

**17b. Lane A: "two FLO8 games have last_tick_at NULL and have never ticked".** Read 23:50:56-23:51:02 UTC.
`cash_games` with `last_tick_at IS NULL`: **15**, all `enabled = false`, all
closed on 2026-09-04 21:47-21:51 within 40 s of creation, and **0 enabled games
with a NULL tick**. Exactly two of the 15 still own a non-terminal table:
`14dfcb84-7d6c-43bd-8976-58ce59b3e715` FLO8 0.50/1 Action (table
`fd9335bb-894c-451f-8514-59e15d0785d1`, status waiting / lifecycle closed,
`updated_at` 23:00:00) and `1ff1ef89-a29f-41a1-b7f8-9cf123baf09b` FLO8 0.50/1
Madness (table `b652e87b-36eb-4f30-9181-8cb02b52f7a8`, updated_at 21:56:43).
Each game has exactly one `cash_cluster_events` row ever. **CONFIRMED.** (This
is the same pair as section 2; lane A's diagnosis that `fn_cash_clusters_to_tick`
never admits them because the only table is `lifecycle='closed'` matches the
`status_followed_lifecycle` repair never having fired for them.)

**17c. Lane B: "137 moves per 24h cancelled player_not_seated".** Read 18:06:00 UTC:
`state='cancelled' AND note='player_not_seated'` over the 24h ending 18:06 =
85 (must_move) + 52 (balance) = **137. CONFIRMED** to the row. The same count
over the 24h ending 23:53 is 96 (the window has rolled past the 2026-09-08
evening peak).

**17d. Lane F: "the horse session rotator was dead from 17:23 to 20:55 UTC today; four cluster tables held one horse for 415, 129, 121 and 54 minutes against a ten-minute rule".** Read 23:51:14-23:52:28 UTC.
- The departure side, from `cash_player_session` closes by horses at cluster
  tables, half-hour buckets (voluntary = the rotator's own leave):
  16:00 18, 16:30 6, 17:00 6, **17:30 0, 18:00 2, 18:30 1, 19:00 2, 19:30 0,
  20:00 1, 20:30 0**, then **21:00 33**, 21:30 12, 22:00 31, 22:30 12. Six
  voluntary horse departures in the 3.5 hours 17:30-21:00 against 33 in the
  half hour after 20:55. **CONFIRMED** on an independent signal; the recovery
  minute matches migration `20260909205508` exactly.
- The four lone-horse tables: reconstructing seat state at 18:55 from
  `table_seats` is NOT reliable, and this is worth writing down: table
  `054b9cf1-3e3d-47d2-ac4c-5ab47cf9c6f8` (PLO8 0.50/1 Classic Feeder) dealt
  six-handed hands at 18:50-18:53 (hand 8740267 onward, players c649f5ce,
  11758a4f, 4dbd99cd, 9049783c, ed8f5032, 94cb32db) yet holds only six
  `table_seats` rows ever, five of them with `joined_at` after 21:11. A chair's
  row is rewritten when the cluster moves the player, so `joined_at` is the
  time of the LAST move, not the sitting. Any "minutes seated" read from
  `table_seats` after a move is therefore wrong in both directions. Using
  `hand_history` instead (a table with one player deals no hand): at 18:55
  Pineapple 0.25/0.50 Classic (`54fb37a9-e824-4b89-b28b-ba7ff62134f2`) had dealt
  no hand for **73 minutes** (last 17:41:49, two players) and PLO5 1/2 Classic
  Feeder (`0a75de17-4792-4c68-b4c9-fb71db7496c6`) for 13 minutes; the seat-row
  reconstruction shows a further 7 tables with one reconstructed seat and no
  hand in the prior ten minutes. Lane F's count of four tables is plausible and
  its 129 matches this lane's 130 on NLH 1/2 Classic Feeder
  (`94cb32db-d0c0-408a-9a4f-13e66d56d2c2`, seated 16:45:11); the 415 and 121 are
  not independently reproducible for the reason above. **Verdict: CONFIRMED in
  substance (rotator dead 17:23-20:55, lone horses far past ten minutes), the
  specific minute figures unverifiable from the rows that survive.** Since
  `20260909173145` every executed move leaves a `cash_seat_move_receipts` row,
  so from today this reconstruction is possible going forward.

**17e. Lane C: "0/109 games and 0/140 tables disagree with their template".** Read 23:52:54 UTC.
141 open tables on enabled games (classic 101, action 20, madness 20). Classic
tables carrying `ante_enabled`, `ante > 0`, `bomb_pot_enabled`, `nit_game` or
`maintain_percent_min > 0`: **0 of 101**. Action/Madness tables missing any of
those five: **0 of 40**. Action tables off the template on trigger `timed` /
900 s / x2 / 2 boards / 30% / 10 hands / `ante = small_blind`: **0 of 20**.
Madness tables off `once_per_orbit` / x3 / 2 boards / 50% / 10 hands /
`ante = big_blind` / `big_blind_ante_enabled`: **0 of 20**. Games whose snapshot
disagrees with `fn_cash_template_defaults` on `regular_ante`, `bombs.enabled`,
`bombs.trigger`, `bombs.ante_bb` or `vpip_floor`: **0 of 109**. **CONFIRMED**, with
one qualification lane C's read does not cover: `max_players` disagrees with the
snapshot's `seats` on 2 tables (section 11b, finding J-3), and one of them,
`2755c54c-d55f-4400-babe-e9bd97ae532a` PLO5 0.50/1 Classic Main 1, still has
**7 players seated on a 6-max, seats-locked PLO game** at 23:52.

## 18. VPIP evictions by template, and the felt evidence for antes and bombs (read 23:48:38-23:49:20 UTC / 18:48 CDT)

Hands in the last 60 minutes, `hand_history` joined to `tables` and `cash_games`
(23:48:56 UTC):

| template | hands | tables dealing | bomb hands (`bomb_pot` not null) | `bomb_ante` actions | regular `ante` actions | any ante | straddle | ante on an ante-disabled table | bomb on a bomb-disabled table | no ante on an ante table |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| classic | 3,978 | 67 | **0** | 0 | **0** | 0 | 0 | 0 | 0 | 0 |
| action | 80 | 8 | **8** (all `timed`) | 8 | 72 | 80 | 0 | 0 | 0 | 0 |
| madness | 286 | 14 | **78** (all `once_per_orbit`) | 78 | 208 | 286 | 0 | 0 | 0 | 0 |

Every action and madness hand carries exactly one kind of ante (a bomb hand
posts `bomb_ante` instead of the regular ante: 8 + 72 = 80, 78 + 208 = 286), and
no classic hand carries either. Action's 8 bombs on 8 tables in an hour is one
per table per 15-minute clock at a table dealing ~10 hands/hour; madness's 78
of 286 is one in 3.7 hands. This **agrees with lane E's** 24,000-hand read
(03:00-06:00 UTC: action 45 bombs / 1,386 hands, madness 206 / 784, classic 0
after 03:53) and with its "zero mismatches in 7,652 hands" second read: the three
templates are three games on the felt.

`cash_player_session` closes on cluster tables, 24h to 23:49:20 UTC:

| template | closed sessions | vpip_evicted | system | voluntary | evicted share | avg session | median session | median EVICTED session | evicted last 1h / 4h |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| classic | 1,998 | **0** | 850 | 1,146 | 0.0% | 211.1 min | 131.0 min | n/a | 0 / 0 |
| action | 439 | 88 | 257 | 94 | **20.0%** | 71.9 min | 40.5 min | **10.6 min** | 0 / 0 |
| madness | 627 | 314 | 233 | 79 | **50.1%** | 55.8 min | 19.2 min | **12.6 min** | 14 / 17 |

At 18:16 UTC the same 24h read said madness 577 / action 205 evictions (lane F,
24h to 22:00: madness 586 = 56%, action 206 = 27%). The three reads agree on
shape: **half of every Madness sitting and a fifth to a quarter of every Action
sitting ends `vpip_evicted`, the median evicted sitting lasts 10-13 minutes,
and Classic evicts nobody** (floor 0). This lane's independent read **agrees
with lane F** (P1-F3). The eviction rate is falling through the evening (17 in
the last 4 h, all madness, 14 of them in the last hour), which is consistent
with fewer horses on those tables, not with a fix having landed: lane F's fix
is not on `origin/main` (section 16). Human evictions in 24h: 0 (no human has
sat at a cluster table today).

One thing seen while checking the two-hour bar: 782 evictions in the 24h to
18:16 produced 685 `cash_rejoin_constraints` bar rows (`barred_until` set).
The 166 evictions with no bar row written at that second are players evicted
twice from the SAME game (e.g. `8ef81aac-30ee-4ad5-bc83-20f15046f37d`, evicted
from NLH 1/2 Action Feeder `921d4e03` at 13:08:12 and then from NLH 1/2 Madness
Feeder `1e1e505c` at 13:13:17; the bar row for the game is UPDATEd in place by
`fn_cash_session_close`, so only the latest `left_at` survives). Not a gap in the
bar, but the same measurement caveat as 17d: this table also loses history on
update.

## 19. The floor re-read at the end of the session (23:52:54-23:54:37 UTC / 18:53 CDT)

| measure | 18:05-18:16 UTC | 23:52-23:54 UTC |
| --- | --- | --- |
| open cluster tables | 137 (main 120 / feeder 17) | **141** (main 127 / feeder 14) |
| seats = open roster rows | 306 = 306 | **446 = 446** |
| horses at cash / human seats | 154 / 0 | **230 / 0** |
| nine invariants (over capacity, two chairs, roster/chair both ways, dup/gap main_index, seated on closed or breaking, unaccounted exits) | all 0 | **all 0** |
| `lifecycle closed / status waiting` | 2 | 2 (same two rows) |
| enabled games ticked in 90 s | 109 / 109 | **109 / 109** |
| controller_tick_error, last 1h | 0 | **8**, all `55P03 lock timeout`, on NLH 0.50/1 (3), NLH 0.25/0.50 (2), PLO6 0.50/1 (3), NLH 0.10/0.25 (1): the games in section 6 |
| moves last 1h (done / cancelled / expired / pending) | 787 / 21 / 0 / 11 | **413 / 1 / 4 / 11** |
| balance main->feeder / must_move feeder->main, last 1h | 381 / 394 | **193 / 213** |
| exact balance-then-must-move round trips, last 1h | 355 | **170** (43 players moved; top player `5f7757f0-31e1-40f3-9daa-e2a3fcc064f3` moved **41 times** in the hour) |
| expired % of moves created in 24h | 0.609% | 0.451% |
| oldest pending move | 105 s | 78 s |
| pending past its own expiry | 0 | 0 |
| feeders last 1h opened / live / abandoned | 5 / 3 / 2 | 2 / 0 / 2 |
| `hand_projection_outbox` rows / oldest | 108,823 / 08:13 UTC | **55,522 / 17:07 UTC** (draining, ~7.5k/h net) |
| unresolved `post_commit_obligations_pending` alerts | 15 | **0** (resolved by another lane) |
| new unresolved cash/cluster/seat alerts in the last 6h | - | 0 |

Two things the postgres log adds (`query_logs`, source `postgres_logs`, read
23:53-23:54 UTC; the log carries message text, not function names, so
"mentions fn_cash_" matches only migration bodies):

- **`SEAT_MOVE_GAME_SCOPE_MISMATCH` raised 30 times between 23:01:10 and
  23:04:52 UTC**, and in the same window the moves of NLH 0.25/0.50 Classic
  planned at 22:51:57-22:52:49 (`cb802eda`, `afb5f540`, `68cd2db5`, `174ef0d5`,
  `2fe2b0e9`, `56846b21`) expired with `engine_did_not_execute_before_expiry`;
  five of the six are BALANCE moves whose destination feeder had closed
  (`to_lc = closed`). A migration `ca_a_move_to_a_closed_table_is_cancelled_not_thrown`
  was applied at 23:39:48 by another lane for exactly this window ("2026-09-09
  22:50-23:04, NLH 0.25/0.50 Classic"), so it is recorded here as observed, not
  as a new finding. It is section 6's defect wearing a different note: the
  balancer keeps planning moves onto the feeder even as the feeder breaks.
- Other error text in the last 6 hours, for scale, none of it cash-cluster:
  `permission denied for table tournament_refund_entitlements` 61,116;
  `TOURNAMENT_TRANSITION_BUSY` 18,010; `canceling statement due to statement
  timeout` 4,406; `canceling statement due to lock timeout` 556;
  `TABLE_CLOSING` refusals 22 (00:37-08:28); `CASHOUT_STALE_OCCUPANCY` 5
  (21:19-21:47); `SEAT_CHANGE_USED` 3; `cash_seat_moves_one_pending_per_player`
  duplicate 3.

`cron.job` entries touching cash (read 18:12 UTC): `ca-cash-pot-conservation-hourly`
(jobid 259, `34 * * * *`, active) is the only cash job; the four
`daily-missions-outbox-minute*` jobs drain the mission outbox. No `cron.job`
touches the cluster; the tick runs from the engine's `ClusterController`.

## 20. Ranked list: broken now, degraded, healthy (as of 23:54 UTC / 18:54 CDT)

### BROKEN NOW

1. **J-1 (P1) The balancer and the must-move step move the same players back and forth every hand.** 355 exact round trips in the 17:00 UTC hour, 170 in the 22:53-23:53 hour; players moved 55 and 41 times in an hour; median 38 s between the balance leg and the must-move leg that reverses it. Present in every hour of the last 30. Evidence: `cash_seat_moves` rows `3bf55514-e688-4012-ad02-4068ca610bfd` -> `1d55eda6-8a6c-46a6-9edc-c45290417be8` -> `9883d1f1-d425-49cc-b46c-e1cda5b63c28` -> `96410390-3d1f-4dbb-bd48-be98757c4931` (one player, 17:33-17:38); games `e942e4c1-3573-423e-9a4b-d25040ddf3a3`, `dd7454e1-8e95-455e-9906-f4ca218ff188`, `b59525f3-1f0c-486b-b3f9-578c17f866ad`, `e31c71e4-315e-4970-8f1b-3a465062ef08`. Cause: `fn_cash_cluster_balance`'s pool includes Main 2..N and the feeder while tick step 2 holds every main full from the feeder (section 6). It also drives the 55P03 tick errors (8 in the last hour, all on these games) and the 23:01-23:04 `SEAT_MOVE_GAME_SCOPE_MISMATCH` burst. Owner: whoever owns `fn_cash_cluster_balance` (migration `20260906011318`); the fix needs the round-trip test named in section 6.
2. **J-2 (P1, engine, adjacent) The hand projection outbox stalled for ten hours** (08:13 to ~17:56 UTC; 108,823 rows at 18:12, oldest 08:13:11) and is still 55,522 rows / 6.7 hours behind at 23:48. Stats, missions and rakeback basis for every hand in that window are late; nothing alarmed. The 15 `post_commit_obligations_pending` alerts at 18:04:14-18:04:17 (`supabase_timeout` behind the `20260909180316` schema reload) were the only visible symptom, and they are resolved. Owner: engine lane (`handProjection.ts`); needs a reader for "outbox oldest row age" (10.86 rule 3).
3. **J-3 (P2) A seventh chair on a six-max PLO table.** `2755c54c-d55f-4400-babe-e9bd97ae532a` PLO5 0.50/1 Classic Main 1 carries `max_players = 7` against a snapshot of 6 (`seats_locked = true`) and has had 7 seated at 18:08 and again at 23:52; `096047a1-c9e2-4877-a28c-e3845451d587` PLO5 0.10/0.25 Classic has the same column drift with 0 seated. `fn_cash_apply_ruleset` reconciles antes, bombs and the floor every tick but not `max_players`.
4. **(P2, lane A owns the fix) The two FLO8 tables that can never be repaired**: `fd9335bb-894c-451f-8514-59e15d0785d1` and `b652e87b-36eb-4f30-9181-8cb02b52f7a8`, `status = waiting` / `lifecycle = closed`, on disabled games `14dfcb84-...` and `1ff1ef89-...` that have never been ticked (`last_tick_at NULL`, one event each since 2026-09-04). Confirmed, 17b.
5. **(P2, integrator) Two applied migrations have no file on `origin/main`** (`20260909180615 maintenance_ownership_fits_process_lifetime`, `20260909035821 status_follows_lifecycle_without_stealing_the_row_count`) and eight cash-occupancy migrations are recorded under versions that no file carries (section 15). The next `check-migrations-recorded` style read will call these drift, and the next agent who diffs a live body against the repo will read the repo as newer.

### DEGRADED

6. **Move expiry clusters at the :55 restart**: 102 of 268 expiries in 48h in the :50-:59 buckets (17a, lane A's A2 fix is written, not merged). Expiry overall is 0.45-0.61% of moves in 24h, down from 6.54% on 2026-09-07.
7. **Madness and Action evict half / a fifth of their sittings at the ten-hand check** (section 18, agrees with lane F). Not a wiring defect (the floor is enforced exactly as the template says) but a fleet-tuning defect that empties those tables; classic 0%.
8. **The engine is 17 commits behind `origin/main`** (16), lacking #4034 and #4051 on `HorseLogic.ts`; every lane's engine fix is still unmerged as of 23:49 and reaches players only at a :55 cutover.
9. **Feeder abandonment**: 36 of 194 feeders abandoned in the 24h to 18:05 (18.6%); in the evening lull 2 of 2 in the last hour. `table_opening_hold_expired` 214 in 24h: the one-buyer hold expires more often than not.
10. **Horses at cash vs tournaments**: 154 horses at cash at 18:15 (501 at tournaments, 363 idle including 122 idle mid-band horses against 16 enabled mid games with 7 horses in them); 230 at 23:54. No human has sat at a cluster table in 24h. Fleet allocation, not a cluster defect.
11. **Lock-timeout tick errors on the oscillating games**: 8 in the last hour, 15 in the prior 24h; each retried 5 s later.

### HEALTHY

- All nine invariants clean at 18:05 and 23:54 (over capacity 0, two chairs 0, roster/chair drift 0 both ways with 446 = 446, duplicate/gap `main_index` 0, seated on closed/breaking 0, unaccounted seat exits 0, pending past its own expiry 0).
- 109/109 enabled games ticked inside 90 s at both reads; engine heartbeat 1-3 s old; `last_tick_at` never older than 34 s on an enabled game.
- Template compliance on the felt: 0 classic tables with an ante, bomb or floor; 0 action/madness tables missing one; 0 of 109 snapshots off the template keys; 4,344 hands in the last hour with zero cross-template mismatches (18, agrees with lanes C and E).
- Deadlocks no longer cancel a player's move: 49 `40P01` retries in 24h, all `done`, 0 cancelled.
- Seat-change allowance: 0 open requests, 0 `left_table` cancels since the 2026-09-07 fix with the allowance still spent, 0 `seat_change_used_at` without a request.
- Breaks complete: 187 started / 187 completed in the 24h to 18:05.
- `fn_platform_frozen` short-circuit and the executor's freeze gate are in the live bodies read (sections 6 and 9).

## 21. Coverage: what this lane read in full

Live production function bodies via `pg_get_functiondef` (the truth over any
file): `fn_cash_cluster_tick` (34,999 chars, md5 `ae91ea39aef3746371029528cb8e343d`,
every step 1-7), `fn_cash_clusters_tick_all` (7,143, md5
`56c15668b184c2d79b79fec3303e363d`), `fn_cash_cluster_balance` (whole body),
`fn_cash_seat_move_execute` (8,511 chars, whole body), `fn_cash_template_defaults`,
`fn_cash_stake_band`, `fn_project_hand_side_effects` (first 6,000 chars).
Repo: `supabase/migrations/20260906011318_the_feeder_tables_stay_within_one_player_of_each_other.sql`
(header and planner), `20260905064000_booted_for_low_vpip_is_barred_for_two_hours.sql`
(the bar writer, lines 120-160 and 305-325), `server/src/services/supabase/handProjection.ts`
lines 100-200, `server/src/services/supabase/seats.ts` lines 150-200, the
straddle reads in `ServerTableEngineBase.ts:2364`, `ServerTableEngineDealing.ts:1966`,
`ServerTableEngineSeating.ts:1510`, `services/supabase/tables.ts:32`. Docs:
`docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md` (all), `docs/changelog/2026-09-07-the-feeder-cluster-audit.md`
(all), `docs/OPORD-1.4-AMENDMENT.md` section 18, `docs/changelog/2026-09-07-the-balancer-does-not-move-players-during-the-break.md`,
`lane-A.md` sections 4 (A2, A4), `lane-E.md` lines 1-56, `lane-F.md` (P0-F1, P1-F3).

## 22. Commands run (host terminal, `~/Documents/.agent-trees/club-arena/cowork-mustmove`)

```
git fetch origin main                                    # 18:08 and 23:49 UTC
git rev-parse --short=10 origin/main                     # 320246c91a (18:08) ; 01339ef13f (23:49)
git merge-base --is-ancestor 5dd902e9 origin/main        # yes (18:09)
git merge-base --is-ancestor b53ad9b2 origin/main        # yes (23:49)
git merge-base --is-ancestor 98ef24c6a1 b53ad9b2         # yes
git rev-list --count b53ad9b2..origin/main               # 17
git diff --stat b53ad9b2..origin/main -- server/src      # 26 files, 2140 insertions, 243 deletions
git log --since='2026-09-09 17:00:00 +0000' origin/main -- <cluster/horse/engine files>   # 6 commits, 4 in the engine, 2 not
git ls-tree -r --name-only origin/main -- supabase/migrations | grep <version|name>       # section 15 table
```

No test suite was run and no file outside this report was written: the lane is
read-only. `git status -sb` on the worktree at 23:49 shows the branch
`agent/cowork-mustmove/audit/must-move-classic-action-madness` 60 commits behind
`origin/main` with two files modified by other lanes
(`scripts/dev/probe-cluster-boards.sql`, `server/src/cluster/ClusterController.ts`);
neither is this lane's.
