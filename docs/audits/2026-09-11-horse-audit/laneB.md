# Lane B - HorseSessionRotator, bankroll/rebuy/behaviour/lifecycle/loader (audit 2026-09-09)

Files edited: `server/src/services/HorseSessionRotator.ts`, `HorseLifecycleManager.ts`,
`HorseLaneLoader.ts`, `HorseBehavior.ts`, `HorseMindHydrator.ts`, `HorseRebuyPolicy.ts`,
`services/supabase/wallets.ts` (one new read, beside `autoRebuyHorse`),
`engine/ServerTableEngineDealing.ts` (2 lines + comment), `engine/ServerTableEngineSettlement.ts`
(1 line). Sibling pins updated: `PagedReadsCannotLieAboutBeingComplete.test.ts`,
`HorseLoneTable.test.ts`, `theClubProgrammeMirrorsTheHouse.test.ts`.
NEW `server/src/services/theRotatorMeetsADriftedFloor.test.ts` (12 describes / 22 cases).
Read in full: HorseSessionRotator (1351), HorseBankroll, HorseBankrollTelemetry, HorseRebuyPolicy,
HorseBehavior, HorseFleetPolicy, HorseLifecycleManager, HorseLaneLoader, HorseMindHydrator,
HorseTournamentCommitment, HorseGameLoad, HorseLoneTable (code), ServerTableEngineSeating
(addChips / sitOut / leaveTable), the rebuy paths in Dealing + Settlement, `autoRebuyHorse`,
`fn_horse_fund_from_treasury` and `fn_offer_open_seat` (from pg_proc). HorsePlayStats /
HorseDailyAudit / HorseSelfTuner / horseAliasStyles skimmed for wiring only (findings 22-23).
`node --experimental-strip-types --check` passes on every edited source; every regex pin in the 14
tests that read the rotator source was re-run by script against the edited file (0 regressions,
3 pins updated deliberately, listed under "tests"). No em dash in any added line.

## What fifteen hours without the rotator did (live DB, 20:40-21:10 UTC, read-only)

- 337 horse cash seats. 279 past the 75-minute mean session, 242 past 150 min, 14 past 10 h,
  7 past 15 h, max 1,792 min (30 h). Median 250 min, p90 476 min. (`joined_at` travels with a
  must-move, so some of that is game seniority, not one chair.)
- 22 short stacks (< 45% of a buy-in) never topped up; 4 at zero.
- 4 lone horses at cluster tables, all > 10 min with no hand, avg 343 min seated, none with a
  partner inbound: the first pass stands all 4 (uncapped, as designed).
- 9 cash seats owed to a tournament inside the hour (all `certain`: their events carry a
  `start_time` in the past and are stuck REGISTERING - the P0 lane). First pass leaves 9.
- 0 humans on any waitlist (`table_waitlist` waiting/notified is empty), so no release.
- Book-win / stop-loss on the first pass, computed the way the FIXED code computes it: 5 book
  wins + 2 stop losses (standard policy), 18 + 5 if every horse were a nit. Capped with the
  hazard at GLOBAL_DEPARTURES_PER_CYCLE = 4 per 90 s.
- So the first pass is ~17 departures (4 capped + 4 lone + 9 tournament), then ~4 per cycle
  (=160/h max) against a fleet that reseeds on a 30 s cycle. Sane; no stampede. The cap is
  first-come by table id (certain departures spend it first) - acceptable, noted, not changed.
- `SessionRotator` lines in the 90-minute log: 0. Confirms the silent decline.
- DB now shows ONE FK from `table_seats` to `tables` (`table_seats_table_id_fkey`); the two the
  brief names are gone. The hinted embed still resolves; nothing to do.

## Findings (fixed unless marked)

### 1. P1 FIXED - the session-P&L ledger read returned an arbitrary 1,000 rows of rake; the

book-win / stop-loss rule has never fired on a true figure
`HorseSessionRotator.ts` old L364-385. `chip_ledger ... .not('table_id','is',null).limit(20_000)`,
no order, no entity/category filter. PostgREST caps at db-max-rows = 1,000 (pagination.ts).
Measured: the window (oldest seat - 60 s = 30 h) holds 386,992 qualifying rows; in the last 8 h
alone 46,758 `bbj_contribution` + 24,406 `rake` rows whose `from_entity_id` is not a player,
against 601 `buyin` + 164 `addon` rows from horses. So `led` was 1,000 arbitrary rows, keyed
`table:table-entity`, and `investedBySeat` was empty for essentially every seat (heuristic path
only); when a lone buy-in/addon row DID land, `stack - invested` read as a heater and forced a
"certain" exit. Fix: the horse's own rows only (`from_entity_id IN` seated horse ids, chunked at
IN_LIST_CHUNK), `to_type = 'table_stack'` (verified: every horse ledger row with a table_id in
48 h is player_wallet -> table_stack: buyin 9,105, addon 2,922, settlement 303), keyset-paged
by id via `fetchAllRows` (label `HorseSessionRotator.investedLedger`), incomplete -> map left
EMPTY + `invested_ledger_incomplete` reported (fail open to the heuristic, never a half figure).
The horse-id read now runs BEFORE the bankroll block so both reads are horses-only.

### 2. P1 FIXED - the invested sum spanned every previous sitting at the same table

Same block. One `oldest` for the whole floor, no per-seat lower bound. Measured on live rows:
summing since `now()-30h` vs since the seat's own `joined_at` differs for 145 of 337 seats, and
the whole-window sum reads 49 seats as a stop-loss (standard policy) against 2 real ones.
Fix: `seatJoinedAt` map; a row counts for a seat only if `created_at >= joined_at - 60s`.
(A must-move keeps `joined_at` but changes table_id, so a moved horse reads only what it added
at the new table: 95 of 337 seats have no ledger row at their table -> heuristic. Same degrade
as before, never a wrong number.)

### 3. P1 FIXED - a "short break" of up to 5 min met the 5-minute sit-out eviction and ended as

a cash-out
`BREAK_MAX_MS = 5 * 60_000` == `DisconnectEngine.SITOUT_MAX_MS`; the sit-back only runs on the
90 s cycle, and `evictExpiredSitOuts` cashes the seat out at 5:00 ("2 orbits or 5 minutes,
whichever first", Dan 2026-08-25). With sitBackAt ~ U(2,5) min and a 0-90 s check delay, 25%
of breaks were evictions the rotator neither counted nor logged. Fix: `BREAK_MAX_MS = 3 min`
(max sit-back 4:30 < 5:00). Pinned against `DisconnectEngine.SITOUT_MAX_MS` at runtime.

### 4. P1 FIXED - the break map is memory and the engine restarts hourly

A break started before the :55 restart came back as `table_seats.is_sitting_out = true`
(the engine persists and restores it, clock seeded from `sit_out_at`) with no sit-back holder;
the only exit was the eviction cash-out. Fix: seat read selects `is_sitting_out`; a horse
sitting out at a cash table, not `leave_pending`, with no break on record is sat back in
(`sitBackRestored` logged), once per seat per process (`sitBackRestoredKeys`) so a horse the
disconnect engine's strike rule sits out afterwards is not re-seated every cycle. Derived from
the row, not memory - the ChipContinuity rule.

### 5. P1 FIXED - one waiting person stood up two or three horses

Old `releaseWanted = humansWaiting` counted `notified` rows. `fn_offer_open_seat` holds the
freed chair for a notified person for 60 s, so the second cycle stood up another horse while the
offer was live, and a third if a chair was already open with an expired offer. The Stable Hand
executor ALSO yields for the same queue (30 s cycle, `humansWaiting + 1` by OPORD, 2-5 min
stagger), so the two compounded. Fix: `releaseWanted = max(0, queue - openSeats)` with
`openSeats = max_players - seated` (`max_players` added to the embed; 0 nulls, 0 drift vs
live seat counts measured). A held offer sits inside `openSeats`, and a chair the executor
frees is seen here. Release victim is now the executor's order (sitting out first, then newest
arrival) instead of always seat 1 - the same person always watching the lowest seat leave was a
tell.

### 6. P2 FIXED - the waitlist read was unpaged

`table_waitlist ... .in('status', [...])`, no paging (fleet paged since 2026-09-06; queue hit
10,004 rows on 08-31). 0 rows today. Now `fetchAllRows` keyset on id, incomplete -> clear
(fail closed, unchanged direction).

### 7. P2 FIXED - `leave_pending` read but never selected; a leaving seat asked again and

topped up on its way out
`considerSeatChanges` read `seat.leave_pending === true` on a row that never carried the
column (always undefined). The departure loop re-picked a `leave_pending` seat next cycle
(second `requestSeatDeparture` write, second cap slot) and the top-up could `addChips` into a
seat cashing out at hand end. Fix: selected; `isLeaving()` gates the drain, the discretionary
loop, the lone stand, the tournament leave, the top-up pass, the break and the sit-back restore.

### 8. P2 FIXED - a `LEAVE_LOCKED` stay-clock refusal was re-asked every 90 s

Every certain departure (book win, table change, release, tournament) re-picked the same seat
and called `leaveTable` again; each refusal logs and emits `leave_blocked` on the table. The
executor already holds the pair for `stay_remaining_ms`. Fix: `RotatorLeaveResult` carries
`code`/`stay_remaining_ms`; `noteLeaveResult` after all 4 `engine.leaveTable` calls;
`leaveHeld` skips the seat until the clock lifts (+1 s).

### 9. P1 FIXED - top-ups sat inside the departure loop, behind its population floor and its

4-departure `break`, and priced off `bb * 100`
A short stack at a 3-handed table never reloaded; on a busy cycle no table after the 4th ever
reached the reload code. And `buyIn = bb * 100`, `minBuyIn: bb*40`, `maxBuyIn: bb*200` ignored
the table: DSS runs 0.50 with min 200/max 500, 0.25 with 100-250, 2.00 with 200-1000, 5.00 with
500-2500; Midway 0.50 with 50-100, 1.00 with 100-200, 2.00 with 200-400, 5.00 with 250/500-1000.
At the 0.50/200-500 table the reload threshold was 22.5 chips, the session verdict was in units
of 50 (stop-loss at -150 = 0.75 real buy-ins, book-win at +150). Fix: own pass over every cash
table before the loop (`reportError` label unchanged, telemetry pins unchanged); `min_buy_in,
max_buy_in` selected; `buyIn = referenceBuyIn(bb, tableMin, tableMax)` for the threshold, the
swing, `sessionVerdict` and `topUpAllowance`.

### 10. P2 FIXED - the P0 commit d72f4be left a red pin

`PagedReadsCannotLieAboutBeingComplete.test.ts` required `if (error || !chunk) return;`
verbatim; the P0 patch (correctly) turned that into a reporting block. Pin updated to require
the report AND the return. Would have been red on the Mac.

### 11. P2 FIXED - `HorseLifecycleManager.cleanupFinishedTournaments` re-checked April's

tournaments every minute and never reached today's
`.in('status',['COMPLETED','CANCELLED'])`, no order, no limit -> the first 1,000 of 143,769
(oldest, from 2026-04-13), 1,801 horse registrations among them: ~4,600 queries per pass (log:
the pass completes every ~3.3 min, 27 `stale_sng_observed` lines in 90 min), 0 resets ever
logged. Fix: `ended_at >= now - 15 min`, ordered, limit 1000 (5,159 finishes/24 h = ~54 per
window). `evaluateHorseStatus` now writes only `.neq('horse_status','available')` and reports a
reset only when a row changed (every horse is 'available' today; nothing writes another value
any more - `detectStuckHorses`/`forceResetHorse` are therefore inert, left as is).

### 12. P2 FIXED - `cleanupStaleSeats` read `tables` one row per stale seat

843 seats older than 4 h (676 tournament, 167 cluster - every one skipped after its own read),
one query each, every minute. Fix: one chunked `tables` read (`HorseLifecycle.staleSeatTables`),
fail closed on incomplete; the `if (tableRow?.cluster_id) continue;` law pin is untouched.

### 13. P1 FIXED - the fleet's first cycle after a restart ran with no stake band loaded

`HorseLaneLoader` waited `BOOT_DELAY_MS = 20 s`; `HorseFleetManager.start()` launches its
initial seeding at once. With the map empty, `stakeBandFor` answers 'micro' for EVERY horse, so
`stakeBandAllows` admitted the whole fleet to micro tables and nothing else - the exact tell Dan
named (a 25/50 name at 0.05/0.10). The tag gate covers most seats but not all: 473 of 1,580 tag
rows carry no `preferred_stakes` and 323 memberships have no tag, all of which fall to the band.
Only the hourly restart (boot inside the freeze) hid it. Fix: loader loads at `start()`, retries a
failed FIRST load in 60 s (`FIRST_LOAD_RETRY_MS`) instead of 30 min; `stakeBandAllows` refuses
while nothing is loaded (once-logged) - the fail-closed half: an unread pool skips the decision.
Measured: all 1000 horses carry `lane` and `stakeBand` (`[HorseLaneLoader] 1000 ... (0 on the
hash fallback)` x3 in the log); the self-tuner spreads `prevMods` so it preserves both keys.

### 14. P2 FIXED - HorseMind hydration replayed the OLDEST thousand hands

`hand_history ... .order(created_at asc).limit(12000)` -> 1,000 rows (db-max-rows) from the
start of the window: 1,555,838 hands in 72 h, 137/min, so a boot with no flush row replayed
72-hour-old hands and a normal :55 boot's 5-10 min tail (~700-1,400 hands) was truncated when
over 1,000. Fix: newest-first keyset pages on `created_at` up to HYDRATION_MAX_HANDS, replayed
in dealt order; a failed page replays what was read.

### 15. P2 FIXED - the rebuy roll was read against the TABLE's club; every Midway horse

reloaded with no bankroll opinion
`horseRebuyAmount({ clubId: tableInfo.club_id })` -> `readClubChipBalances(fade0000...)` -> no
`club_members` row for a union -> `roll undefined` -> legacy flat amount, while a DSS horse got
the policy (10.5 asymmetry). 29 Midway cash seats today; 337/337 seats resolve their wallet via
`table_seats.club_id`. Fix: `readSeatWalletClub(tableId, userId)` in wallets.ts (seat row's
club, null -> fall back to the table club), `tableId` passed from both engine sites. Fail-open
pins (`roll === undefined` -> legacy) unchanged. `fn_horse_fund_from_treasury` itself funds from
the TABLE's club treasury and checks `club_id` against it - consistent with what the engine
passes; not touched.

### 16. P2 FIXED - the 5-second rebuy window was held by a hard-coded `< 2`

`ServerTableEngineDealing.anyBustedPlayerCanAffordARebuy`: `horseRebuys < 2` while the
temperaments stop at 2 / 3 / 4 committed buy-ins. A gambler on its third reload got no pause
and then reloaded in settlement step 5 (rhythm asymmetry, 10.5); a nit on its second got a pause
for a reload it never made. Fix: `rebuyStopLossReached()` (pure, no telemetry) in
HorseRebuyPolicy, used there. `atRebuyStopLoss` (with its counter) unchanged for the two reload
sites.

### 17. P3 NOT FIXED (documented) - departure cap is spent in table-id order

`byTable` iterates ascending table_id and `break`s at 4; certain departures on low ids starve
high ids on a busy cycle. Only binds when > 4 certain/hazard fires coincide (rare in steady
state). Left; the pin `if (departures >= GLOBAL_DEPARTURES_PER_CYCLE) break;` is load-bearing
for HorseTournamentCommitment.test.

### 18. P3 NOT FIXED (other lane, config) - a DSS 50/100 table (min 2,000 / max 10,000) is open

`tables` row: bb 50, 0/9 seated, `status <> 'closed'`. No DSS horse can ever sit it (`canSit`
needs 125k standard; DSS p90 roll is 15,582; no DSS member holds band 'high') and Dan's
2026-09-03 order was "close any tables over 2/5". Config row, not code; flagging.

### 19. P3 NOT FIXED (P0 lane) - stuck-REGISTERING tournaments with a past `start_time` count as

an imminent game and stand horses up from cash
`bookingIsAGame(start <= now+60m)` and `tournamentCommitmentVerdict` (msToStart clamps to 0 ->
`certain`) both treat a tournament whose start has passed as "now"; 9 cash seats are owed today
to events that cannot start (the P0). Correct per `fn_concurrent_game_load` (lane A verified the
mirror); resolves when the P0 lands and those events start. Not changed.

### 20. P3 NOTED (lane A file) - `ladder_exhausted=11` is priced club-blind

`HorseFleetManager` ~L3510: `cheapestRef` is the cheapest table on the whole floor (DSS 0.02,
ref 2) while `bankrolls` is keyed club:horse - so 11 stranded cannot come from roll size (every
horse roll on the platform is >= 8,710). Likely a band/club restriction the gauge does not see.
Not my file; measured for whoever picks it up.

### 21. VERIFIED - what "will it stand up hundreds" comes to

See the measurement section: ~17 on the first pass, then <= 4/cycle + lone stands (4 today) +
tournament leaves (9 today, all P0-driven). No path stands more than one horse per table per
cycle. The retirement drain is unreachable (145 open cash tables, 145 with cluster_id, 0
retiring, 0 parked, 0 breaking).

### 22. VERIFIED - `isActiveNow` over the 1000 real ids (horseHash reproduced in SQL)

Awake fraction by UTC hour: 53.3% (14:00) to 59.8% (06:00), flat; ~55% as the header claims.
No band is dark at any hour. No diurnal shape at all (nobody asked for one); noted only.

### 23. VERIFIED - `ca_horse_fleet_policy` equals `FLEET_POLICY_DEFAULTS` field for field

One global row: enabled, not paused, no caps, bias 1.0, min humans 0, bands/variants/schedule
null. Nothing withholds seating by policy.

### 24. VERIFIED - bankroll arithmetic vs live rolls

Rolls (horses, per club): SHARK p10 15.8k / p50 34k / p90 239k; JAQK 24.8k / 44k / 287k; DSS
8.7k / 10.4k / 15.6k; union row 25k / 25k / 222k. `canSit` at every open DSS stake through
2/4 (ref 200: standard 5k, nit 8k) passes for essentially all 416; at DSS 5/10 (ref 500: 12.5k
standard, 20k nit, 6k gambler) ~35% pass, and no DSS member is banded 'high' anyway (DSS bands:
micro 84 / low 183 / mid 149). Midway 5/10 (ref 500) passes for ~all. No band is silently
excluded by the roll rules; the DSS high rung is empty by merit band, not by `canSit`.

## Tests

- NEW `theRotatorMeetsADriftedFloor.test.ts`: source contract for 1-9, 11-16; runtime for 3
  (`BREAK_MAX_MS + CYCLE_MS < DisconnectEngine.SITOUT_MAX_MS`), 13 (`stakeBandAllows` refuses
  on an empty map, decides once loaded), 16 (`rebuyStopLossReached` per temperament, agrees
  with `atRebuyStopLoss`).
- Updated pins: `PagedReadsCannotLieAboutBeingComplete.test.ts` (finding 10),
  `HorseLoneTable.test.ts` + `theClubProgrammeMirrorsTheHouse.test.ts` (embed column list now
  ends `created_at, max_players, min_buy_in, max_buy_in`).
- Re-verified by script, unchanged: theFloorIsFull (releaseWanted/holdsFull/wantsTableChange/
  `p = 0` order), HorseBankrollTelemetry, HorseBankrollWiring (club_id in select, chip_ledger,
  `stack - invested`, verdict block INFINITY, `invested !== undefined`), ChipContinuity.law
  (exactly 4 `await engine.leaveTable(`), HorseSeatChange (one `cash_seat_moves` read, no
  `.rpc(`, no roster/request writes, suppression before the call), HorseTournamentCommitment
  (verdict before the cap), HorseLoneTable (order, no seat writes in the pass),
  anIdListHasACeiling, MultiTablePlay break-key pins, HorseRebuyPolicy wiring pins, the
  `if (tableRow?.cluster_id) continue;` lifecycle law, HorseStakeBands/Projection (every
  `stakeBandAllows` call there loads bands first).
- Please run in `server/`:
  `npx vitest run src/services/theRotatorMeetsADriftedFloor.test.ts src/services/PagedReadsCannotLieAboutBeingComplete.test.ts src/services/HorseLoneTable.test.ts src/services/theClubProgrammeMirrorsTheHouse.test.ts src/services/theFloorIsFull.law.test.ts src/services/HorseBankrollWiring.test.ts src/services/HorseBankrollTelemetry.test.ts src/services/HorseSeatChange.test.ts src/services/HorseTournamentCommitment.test.ts src/services/HorseRebuyPolicy.test.ts src/services/HorseStakeBands.test.ts src/services/HorseStakeBandProjection.test.ts src/services/anIdListHasACeiling.test.ts src/services/ProducerShutdownOwnership.test.ts src/engine/ChipContinuity.law.test.ts src/engine/SitOutClockAndEviction.test.ts src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts src/MultiTablePlay.server.test.ts`

## Verified - no issue (do not re-audit)

- Rotator start/stop generation fencing: `start` bumps the generation and clears `stopOperation`;
  `launchRotation` refuses while a rotation is in flight, so a draining old pass cannot overlap
  a new one; every await re-checks `lifecycleIsCurrent`. Same shape in HorseLifecycleManager
  (`cycleRunning` + tracked jobs; `start` refused while stopping, logged) and HorseLaneLoader.
- Cycle interplay: rotator 90 s (<= 4 discretionary + uncapped lone/tournament/release, one per
  table per cycle), fleet 30 s reseed, executor 30 s (<= 12 yields, <= 4 wind-downs per host).
  With finding 5 the rotator and the executor converge on one waiting person instead of
  compounding. The freeze gate is on the interval, the seat-change pass and the tournament loop.
- Horse-id read chunked, fail-closed; roll read chunked, incomplete -> empty (fail open to the
  refusing side of the top-up); `seat.club_id` is the wallet club (337/337 resolve).
- `TOPUP_*`, `MIN_SESSION_MINUTES`, hazard multipliers, `wantsTableChange`,
  `seatChangeVerdict`, `cashTableFill` bucket/mix: pure, unchanged, as documented.
- `leaveTable` on a mid-hand seat: `requestSeatDeparture` + fold/auto_fold + sit-out +
  `leave_pending`; between hands `atomicCashoutVoluntary`; all-in refused; the rotator never
  writes `table_seats`.
- `addChips`: capped at table max, wallet debited atomically, mid-hand queued to the durable
  ledger; amounts rounded to cents on both sides.
- `HorseBankroll`: `referenceBuyIn`, `canSit`/`canMoveUp`/`shouldMoveDown`, `bankrollBuyIn`,
  `topUpAllowance`, `canOpenAnotherTable` (x4 shares), `rebuyDecision` (`rebuysTaken + 1`
  off-by-one documented and correct), `canEnterTournament` freeroll override: all as specified.
- `HorseBankrollTelemetry`: gauge vs counter split, delta reporting; every declared event has an
  emitter.
- `HorseRebuyPolicy`: lazy wallet import, fail-open on unreadable roll, `legacyRebuyAmount` to
  the cent; both engine sites short-circuit a zero and distinguish `unknown`.
- `autoRebuyHorse`: idempotent op id (uuidv5 of table/user/hand), 2dp guard, receipt cross-
  checked field by field, `unknown` on a frozen/deferred answer.
- `HorseFleetPolicy`: parsing, schedule wrap, `capBySeatedCount` never negative, failed read
  not cached, degraded flag.
- `HorseLaneLoader`: merges, re-runs `fn_assign_horse_lanes` / `fn_assign_horse_stake_bands`
  at >= 25 missing; live data has 0 missing.
- `HorseBehavior`: lanes hash fallback; bands 'micro' for a missing record once loaded;
  `projectStakeBandOnto` downward only; `occupancyTargetFor` subtracts the queue, floor 1.
- HorseSelfTuner writes `horse_profile` from `prevMods` spread (keeps lane/stakeBand);
  HorseDailyAudit is one RPC on a timer; HorsePlayStats is pure; horseAliasStyles has its own
  test. None sits, stands or funds a horse.
- No `is_horse` filter in any edited file denies a horse anything a human gets; the only
  `is_horse` reads are identification (who is a horse) per 10.5.
