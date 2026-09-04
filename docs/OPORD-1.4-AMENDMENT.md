# Smarter.Poker Club Arena

# OPERATION TABLE STAKES

# OPORD 1.4 - AMENDMENT TO 1.3

# 04 September 2026

#

# Paste OPORD 1.3, then this file, as the implementing agent's first

# message. Where 1.4 conflicts with 1.3, 1.4 wins. Everything in 1.3

# not touched here still stands.

#

# Two changes of intent:

# 1. 100% of cash games are must-move clusters. There is no

# standalone mode. A one-table game is a cluster with one Main.

# 2. Tables open and close by themselves. No host switch, no admin

# button, no agent, no human, ever. The controller is the host.

## 0. RECON THAT HAS ALREADY BEEN DONE (do not redo, verify only)

These are real paths in the repo as of 2026-09-04. Section 17's first
reply confirms them; it does not rediscover them.

| Need                         | Where it is today                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ---------- | --------- | ------------------------------------------ |
| Fleet / auto-spawn / retire  | `server/src/services/HorseFleetManager.ts`: `ensureAllTablesExist()`, `seedAllTables()` on a 30 s loop, `spawnOverflowTables()`, `retireSurplusTables()`, `MAX_TABLES_PER_CONFIG = 3`, `DEFAULT_TABLES[]` (9 hardcoded cash configs)                                                                                                    |
| Host lifecycle switches      | `supabase/migrations/20260825_table_lifecycle_auto_restart_extension_create.sql`: `fn_table_lifecycle_pass()`, `fn_clone_table_row()`, `fn_launch_table_from_template()`; `tables.auto_restart / auto_create_table / auto_extension`                                                                                                    |
| Engine provisioning          | `server/src/GameServer.ts` discovery loop (5 s) -> RPC `cash_tables_needing_engine(p_min)` (`20260822b_cash_tables_needing_engine.sql`), `server/src/engineStartBudget.ts`                                                                                                                                                              |
| Horse seating                | `HorseFleetManager.seatHorse()` -> RPC `atomic_table_buyin`; `server/src/services/HorseBehavior.ts` (`occupancyTargetFor`, `buyInBBFor`, `isActiveNow`)                                                                                                                                                                                 |
| Horse departures             | `server/src/services/HorseSessionRotator.ts` (90 s), all exits via `ServerTableEngine.leaveTable()`                                                                                                                                                                                                                                     |
| Buy-in                       | RPC `atomic_table_buyin(p_user_id, p_table_id, p_seat_number, p_amount numeric, p_auto_rebuy, p_club_id, p_idempotency_key)`; latest def `20260826_buyin_idempotency_double_insert_voided_every_keyed_buyin.sql`. **It already enforces a per-table opt-in rejoin floor (`tables.no_rathole`, added 2026-08-25) and a four-table cap.** |
| Cash-out / leave             | RPC `atomic_seat_cashout_locked` via `server/src/services/supabase/seats.ts`; `player_leave_table` (tab close); `trg_auto_cashout_on_table_close`                                                                                                                                                                                       |
| Waitlist                     | RPC `fn_offer_open_seat` (60 s `notified` hold + own expiry sweep); `HorseFleetManager.claimOfferedSeats()`                                                                                                                                                                                                                             |
| Money unit                   | **`numeric` chips, not cents.** `min_buy_in = bb*40`, `max_buy_in = bb*200`; band law `src/lib/cashBuyIn.ts`                                                                                                                                                                                                                            |
| Seat law                     | `server/src/config/tableSeating.ts` + `src/config/tableSeating.ts`, parity gated by `scripts/ci/check-seat-law-parity.mjs`. Today: plo6=6, plo5=7, plo4/plo8/flo8=8, else 9                                                                                                                                                             |
| Variants                     | `src/types/club.types.ts` `GameVariant`: `nlh                                                                                                                                                                                                                                                                                           | plo4 | plo5 | plo6 | plo8 | flo8 | short_deck | pineapple | ...`; server copy in `server/src/types.ts` |
| Lobby card                   | `src/components/lobby/game-cards/ArenaLobbyGameCard.tsx` (`arenaGameCardActionsForEntry`: cash branch emits Join Table / View Table / Watch Table), `ArenaGameCard.tsx` zones `title/gameType/stakes/players/buyIn/status/primaryAction`, `src/components/lobby/lobbyEntries.ts`                                                        |
| Tournament lobby / watch     | reuse per 1.3 section 10.2                                                                                                                                                                                                                                                                                                              |
| Feature flags                | None general. Env kill switches only (`DISABLE_HORSE_FLEET`, `MAINTENANCE_MODE`)                                                                                                                                                                                                                                                        |
| Freeze gate                  | `server/src/maintenance/freezeState.ts` `isMaintenanceFrozen()`; thaw `fn_thaw_platform` (CLAUDE.md section 13)                                                                                                                                                                                                                         |
| Must-move / feeder / cluster | **Does not exist.** Nearest analogue is the tournament `TableBalancer`.                                                                                                                                                                                                                                                                 |
| Idle canonical table closer  | **Does not exist.** Only surplus `#2/#3` clones are ever closed.                                                                                                                                                                                                                                                                        |

## 1. RULINGS NEEDED FROM THE OWNER (defaults apply until overruled)

The implementing agent applies the default and states it in the first
reply. It does not stop to ask.

| #   | Conflict                                                                                                                         | Default in 1.4                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 1.3 section 7/8 lock the PLO family at 6 seats. Repo seat law (CI-enforced) is plo6=6, plo5=7, plo4/plo8=8.                      | **1.3 wins: PLO family 6 locked.** Change both `tableSeating.ts` copies and the parity check in the same commit. Existing PLO tables with 7-8 seated keep their chairs; cap applies to new sit-ins. |
| R2  | 1.3 section 3.8 says no straddles. The fleet runs a canonical "NLH Straddle 1/2" table with `straddle_enabled`.                  | **Lane retired.** Its table becomes another table of the NLHE $1/$2 Classic cluster (role by age, section 18.6). Straddle flags forced off on every cash table in the same migration.               |
| R3  | 1.3 section 9.3: "Zero seated -> cluster dead." Today the fleet keeps every canonical table alive at the horse occupancy target. | **Always-on Main 1.** An enabled game never has zero tables; the fleet keeps Main 1 seeded. `dead` is replaced by `dormant` (section 18.4).                                                         |
| R4  | 1.3 section 6.3 uses `_cents`. Repo money is `numeric` chips.                                                                    | **`numeric` chips.** Every `_cents` column in 1.3 is `_chips numeric(14,2)` in repo convention. No cents anywhere.                                                                                  |
| R5  | 1.3 variant enum `plo8o`, `shortdeck`. Repo uses `plo8`, `short_deck`, and also deals `flo8`.                                    | **Repo names.** The variant picker is whatever `ServerTableEngine` deals today, read from the engine, not typed by hand. ROE 16 governs the rest.                                                   |

## 2. CHANGES TO 1.3, SECTION BY SECTION

### 2.1 Section 2 - Commander intent

Replace the "End state" bullets that mention a host or a standalone table:

- Every cash game on the platform IS a must-move cluster. A game with one
  table is a cluster whose only table is Main 1. There is no other kind
  of cash table.
- Nobody creates a table. A host creates a GAME (template, variant,
  stakes). The platform's default games are created at boot from the
  same path. From then on the cluster controller opens, promotes,
  demotes, breaks and closes tables on its own.
- Delete: "Standard standalone table creation and the existing rake
  schedule stay, except chip continuity applies to them." Replace with:
  "The existing rake schedule stays. Standalone table creation is
  removed; the create screen creates a game."

Main effort is unchanged: Slice 0.

### 2.2 Section 3 - Rules of engagement

- ROE 4 and 5: delete the flag language. There is no flag. Nothing in
  this OPORD is opt-in, per-club, or behind a percentage. The cutover
  is one migration (section 18.6).
- ROE 10 becomes: "Do not pre-spawn empty feeders. Do not list a
  1-player table. The ONE exception is Main 1 of an enabled game, which
  the fleet keeps seeded to the horse occupancy target exactly as it
  keeps canonical tables today."
- Add ROE 18: **No human in the lifecycle loop.** There is no button,
  switch, column, admin action, cron or agent instruction that opens or
  closes a cash table. If you find yourself adding one, you are building
  the thing this OPORD removes.
- Add ROE 19: **Horses are players** (CLAUDE.md section 10.5, binding).
  A horse counts as a buyer when deciding to open a table, as the second
  player that lets a table go live, as a must-move candidate, and as a
  seat in every PLAYERS count. A horse obeys the stay clock, the rejoin
  floor, the VPIP floor and the refusal lock identically to a human. If
  `HorseSessionRotator` asks a horse to leave and the server answers
  `LEAVE_LOCKED`, the horse waits like a human would. If a horse's
  bankroll cannot meet a rejoin floor, the horse does not sit, like a
  human would. Never write `is_horse` into any rule in this OPORD.
- Add ROE 20: **The controller must survive the :55 restart.** It is
  stateless: every decision is re-derived from rows each tick. It calls
  `isMaintenanceFrozen()` before moving a seat, a chip or a role, and
  every wall-clock deadline it introduces is listed in section 18.5 and
  added to `fn_thaw_platform` in the same PR.

### 2.3 Section 4 - Hard gates

```
GATE 0 Recon report sent (section 17 as amended in 2.12)
GATE 1 Slice 0 green on every cash table            <- stop until true
GATE 2 Slice 1 create-flow persists a GAME + snapshot
GATE 3 Slice 2 cluster runtime + Slice 6 autonomous lifecycle green
       (A2.1-A2.12 AND A6.1-A6.14 - one gate, they are one feature)
GATE 4 Slice 3 ONE lobby card + cluster lobby + watch
GATE 5 Slice 4 antes + VPIP + double-board bombs
GATE 6 Slice 5 chrome + copy + string-grep clean
GATE 7 Cutover migration applied; zero cash tables outside a cluster
```

"STANDALONE cash" in Gate 1 now means "every cash table as it exists
before the cutover". Slice 0 ships against today's tables; the cutover
inherits it.

### 2.4 Section 5 - Recon

Add to the list, each with a path:

- The existing floor inside `atomic_table_buyin` (the `NO RATHOLE`
  block, gated by the per-table opt-in column `tables.no_rathole`, keyed
  to the TABLE and the player's last stack there). It fails 1.3
  invariant I8 twice: opt-in per table, and table id in the key. Slice 0
  replaces it with `cash_rejoin_constraints` (club + variant + sb + bb,
  always on) and drops `tables.no_rathole`. **One floor, not two.**
- `HorseFleetManager.spawnOverflowTables`, `retireSurplusTables`,
  `MAX_TABLES_PER_CONFIG`, the `#2/#3` naming convention.
- `fn_table_lifecycle_pass` and the three `tables.auto_*` columns.
- `fn_offer_open_seat` and its 60 s hold - the cluster waitlist reuses
  it.
- How union-level default tables (`MIDWAY_UNION_ID`) resolve to a
  `club_id` for the rejoin key (`resolveSeatClub`). State it.
- The four-table cap in `atomic_table_buyin` - this is the "multi-table
  already exists" of A0.15.

### 2.5 Section 6 - Slice 0

- 6.3 and 6.5: `_cents` -> `_chips numeric(14,2)`. `scope_type` is
  always `cluster`; drop the `table` value. `scope_id` is the cluster id.
  Moving between tables of the cluster never touches the session row.
- 6.5: the leave events that write a constraint now include "table
  broken by the controller and player chose cash-out over the move".
  A table broken by the controller where the player is moved is NOT a
  leave (I9).
- 6.6: the existing floor in `atomic_table_buyin` uses the forbidden
  word in its SQL. Internal names may keep it in the database only if
  renaming would churn the money path; it must never reach a client
  string. State your choice in the first reply.
- Horses: A0.2-A0.17 each get a twin where the actor is a horse driven
  by `HorseSessionRotator`. Same result or the slice is red.

### 2.6 Section 7 - Slice 1

- Delete the "two paths" sentence and the `standard_table |
feeder_cluster` mode. The create screen creates a game. The locked
  choice order loses step 1 (Mode) and starts at Template.
- UI label: "New Cash Game", not "Must Move Game". Every cash game is
  must-move, so the phrase carries no information on this screen.
- Persist into `cash_games` (section 18.1), never into `tables`. The
  controller creates the first table.
- Handedness row for PLO family: 6 locked (R1).
- A1.1 becomes: "Creating any cash game creates one `cash_games` row and,
  within one controller tick, exactly one `tables` row with role main,
  index 1, seeded by the fleet. Never two tables. Never zero."
- A1.6 stays.

### 2.7 Section 8 - Template defaults

Unchanged except: `seats PLO family` = 6 locked (R1); `straddle` row
stays off and the column is removed from the overrides panel (there is
nothing to override).

### 2.8 Section 9 - Slice 2

- 9.1 Cluster object is `cash_games` (18.1). `state: live | promoting |
dead` becomes `live | dormant`. `promoting` was a UI state and is
  derived from a table with `role=feeder AND promote_pending=true`.
- 9.3 "a second human will sit that new feeder" -> "a second PLAYER".
  A horse is a player. In practice the fleet's next seeding cycle
  supplies the partner within 30 s if any horse is eligible for that
  game, so the 60 s opening-hold resolves without a human.
- 9.3 "Zero seated -> cluster dead" -> "Zero seated -> the fleet reseeds
  Main 1 on its next cycle. If no horse is eligible (club treasury empty,
  bankrolls exhausted, activity window closed) the game is `dormant`:
  Main 1 stays `waiting` with no engine, the card still renders with
  PLAYERS 0 and TABLES 1. First buy-in wakes it."
- 9.4 Auto-seat unchanged.
- 9.5 unchanged. Add: the controller, not the engine, runs 9.5. The
  engine only reports hand boundaries and seat state.
- 9.8 Break/merge is now specified fully in 18.3. 1.3 section 9.8 is the
  policy; 18.3 is the trigger.

### 2.9 Section 10 - Slice 3

- The two-column tile table collapses to one column: every cash card is
  the cluster column. A one-table game shows TABLES 1, PLAYERS 6/9.
  Never `7/9` in the PLAYERS tile of any cash card, ever.
- `arenaGameCardActionsForEntry` cash branch: `Join Table` / `View Table`
  / `Watch Table` are replaced by `JOIN GAME` / `VIEW GAME` / `WATCH
GAME` (title-cased by the existing popup/label transform where one
  applies). A3.6 greps for the old strings and fails on any hit in the
  cash branch.
- `lobbyEntries.ts`: a cash `LobbyEntry` is a cluster. `players` is the
  cluster sum. `tables` is a new field. The per-table row stays only in
  the cluster lobby drill-in.

### 2.10 Section 13 - Events

Add: `game_created`, `game_dormant`, `game_woken`, `table_opening_hold`,
`table_opening_hold_expired`, `table_break_started`,
`table_break_completed`, `controller_tick_skipped_frozen`,
`controller_tick_error`.

### 2.11 Section 15 - What you will not do

Add:

- A `tables` row for a cash game that has no `cluster_id`
- A mode switch, host toggle, admin button or column that opens or
  closes a cash table (`auto_restart`, `auto_create_table`,
  `auto_extension` are removed, not kept "for compatibility")
- `#2`, `#3` name-suffix tables
- A `MAX_TABLES_PER_CONFIG` constant. The cap is `cash_games.cap_mains`.
- Counting only humans anywhere in the controller
- A controller decision held in process memory across ticks

### 2.12 Section 17 - First reply

Add to the numbered list:

8. Confirmation you have read section 0 and each path resolves.
9. Which of R1-R5 defaults you are applying (all five unless overruled).
10. The exact functions in `HorseFleetManager` you will delete and the
    one entry point (`ClusterController.tick`) that replaces them.
11. The commit in which `tables.no_rathole` and the per-table floor in
    `atomic_table_buyin` are replaced by `cash_rejoin_constraints`.
12. The list of wall-clock deadlines you are adding to `fn_thaw_platform`
    (must match section 18.5).

## 18. SLICE 6 - AUTONOMOUS LIFECYCLE (the "smart table")

Ships with Slice 2 under Gate 3. This is the answer to "how do tables
open and close with no human". The short version: today's
`HorseFleetManager` already opens overflow tables and retires empty
clones on a 30 s loop. It has no roles, no must-move, no merge, no
canonical-table closer, and a hardcoded cap of 3. Slice 6 replaces that
loop's table logic with one stateless controller that derives everything
from rows. Horse SEEDING stays in the fleet; table LIFECYCLE moves to the
controller.

### 18.1 Objects (repo convention, `numeric` chips)

`cash_games` - one row per game, persistent. This is the cluster.

- id, club_id, union_id (nullable), name
- template_name, ruleset_snapshot jsonb
- variant, sb numeric, bb numeric, handedness
- enabled boolean (default true; the ONLY human knob, optional)
- state: live | dormant
- cap_mains int default 8, allow_second_feeder boolean default false
- bomb clock fields (1.3 section 11.3)
- created_by (null = platform default game)
- Unique (club_id, variant, sb, bb, template_name)

`tables` gains:

- cluster_id -> cash_games.id, NOT NULL for game_type = 'cash' after the
  cutover (CHECK constraint)
- role: main | feeder
- main_index int (1..N when role = main, null otherwise)
- lifecycle: opening | live | breaking | closed
- opened_at, live_at, break_started_at

`tables` loses: auto_restart, auto_create_table, auto_extension,
straddle_enabled, auto_utg_straddle (cash rows; tournament rows are not
touched).

`cash_player_session`, `cash_rejoin_constraints`, cluster membership,
reservations: as 1.3, chips not cents.

Seed migration: `DEFAULT_TABLES[]` becomes rows in `cash_games`. The TS
array is deleted. `ensureAllTablesExist()` becomes
`ensureDefaultGamesExist()` and inserts games, never tables.

### 18.2 The controller

`server/src/cluster/ClusterController.ts`. Leader-only (same lease as
the fleet). Tick every 5 s, piggybacked on the discovery loop cadence.
Each tick, per enabled game, in this order, every step its own SQL RPC
that locks the `cash_games` row `FOR UPDATE`:

```
0. if isMaintenanceFrozen(): emit controller_tick_skipped_frozen; return
1. RECONCILE  read tables, seats, reservations, waitlist, sessions
2. MUST-MOVE  1.3 section 9.5, for every Main with an unreserved seat
3. OPEN       18.3 open rule
4. MERGE      18.3 close rule
5. ROLES      promote / demote / renumber (1.3 section 9.2)
6. WAKE/SLEEP 18.4
7. EMIT       events for every transition made this tick
```

Nothing is remembered between ticks. A tick that crashes emits
`controller_tick_error` and the next tick starts from rows. Two leaders
cannot both act because every mutation is inside the row lock and every
RPC is idempotent on (game_id, table_id, expected_state).

The fleet's `seedAllTables()` keeps running on its 30 s loop and keeps
its occupancy targets, but it now seats INTO clusters through
section 9.4 auto-seat (shortest Main first, then feeder, never a reserved
seat). `spawnOverflowTables`, `retireSurplusTables`,
`runTableLifecyclePass` and `fn_table_lifecycle_pass` are deleted.

### 18.3 Open and close

**OPEN** (one new feeder). All of these, read from rows this tick:

- Every live table in the game has zero unreserved open seats, AND
- At least two buyers exist: a buyer is a `notified` or `waiting` row on
  the game's waitlist, a player in `joining`, OR a horse the fleet
  reports as eligible for this game this cycle (`HorseFleetManager`
  exposes `eligibleHorseCount(gameId)`; it already computes this to
  seed). A horse is a buyer. Law 10.5.
- Live table count < cap_mains + 1 (+1 more if allow_second_feeder).

Then: insert the table with `role=feeder, lifecycle=opening`, mark the
previous feeder `promote_pending`. Buyers are auto-seated into it by
section 9.4. When it has 2 seated it flips to `lifecycle=live`, the
previous feeder is promoted to Main N+1, and `feeder_opened` plus
`feeder_promoted_to_main` are emitted.

If only ONE buyer exists: no table. Lobby shows "Next table opens when
one more player sits" and the buyer holds for 60 s
(`table_opening_hold`). The fleet's next cycle will normally supply a
horse partner; if 60 s pass with no partner, the buyer goes to the
cluster waitlist (`table_opening_hold_expired`). No ghost table, ever.

**CLOSE** (break one table). Evaluate every tick; act only when the
condition has held for the full hysteresis window, which is the shorter
of 2 completed orbits on the candidate table or 5 minutes (tracked on the
row as `break_eligible_since`, cleared the moment the condition fails).

Condition: the game's total seated (humans + horses, every table) fits
into the remaining tables at or above the target-maintain floor of 1.3
section 9.8 (3 per table on 6-max, 4 per table on 9-max) after removing
the candidate. Candidate = newest table first (feeder, then highest Main
index), never Main 1.

Then: `lifecycle=breaking`, `table_break_started`. No new sit-ins. Each
seated player is moved at their next hand boundary by the must-move path
onto the shortest remaining table (1.3 sections 9.5 and 9.8 chair rules;
session, clocks, VPIP, join time travel; a move is not a leave). When
the last seat is empty: `status='closed'`, `lifecycle=closed`,
`trg_auto_cashout_on_table_close` finds nothing to pay,
`table_break_completed`. Roles renumber (demote the newer of the two
survivors to feeder when two remain; oldest is always Main 1).

`HorseSessionRotator` gets one rule: it never sheds a horse from a table
whose game would then be below the balance floor in 1.3 section 9.3,
unless a human is waiting for that seat. This is the existing "full
tables with nobody queued do not shed" rule extended to the cluster.

**A player is never asked anything.** No "table is closing, stay or go".
The interstitial is the one from 1.3 section 9.5: "Seat open on Main 2.
Moving after this hand."

### 18.4 Wake and sleep

An enabled game's Main 1 is the fleet's responsibility, exactly as
canonical tables are today: kept `waiting|running`, seeded to the horse
occupancy target, given an engine by `cash_tables_needing_engine` at 2
seated. This is what guarantees the card is always there and never
shows a 1-player table.

`dormant` = Main 1 exists, zero seated, and the fleet reports zero
eligible horses for this game. The card renders PLAYERS 0, TABLES 1.
Any buy-in (human or horse) flips it `live` (`game_woken`). A game goes
dormant when its last seat empties and no horse is eligible
(`game_dormant`). Dormant is derived, not decided; nobody sets it.

`enabled=false` (host's optional knob): no seeding, no opening; existing
tables break by 18.3 as players leave; when Main 1 empties it closes and
the card disappears. `enabled=true` again: Main 1 reopens on the next
tick. This is the only human input to the lifecycle and it is never
required.

### 18.5 Maintenance break (CLAUDE.md section 13, binding)

Every tick begins with `isMaintenanceFrozen()`. Wall-clock deadlines
this slice introduces, all added to `fn_thaw_platform` in the same PR:

- `cash_rejoin_constraints.expires_at`
- cluster refusal lock expiry (`CLUSTER_REFUSAL`, 60 min)
- VPIP kick lockout expiry (20 min)
- `table_opening_hold` expiry (60 s)
- `break_eligible_since` (5 min hysteresis)
- must-move reservation expiry, if one is added

`stay_remaining_ms` is a countdown driven by `last_tick_at`, not a
wall-clock deadline; it must simply not tick while frozen (the
tick loop is inside the engine, which is parked). Assert this in a test.

### 18.6 Cutover migration - one transaction (Production DDL policy)

Applied once, at Gate 7, inside a single BEGIN/COMMIT:

1. Create `cash_games`; add the `tables` columns; seed platform games
   from the retired `DEFAULT_TABLES` list.
2. For every cash `tables` row in `waiting|running`: find or create its
   game by (club_id, variant, sb, bb, template_name = 'classic'). Name
   families (`X`, `X #2`, `X #3`) map to one game. The "NLH Straddle
   1/2" table maps to the NLHE $1/$2 Classic game (R2).
3. Within each game, order tables by `created_at`: oldest = Main 1, next
   = Main 2 ... newest = feeder. One table = Main 1, no feeder.
4. Force `straddle_enabled=false, auto_utg_straddle=false` on all cash
   rows, then drop the lifecycle and straddle columns.
5. Add the CHECK: `game_type <> 'cash' OR cluster_id IS NOT NULL`.
6. `closed` rows stay closed and get no cluster. They are history.

Nothing on the felt moves. No seat row is touched. No session, no
in-flight hand, no chip. The migration asserts: count of cash
`waiting|running` rows without `cluster_id` = 0, and per game exactly one
`main_index = 1`. It aborts on either.

### 18.7 Slice 6 tests

- A6.1 Game with one table at cap, two horses eligible, no humans: a
  feeder opens within one tick plus one fleet cycle, goes live at 2
  seated, previous table stays Main 1. No human touched anything.
- A6.2 Game with one table at cap, ONE buyer, zero eligible horses: no
  table. Buyer sees the opening-hold copy. After 60 s buyer is on the
  cluster waitlist. Zero `opening` rows remain.
- A6.3 Three tables, seated total fits in two at the target floor, for
  2 orbits: newest table breaks, players move at hand boundaries with
  sessions intact, roles renumber, `status='closed'`. Nobody was asked.
- A6.4 Same as A6.3 but the condition fails once during the window:
  `break_eligible_since` resets, no break.
- A6.5 Main 1 is never the break candidate while any other table is
  live.
- A6.6 Two leaders tick the same game concurrently: exactly one feeder
  opens. Idempotent on the row lock.
- A6.7 Controller process killed mid-tick and restarted: next tick
  reaches the same end state from rows. No memory.
- A6.8 `isMaintenanceFrozen()` true: tick emits skipped event, moves
  nothing, opens nothing, breaks nothing. After thaw, every deadline in
  18.5 has been extended by the frozen duration.
- A6.9 Last seat in a game empties, no horse eligible: game `dormant`,
  card PLAYERS 0 TABLES 1. One buy-in: `live`.
- A6.10 `enabled=false`: no seeding, no opening; tables drain and close;
  card gone at zero tables. `enabled=true`: Main 1 back next tick.
- A6.11 Rotator asks a horse to leave a table that would fall below the
  balance floor with no human waiting: the horse stays. With a human
  waiting: the horse leaves through `leaveTable()` and is subject to
  `LEAVE_LOCKED` like anyone.
- A6.12 Horse under the rejoin floor with insufficient bankroll does not
  sit. Horse over it sits at the floor. Identical to the human twin.
- A6.13 Cutover migration on a snapshot of production: zero cash
  `waiting|running` rows without `cluster_id`; every game has exactly one
  Main 1; `#2/#3` families collapsed; straddle table folded into NLHE
  1/2 Classic; zero seat rows changed; zero session rows changed.
- A6.14 Grep: `spawnOverflowTables`, `retireSurplusTables`,
  `MAX_TABLES_PER_CONFIG`, `fn_table_lifecycle_pass`, `auto_create_table`,
  `auto_restart`, `auto_extension` appear nowhere in `server/src`, `src`,
  or a live migration.

## 19. DEFINITION OF DONE - ADDITIONS TO 1.3 SECTION 16

14. Zero cash tables outside a cluster in production (`SELECT count(*)
FROM tables WHERE game_type='cash' AND status IN ('waiting','running')
AND cluster_id IS NULL` = 0).
15. Every cash lobby card is a game card. `Join Table` / `View Table`
    do not appear in the cash branch.
16. Over a 24-hour production window, `feeder_opened`,
    `feeder_promoted_to_main`, `table_break_completed` and
    `main_demoted_to_feeder` were each emitted at least once with no
    human action in the audit trail. Paste the query and the counts.
17. A6.1-A6.14 green, plus the horse twins of A0.2-A0.17.

END OPORD 1.4. Execute 1.3 as amended.
