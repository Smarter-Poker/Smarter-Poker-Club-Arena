# Lane A - HorseFleetManager and the sit path (audit 2026-09-09)

Files edited: `server/src/services/HorseFleetManager.ts`, `server/src/services/HorseSitVerdict.ts`,
`server/src/services/HorseSitVerdict.test.ts` (one case added),
NEW `server/src/services/aTournamentSeatIsNotCashExposure.test.ts`.
Read in full: HorseFleetManager.ts (all 4216 lines), HorseSitVerdict, HorseGameLoad,
HorseBuyerAllocation, HorseLoneTable, HorseStaleTable, HorseRejoinConstraints, HorseDisabledGames,
HorseBuyInRefusal, HorseOccupancy.test.ts, plus HorseBehavior / HorseFleetPolicy / HorseBankroll /
StableHand (evaluateSit, occupancy curve) / StableHandController / StableHandTags / StableHandState
as dependencies. Every pin in every `*.test.ts` that reads the fleet source was re-checked against
the edited file with a script (literal `toContain` pins: 0 regressions; the regex pins I touched are
listed under "tests"). `node --experimental-strip-types --check` passes on all three source files;
`tsc` (global, no node_modules) reports only missing-module / missing-@types noise in them.

## Where the floor actually went (measured, so nobody re-derives it)

Live 20:11-20:40 UTC, DB read-only:

- 1000 horses. Cash floor: 142 open cash tables, 324 horse seats, 172 bodies
  (DSS 294 seats / 150 bodies, Midway 29 seats / 22 bodies). Tournament seats: 691 seats /
  501 bodies, almost all in tournaments stuck REGISTERING (the P0, other lane).
- Midway (584 horses with JAQK/SHARK membership): 448 hold a seat, **428 of those are at the
  database's four-game limit** (`fn_concurrent_game_load` >= 4: stuck tournament seats plus
  bookings inside the 60-minute window). Of the 136 idle Midway horses, 86 fit an open Midway
  table by tag; **68 of those 86 carry >= 4 bookings**, 16 are on their rest day, 9 at their
  daily cap. That leaves roughly a dozen horses for ~70 Midway tables, each fitting one or two of
  them, then the activity window halves it. That is the whole of "No available horses" x85 and
  "lone_seat_refused=9-14": it is the P0, not the fleet's arithmetic.
- DSS (416 horses): the cash floor sits exactly at the Stable Hand host cap
  (`2a1132b9=149/149`, OPORD curve 33-36% of N at 15:00 Chicago, peak 40%). Every DSS
  "No available horses" is the host cap refusing a NEW body; the 150 seated bodies multi-table
  at ~2 seats each. See finding 12: this cap and Dan's 75%-of-seats rule are two written rules
  that cannot both hold on DSS's 450 seats.

So after the P0 lands the fleet will find ~430 Midway horses again, and the three defects below
would then have hit them: 1 and 2 are exactly about horses holding tournament seats.

## Findings (fixed unless marked)

### 1. P1 FIXED - tournament stacks were counted as cash exposure; every horse in an event was
refused at the sit verdict
`HorseFleetManager.ts` ~L1150-1190 (`horseExposure`). `allActiveSeats` is every open seat on the
platform; the loop summed `seat.stack` for all of them. A tournament seat's stack is tournament
chips (median 5,000, max 840,000 measured; tournament seats hold 15.6M "chips" against a
1.4M-chip cash floor), not the club wallet the aggregate ceiling is a share of
(`canOpenAnotherTable`: roll x 3-10% x 4; Midway median roll 34-44k -> ceiling ~8.8k; DSS
median 10.4k -> ceiling ~2k). `sitVerdictFor` then refused `aggregate_exposure`, and the mutex's
`commitAllows(currentCommit = exposure)` would refuse `brm` for the rest.
Evidence: cycle line `not sittable: aggregate_exposure=265` on every cycle in the 90-minute log;
SQL over live rows: 501 horses hold a tournament stack, **164 of them fail the old ceiling for
even a 100-chip cash buy-in** (170 at 500).
Change: exposure sums only seats whose table is in this cycle's open cash list
(`openCashTableIds`, built from the complete `tables` read). `horseTables` still counts every
seat (the four-game limit does). Pinned by the new test, section 1.

### 2. P1 FIXED - the wallet the engine gated on was not the wallet the database debited, for
every horse holding a Midway tournament seat
`HorseFleetManager.ts` ~L1945-1960 (`seatClubInScope`). `fn_seat_club_for_user_membership_unchecked`
(read from `pg_proc`) resolves "one club at a time" from ANY open seat where
`t2.union_id = v_union` and status not in (closed, completed, cancelled, finished), and that held
seat beats `p_preferred_club`. Midway tournament tables carry `union_id = fade0000...` (301+81
of them open). The engine built the held-seat map from `tableById` (cash tables only), so for a
horse in a Midway event it hash-picked JAQK-or-SHARK, gated the roll, sized the buy-in, read the
per-membership tag and judged the mutex on that pick, sent it as `p_club_id`, and the database
debited the other club. Evidence (SQL with the engine's `horseHash` reproduced in a recursive
CTE): 448 of 584 Midway horses hold a union seat the DB honours, the engine saw 24, and for
**145 horses the two picks disagree right now**. Also produces the `other_club=10` mutex refusals
(activeClubOf reads every seat, the pick did not).
Change: the tournament-table read (already there for the booking rule) now selects
`union_id, club_id, status`; `tournamentTableScope` maps each open tournament table to its scope
(DB's four history statuses excluded, `HELD_SEAT_HISTORY_STATUSES`, verbatim from the function);
`scopeOfSeatTable` asks the cash floor first, tournament tables second; earliest `joined_at`
still wins. Fail-open unchanged: if that read fails the map is empty and the DB decides alone
(the warning now says so). Pinned by the new test, section 2.

### 3. P1 FIXED - the Stable Hand game key was the TABLE NAME, so a must-move was a "seat
given up" and the daily sit cap counted per chair
`HorseSitVerdict.ts` (mutex key) and `HorseFleetManager.ts` ~L3357 (`currentSeatKeys` diff).
Both called `gameKey({ template: t.name })`. OPORD section 10 / `StableHand.test.ts` T32 define
the template as the game's ('classic'); a must-move game names its tables "X", "X Feeder",
"X Main 2". Evidence: `cash_seat_moves` shows **1,438 done moves in 90 minutes** (16/min) against
~1 real cash departure per minute (`table_seats.left_at`), and the log prints
`Stable Hand state: N row(s) updated (0 sit(s), 5-9 seat(s) given up)` on every 30-second cycle -
a two-hour window opened on a game the horse never left, and `sit_cap` (3-5 sits/key/day, 49
refusals per cycle) applied per table rather than per game.
Change: `gameKeyForTable(table)` in HorseSitVerdict.ts (exported, one function, both callers):
template = `cluster_id ?? name`. A table outside any game keeps its old key. Existing
`cash_sits_today` rows keyed on old names read 0 for the rest of today; self-heals at Chicago
midnight. `inTwoHourWindow` has no live reader (only `mayRebuyInSeat`, which nothing calls) so
the spurious windows cost nothing beyond wrong rows; noted as P2 dead code in StableHand (not my
lane). Pinned: new test section 3 + one case in HorseSitVerdict.test.ts.

### 4. P2 FIXED - the activity window refused silently and "No available horses" hid it
~L2912 onward. `pool = sittable.filter(isActiveNow)` and then a bare
`No available horses for "X" (need N, band B)` for a table with 0 awake, whether sittable was 0
or 6. Change: `asleep` counted per table from the sittable pool; the line now reads
`... candidates C, sittable S, asleep A`; `own_ceiling` refusals in `mayEnterAnotherGame` counted
too (they were the one silent gate in the candidate filter). Both reach the heartbeat (finding 6).

### 5. P2 FIXED (behaviour) - an empty/lone cluster table with sittable horses that were asleep
stayed dark
Same block. `seedToDealable` says a cluster table at 0-1 is seeded to two THIS cycle and
`refusesLoneSeat` keeps one horse off an empty one, but only the opening-feeder rule widened the
hour. A Main 1 with two sittable horses of which one was awake was refused every cycle as a lone
seat until the hour rolled (it is indistinguishable from "nobody can sit" in the log, which is
why I fixed 4 first). Change: after the feeder line (unchanged, pinned) -
`if (seedToDealable && !openingFeeder && pool.length < DEALABLE_MINIMUM) pool = sittable;`
Only the hour, never the band or the verdict, same justification as the 2026-09-06 feeder rule.
`hour_widened` counts it. The pinned order rescue < feeder < handed is preserved (checked).

### 6. P2 FIXED - the heartbeat said `reason: nothing_to_seat` and nothing else
`publishFleetState`. `fn_ca_fleet_state_upsert(p_rows jsonb, p_beat jsonb)` stores
`p_beat->'detail'` as-is when it is an object (read from pg_proc), so no migration. `detail` now
also carries `bookings_read_failed`, `booked_out`, `horses_seated_cash` (`horses_seated` is
platform-wide: 654 today, cash floor 172 - the comment at the fleet-boost block claimed
tournament seats were NOT in `allActiveSeats`; it was wrong and is rewritten) and `gates`:
no_membership, barred, tag, stranded_tag_fallthrough, rest_day, daily_cap, floor_unaffordable,
host_cap, booked_out, own_ceiling, asleep, hour_widened, lone_seat_refused, lone_seat_left,
stale_tables_skipped, unsittable{}, seat_stage_skipped{}, mutex_refused{}, buy_in_refused{},
bankroll{} (this cycle's delta of `bankrollCounters()`). Every number the cycle line prints.

### 7. P3 FIXED - `tables.update({status:'running'})` after seating could reopen a closed row
~L3123. It was `.neq('status','running')`: a table closed by status alone between the door
re-read and the write (operator close-game writes status only, per HorseStaleTable) would flip
back to running. Now `.eq('status','waiting')`, the same `count >= 2 ? running : waiting` rule the
engine's own recount writes (`services/supabase/tables.ts`). Not a race with the cluster
controller: the controller owns `lifecycle`, the engine recount owns `status`, and both write the
same value.

### 8. P3 FIXED - `claimOfferedSeats` read `status = 'notified'` unpaged
Now `fetchAllRows` keyset on id (`HorseFleet.offeredSeats`); an incomplete read answers what it
read and warns (a seat call answered beats one skipped; the rest keep their hold).

### 9. P3 FIXED - dead code: `MIDWAY_UNION_ID` local const (no reader), `clubIndex` +
`getNextClubId()` (the table-creation round-robin, no reader since Gate 7), unused import
`variantLabel`, and `gameKey` import replaced by `gameKeyForTable`. `this.clubIds` kept (pinned,
seeds `clubIdsToLoad`; harmless, the union loader adds the same two clubs).

### 10. P3 NOT FIXED - four-game mirror counts seats at CLOSED tables; the SQL does not
`fn_concurrent_game_load` clause (1) is `t.status <> 'closed'`; the fleet's `horseTables` is every
`left_at IS NULL` seat. Zero such seats exist right now (measured) and the fleet is only ever
stricter, so it costs nothing today; fixing it needs a status for every seat's table, which the
cycle does not read for closed tables. Left as-is, documented here. Everything else in the mirror
(statuses registered/playing, ANNOUNCED/REGISTERING, 60-minute window, NULL start counts,
seat-first exclusion, per-(player,tournament) dedupe, `p_exclude_table_id` == "already at this
table") agrees with the function text read today.

### 11. P2 NOT FIXED (other lane) - `mayRebuyInSeat` / `inTwoHourWindow` have no live caller
`StableHand.ts` L990, `StableHandTags.ts` L395. The two-hour window is written every cycle and
read by nothing. Either wire it into the rebuy path (HorseRebuyPolicy lane) or delete the column
write. Finding 3 stops the writes from being wrong meanwhile.

### 12. NOT FIXED - two written rules disagree on DSS and I am not resolving it (CLAUDE.md 10.8)
Dan 2026-09-02 (HorseBehavior.ts header, HorseOccupancy.test.ts): "horses need to be occupying
at least 75% of all seats in the cash games". OPORD section 11 (`StableHand.ts` OCCUPANCY_CURVE_PCT,
`peakCap = 40% of N`, night 5%): a host may carry at most 40% of its horses as bodies. DSS has 416
horses and 450 cash seats: 40% = 166 bodies, so 75% of seats (338) needs every body at 2+
tables all day, and the trickle, `seat_cap` and `sit_cap` gates work against that. Today DSS is
pinned at exactly the curve (149/149) with 156 empty seats. Needs Dan's ruling; do not "fix"
either constant.

### 13. Verified - `TournamentRecurring.horse_load_seats_failed` in the log (`pickFreeHorses`
embed) is covered by the P0 commit d72f4be: `TournamentRecurringService.ts:4258` now names
`tables!table_seats_table_id_fkey!inner(...)`, and no un-hinted `tables!inner(` survives in
`server/src`.

## Tests

- NEW `aTournamentSeatIsNotCashExposure.test.ts`: 5 describes / 13 cases (source contract for
  1, 2, 4, 5, 6, 7, 8; `gameKeyForTable` exercised directly for 3).
- `HorseSitVerdict.test.ts`: +1 case (feeder and main of one cluster share a sitKey).
- Pins re-verified by script against the edited source: HorseAggregateExposure (exposure set
  line unchanged, placed after the cash-only skip), HorseBankrollGateClubs (resolver, clubIds,
  eligibleClubsFor), theFeederKeepsItsBuyers (tournamentTables read still `.neq('status',
  'closed')`, `beat.bookedOut`), theFeederFillsFromTheCountItOpenedOn (rescue < feeder < handed;
  claim path), HorseSitVerdict PART 2 (`let pool = sittable.filter(...)` verbatim, ctx fields),
  HorseFleetPolicyWiring (no bare `return;` after the withhold), aDisabledGameIsNotSeeded
  (`isTableOfDisabledGame(` count still 3), HorseStaleTable (`stale_door_read_failed`).
  I could not run vitest here (no node_modules); please run
  `npx vitest run src/services/aTournamentSeatIsNotCashExposure.test.ts src/services/HorseSitVerdict.test.ts src/services/HorseAggregateExposure.test.ts src/services/HorseBankrollGateClubs.test.ts src/services/theFeederKeepsItsBuyers.test.ts src/services/theFeederFillsFromTheCountItOpenedOn.test.ts src/services/HorseFleetPolicyWiring.test.ts`
  in `server/`.

## Verified - no issue (do not re-audit)

- `fleetBoost` / `seatBudget` / `cycleWithheld` / `maxHorses`: budget spent by claims and seats
  in order; `capBySeatedCount` never negative; `seatsToDealable` cannot lift `seatsNeeded` past
  `seatsAllowed` (min with a non-positive cap yields 0); FULL tables fill in one pass, sporadic
  tables trickle 1-2; `Math.min(seatsNeeded, seatBudget)` is last.
- `pendingMovesByTable`: pending moves carry no `to_seat_number` (0 of 14 pending had one), so
  reserving a COUNT rather than a seat number is correct.
- `resolveSeatClub` hash pick vs DB for an IDLE horse: the DB honours `p_preferred_club` when the
  membership exists, before its own `hashtextextended` pick, so the engine's pick is what is
  debited (the DB's own hash is only reached when no preferred club is sent). Held-seat case: 2.
- `rejoinTableKey` club: `cash_rejoin_constraints.club_id` is the TABLE's club (fade0000 for
  Midway rows), matching `t.club_id`; sb/bb strings vs numbers normalised on both sides.
- `classifyBuyInRefusal` vs live RPC strings: only `TABLE_SIZE: table is full (6 of 6 seats
  taken)` (-> table_full, a race, 1-2 per 90 min), `duplicate key` (-> seat_taken), one
  `refused=1` whose message the filtered log dropped. All 13 literals match the RPC text in
  `atomic_table_buyin_before_maintenance_announcement_gate`.
- `humansWaitingByTable` excludes horses by id: sanctioned (horses do not queue, Dan 09-02).
- `pruneHorseWaitlist` clears `waiting` only, before `claimOfferedSeats` (reads `notified`).
- `hostOfTable` / `bodiesOnHost` / `activeHostOf`: cash tables only, by construction; the host cap
  is a cash-floor rule.
- `HorseBuyerAllocation`: reserved-first, probe clamps to reservation, one horse per cluster per
  pass, capacity from `remainingGameCapacity` - correct against the header's contract.
- `HorseLoneTable`, `HorseStaleTable` (`SEATABLE_STATUSES` includes 'active'; no cash table has
  that status today and the open-table read never returns one, harmless), `HorseDisabledGames`,
  `HorseRejoinConstraints.applyRejoinFloor`: pure and correct.
- `buildFleetStateRows`: earliest seat wins (same rule as the wallet resolver); `bankroll` keyed
  on the seat's wallet club; `suspended` only for `horse_status = 'disabled'`.
- `DEFAULT_TABLES`: read only by the seat-law check and two tests; no live table writer left.
  `ensureAllTablesExist` inserts nothing.
- `fn_ca_fleet_state_upsert` signature `(p_rows jsonb, p_beat jsonb)`; `state` vocabulary
  includes idle/seated/suspended; `detail` stored verbatim.
- The fail-open / fail-closed doctrine is unchanged in every loader (table list, seat map,
  union map, horse pool, horse ids: closed; bankroll, rejoin, disabled games, bookings, doors,
  pending moves, offers: open).
