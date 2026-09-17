# Lane D - tournament horse fills: recurring service, discovery walk, seat-first lanes, the DB doors (audit 2026-09-11)

Files edited: `server/src/services/TournamentRecurringService.ts`, `server/src/GameServer.ts` (discovery walk,
seat-first fast lane, `topUpPartialSeatFirst` only), `server/src/services/HorseConcurrency.test.ts` (one pin),
NEW `server/src/services/aFinalizedPoolIsNotFilled.test.ts` (5 describes / 14 cases, 6 behavioural against the
mocked client the precheck suite already uses, 8 source pins).
Migrations as FILES ONLY under `_audit/laneD-migrations/` (3, not applied).
Read in full: TournamentRecurringService.ts (6,195 lines), HorseTournamentCommitment.ts, GameServer.ts
discoverTournaments / readSeatFirstPaidSeats / discoverSeatFirstStarts / fillPartialSeatFirstGame /
topUpPartialSeatFirst / finishSeatFirstGamesThatAreOver / completing recovery, TournamentManagerBase launch
(beginTournamentLaunch, completeTournamentLaunch, proveTournamentLaunchSetup, resume, the horse add-on and
rebuy branches), and from pg_proc: fn_register_horse_for_tournament (all 3 layers),
fn_seat_horse_in_seat_first_game (all 3 layers), fn_take_seat_and_buy_in (all 3), fn_register_for_tournament
(all 5 layers), fn_ca_lock_tournament_seat_acquisition, fn_concurrent_game_load, fn_enforce_four_table_limit,
fn_enforce_booking_game_cap, fn_enforce_tournament_capacity, fn_tournament_entry_cap_reached,
fn_tournament_primary_table, atomic_deduct_wallet_and_log, fn_tournament_club_for_user,
fn_horse_tournament_entry_ticket_hints, fn_tournament_late_registration_open, fn_ca_fund_overlay_on_lock,
fn_guard_tournament_start_readiness, trg_capture_satellite_economics_on_start.
`node --experimental-strip-types --check` passes on every edited file. Every source-pin test that slices the
regions I touched was re-read against the edited source (listed under "tests"). No em dash, no emoji added.

## The answers to the seven questions (measured 13:5x-14:1x UTC unless stated)

**(1) The 97 stuck REGISTERING tournaments are two populations, neither "no free horses".**
93 at 13:55 (97 at 13:26): 92 seat-first + 1 MTT.
- 40 rows (39 seat-first + "Breakfast Turbo" f370585d) were DEALT on 2026-09-08 12:49-14:53 UTC and never
  left REGISTERING: hands in `hand_history`, entrants `eliminated`, tables `running`, `prize_pool_finalized =
  true`, `started_at NULL`, `updated_at` BEFORE their first hand, no launch receipt, no lease. The engine that
  dealt them stopped at :53 before the RUNNING commit (today's launch commits RUNNING before any dealer is
  admitted; no such row exists after 09-08 14:53 - measured by hour). Every other REGISTERING row (293) reads
  `prize_pool_finalized = false`. 2,164.60 chips of finalized pools unpaid: 17 heads-ups and 11 spins are
  DECIDED (one player with chips), 11 spins have two live stacks, the MTT has one 0-chip and one 430,255-chip
  entrant. What discoverTournaments did with each, every pass: "past start, current_players < min_players"
  -> `topUpWithHorses(id, max_players)`; the fast lane did the same on the 1/2 and 2/3 ones every backoff.
  Both doors refuse (the seat RPC answers `tournament_full` because a finalized seat-first row counts every
  entry it sold, busted or not; the registration insert meets the trigger "registration is closed because
  tournament ... prize pool is finalized"). Cost in the 60-minute log: 330 fill passes ending
  `rpc_other_noop=3` = 1,796 locked `fn_seat_horse_in_seat_first_game` calls, 1,169 locked
  `fn_register_horse_for_tournament` calls (5 passes at x229-240 on Breakfast Turbo), 298 `seat_first_human_
  waiting` alarms naming the wrong cause. Each of those calls queues on the platform-wide seat-acquisition
  lock every hand settlement holds. FIXED (findings 1, 2); the rows themselves need the finish path
  (finding 3, migration).
- 53 seat-first boards with ZERO seats, every one past its human window (10:37-13:24 creation). Not stuck
  on a missing pool: they are the held-empty design's survivorship (finding 4) plus DSS boards that never
  open with a horse (finding 5). 149 of 158 open seat-first boards had no seat sold at 13:55 against Dan's
  33%/50%; 138 of the 149 read "held" in the current bucket (my JS reproduction of `seatFirstHeldEmpty` over
  the live ids; random uuids give 32.4%/50.2%, so the hash is fine - it is the lifetimes).
- pickFreeHorses finding nobody: 0 `holding N back for the cash room` lines, 0 `registerHorses found no
  candidates` lines in the hour. 267 of 1,000 horses carry load 0 right now. Not the cause.

**(2) The horse registration budget.** `pickFreeHorses` decides "free" by: the four-game load map
(live seats at non-closed tables, cash and tournament, + bookings in ANNOUNCED/REGISTERING within the
horizon) < 4; club membership (host club, or every club in the union); lane (`gameLaneFor !== 'cash'`, or
`isActiveNow` for freerolls); then the cash-room reserve (2 seats x live cash tables minus seats occupied by
anybody: 129 x 2 = 258 wanted, 325 seated -> reserve 0 today). It does NOT consult bankroll (the seat RPC's
`insufficient_balance` is the only wallet check on the seat-first path); `registerHorses` does, but on the
wrong wallet for union events (finding 8). Does it starve the cash floor? No, today: by lane, cash 329
horses / 159 idle / 158 cash seats / 17 at cap; both 342 / 54 idle / 140 cash + 437 tournament seats; events
329 / 55 idle / 117 cash + 408 tournament seats. The binding constraint on the cash floor is lane C's host
cap, not bookings. Of the tournament seats, 136 are cash-lane horses: 122 in freerolls (allowed, `allLanes`),
14 in paid events - 7 of them the 09-08 stuck seats and 7 in RUNNING MTTs registered 09-07/09-10 (the lane
loader's hash fallback at those hours, not this code). Note: 117 events-lane horses hold CASH seats; the
fleet's sit path does not consult the lane (lane A's file; noted, not mine).

**(3) The ramp vs finishes.** 24 h: 19,486 horse registrations, 5,355 starts, 5,492 created, 5,435 ended -
in equilibrium. Open bookings: 1,881 across 628 horses; 1,693 further than 60 min out (983 within 24 h,
710 beyond), 188 near, 54 past start (the stuck rows). 56,525 chips of horse buy-ins parked in far events
(DSS 14,910). Distribution: 192 horses x1, 167 x2, 112 x3, 90 x4-5, 41 x6-8, 15 x9-12, 10 x13-19, 2 x21-41.
The two outliers are a defect, not the curve: horse 312e2301 took 34 bookings between 00:00 and 01:00 UTC
into 28 different DSS events because `registerHorses` rotated its queue by HOUR ALONE, so every event ramped
in the same hour started at the same horse (finding 6). Far bookings do not count as load (60-minute
horizon on both sides), so the stock is a wallet question only; the ramp is bounded by the curve
(`onCurve`, 1 entrant for an event days out) and is not outrunning completion.

**(4) The seat-first fill errors.** All 298 `seat_first_human_waiting` alarms: 103 distinct boards. 39 are
the 09-08 finalized rows (finding 1). 64 are LIVE boards the main walk had filled seconds earlier - the fill
pass logs `seated=3`, then the fast lane, holding a `paid` it read before, ran its own top-up, which read
fresh seats, found nothing to do, returned 0, and `added(0) < shortfall(1)` raised "CANNOT FILL" (finding
7). The 10 `seat_first_seat_rpc_failed ... TOURNAMENT_SEAT_ROSTER_REQUIRED` lines are all on the 09-08 rows
(a live seat whose entrant is `eliminated`). 2 `opening_seat_rpc_failed FOUR TABLE LIMIT`: finding 9.

**(5) Same door as a human?** Not quite. The wrapper chain is parallel (lock gate -> terminal gate ->
maintenance gate -> core; both take `fn_ca_lock_tournament_seat_acquisition`, both debit through
`atomic_deduct_wallet_and_log` -> `fn_tournament_club_for_user`, same `fn_tournament_entry_split`, same
rake row, same pool increments, same booking-cap trigger on the insert and the same capacity trigger). Three
differences deny a horse what a human gets: no late registration into a RUNNING event, no
`prize_pool_finalized` reason (a trigger exception instead), and a wrong cached-count expectation under
RUNNING (finding 10, migration). The seat-first horse door also revives a vacated seat row without
`is_sitting_out = false`, which the human door writes (finding 11, migration). The four-game limit is applied
identically: the booking trigger at the insert, and the seat trigger waves through an entrant already on the
roster - horse and human alike.

**(6) Stale bookings.** `tournament_players` in `registered`/`playing` under COMPLETED/CANCELLED: 49 rows,
all from ONE cancellation on 2026-08-28, 0 in the last 24 h. Nothing counts them: the DB load counts bookings
only under ANNOUNCED/REGISTERING and the engine mirror filters the same way. Live seats at tables of
COMPLETING/COMPLETED/CANCELLED tournaments: 1. Verified-no-issue. The bookings that DO count wrongly are the
54 on the 09-08 rows (REGISTERING for ever): 50 horse seats and 2 `playing` rows read as load until finding
3's migration lands.

**(7) fn_register_horse_for_tournament.** Idempotency: `already_registered` by (tournament, user) before
the debit, unique_violation after the debit raised as 40001 so the whole transaction retries; a hinted
ticket is consumed first and a vanished hint refuses rather than charging
(`hinted_tournament_ticket_no_longer_available`). Wallet: `atomic_deduct_wallet_and_log` resolves the
member-club wallet through `fn_tournament_club_for_user` (host club for a standalone event, hash-picked
member club for a union event), identical to the human core. Fee: `fn_tournament_entry_split` -> rake_records
row with the tournament id. current_players: `v_players_before + 1` under a CAS that raises 40001 if the
cached count moved (the human core does the same, but expects the RUNNING case - finding 10).

## Findings (fixed unless marked)

### 1. P1 FIXED - a REGISTERING row whose prize pool is finalized was ramped and filled for ever
`TournamentRecurringService.ts` `topUpWithHorses` (~L5359 tRow read) and `GameServer.ts`
`discoverTournaments` (~L5193 ramp / past-start) + `discoverSeatFirstStarts` (~L7190 fill gate).
Evidence: (1) above - 40 rows, 2,965 locked RPCs and 298 alarms in the hour, 100% refused by both doors;
`prize_pool_finalized` separates them from all 293 healthy rows exactly. Change: the tRow read selects
`start_time, prize_pool_finalized`; a finalized pool returns 0 before any pick and is reported ONCE per row
per process (`TournamentRecurring.top_up_refused_pool_finalized`, `finalizedPoolTopUpsRefused`). In the
walk, `poolFinalized` withholds the RAMP and the PAST-START TOP-UP only - the start gate still runs, because a
launch that finalized the pool and lost its engine before RUNNING committed is recovered by exactly that
gate (launch-receipt adoption) - and reports once (`GameServer.registering_with_finalized_pool`, pruned with
`lastMttRampAt`). The fast lane reads the column and does not fill a finalized board. Pinned: new test
sections 1.1-1.4.

### 2. P2 FIXED - `rpc_other_noop` never said which answer the RPC gave (10.86)
`topUpWithHorses` seating loop. 330 passes at `rpc_other_noop=3` in the hour and nothing on the platform
could say why (it was `tournament_full`; the RPC has nine other `ok:false` reasons). Change: reasons tallied
per pass and printed on one extra line after the precheck line (`the seat RPC answered ok:false - reason
xN`). The precheck line and the tally/metrics are unchanged. Pinned: new test 1.3.

### 3. P0 (money) NOT FIXED IN CODE - the 40 dealt-but-REGISTERING rows need the finish path: MIGRATION FILE
`_audit/laneD-migrations/resume_the_games_dealt_on_0908_that_never_left_registering.sql`. No lane resumes a
REGISTERING row and no sweep finishes one; 10.9 path: the outcome is read from rows (above); nobody is paid
by the file; nothing is taken back; the DO block asserts every row's pre-state and ends with a RAISE for the
rolled-back probe (11.5, one MCP call). It flips 36 rows (the MTT, 13 heads-ups, 22 spins) to RUNNING with
`started_at = first hand`, after which the engine's own lanes do the rest: `discoverRunningResumes` adopts
them, `finishSeatFirstGamesThatAreOver` (RUNNING, > 5 min, silent, <= 1 live stack) wakes the elimination
sweep on the decided ones and the terminal settlement pays the winner, the 0-chip Breakfast Turbo entrant is
eliminated and the event finishes, the 11 undecided spins resume dealing. The 4 SATELLITE heads-ups
(097e3601 285.00, a4262ba0, 92c93927, 20c75b67 28.50 each) are deliberately NOT in it:
`trg_capture_satellite_economics_on_start` refuses a start whose pool is below the target's seat price, and
their finish is a seat award into a target that may have started since 09-08 - the satellite settlement
authority's decision after reading the targets. Until the file lands, 50 horse seats and 2 rows count as
load against those horses (fn_concurrent_game_load clause 1: table not closed, tournament not
COMPLETING/COMPLETED/CANCELLED).

### 4. P1 FIXED - the held-empty hold outlived a fillable board ten to one; 94% of the seat-first board was empty
`TournamentRecurringService.ts` `topUpWithHorses` held-empty gate (~L5495). Evidence: 149 of 158 open
seat-first boards empty and every one past its window; 138 of 149 held in the current bucket and 137 of 149
held in their creation bucket (script over the live ids with the file's own hash); a not-held board lives
~4 min (window 90-350 s, fill, deal, replacement by ensureBoardOpen), a held board lived until the 30-minute
bucket rolled AND the backed-off past-start ask (45 s x 2^misses, cap 10 min) came round. Dan's rule is a
share of the board at any instant (08-26) and his later, more specific rule on how long a seat is kept for
a person is the window itself: "hold the seat for 90-350 seconds max before filling" (09-05). Change: the
gate applies only while `start_time` is in the future (`humanWindowOpen`); after the window a held board
fills like any other through the past-start top-up. `seatFirstHeldEmpty` (id + bucket) and
seedOpenSeatTable's roll are unchanged, so a held board still opens with nobody in it; the pin
"gate only applies to a board with nobody in it" (`liveCount === 0` within 400 chars) still holds. Pinned:
new test section 2 (held + window open -> 0 and no pick; held + window closed -> fills; not held -> fills).

### 5. P1 FIXED - Deep Stack Society boards never opened with a horse
`seedOpenSeatTable` (~L4384): `const isHouseBoard = tournament.club_id === this.houseOwner.clubId;
opening = isHouseBoard && !held ? seats-1 : 0`. The pool has been club-scoped since 09-01
(`pickFreeHorses(opening, false, tournament.id)` -> `clubMemberIdsForTournament`), and the 09-03 changelog
"a club board fills from its own members" says DSS boards fill from DSS horses; this guard predates that and
protected nothing. Evidence: 82 of 83 open DSS seat-first boards with no seat sold (house: 67 of 75, from
finding 4). Change: the house condition is dropped; a club with no horse members still opens empty because
the pool is empty. Pinned: new test section 3; `seatFirstCountSync.test.ts` pins on the body still hold.

### 6. P1 FIXED - the ramp queue rotated by hour alone, so one horse took 34 bookings in an hour
`registerHorses` (~L6104): `(hour * 7919) % pool.length` for every tournament ramped that hour. Evidence:
(3) above - 312e2301 x41 (34 in one hour, 28 events), 4bb5f4b5 x21, 27 horses >= 9; every booking a real
buy-in from one wallet. Change: `rampQueueRotation(tournamentId, hourUTC, poolLength)` (exported, pure:
mix32 of horseHash(id) ^ hour*7919, mod length) for both the ticket and the wallet queue; the hourly
movement is kept. Pinned: new test section 4 (200 events in one hour -> > 100 distinct starts; stable within
an hour; moves across hours; never out of range) + source. `HorseTournamentBankroll.test.ts` partition/slice
pins unchanged.

### 7. P2 FIXED - the fast lane alarmed "CANNOT FILL" on boards the walk had just filled
`GameServer.ts` `topUpPartialSeatFirst`: `shortfall = seats - paid` used this lane's read; the top-up read
fresh seats, found the walk's fill, returned 0. Evidence: 64 of 103 alarmed boards in the hour show
`seat-first-precheck ... seated=3` seconds before the alarm and `Starting...` right after (e.g. ffc36683,
61fd0ac8, 99942691, 18329039, 90635dfc). Change: a short result re-reads `readSeatFirstPaidSeats([{id}])`
once; a full board clears its misses and raises nothing; an unreadable re-read keeps the alarm. Pinned: new
test 1.5.

### 8. P2 FIXED - the MTT bankroll gate read a wallet the database never debits
`registerHorses` bankroll block (~L6017). It read `club_members` at `tournaments.club_id`; for a union event
that is the union's own house row (fade0000). `atomic_deduct_wallet_and_log` -> `fn_tournament_club_for_user`
(read from pg_proc) charges one of the horse's wallets at the union's MEMBER clubs (`union_clubs`; the host
row is only reachable as `p_preferred_club`, which the horse door never passes). So 323 horses were judged
on a wallet that is not charged and 261 on no wallet (fail open) - the same wrong-wallet shape as lane A #2
and lane B #15. Change: `walletClubsForScope(hostClubId, unionId)` mirrors the resolver (standalone -> host
club; union -> union_clubs, null on a failed read); the roll read is chunked (`selectInChunks`, the eligible
list is the whole fleet and one `.in()` past ~675 ids is an HTTP 400 that read as "no rolls") across those
clubs, `status in (active, approved)`, and the horse is judged on the SMALLEST wallet the hash could pick.
Fail-open shape unchanged (`if (rollPage.complete)`, `roll === undefined -> true`). Effect today is small
(Midway p10 rolls 15.8k-24.8k against 60 buy-ins x 50 = 3,000 for the dearest recurring event); it is
correct rather than accidental now. Pinned: new test section 5.

### 9. P2 FIXED - the picker's booking horizon (30 min) disagreed with the trigger's (60 min)
`REGISTRATION_LOAD_HORIZON_MS = 30 * 60_000` vs `fn_concurrent_game_load` clause (2) "from ONE HOUR before"
and `HorseGameLoad.BOOKING_COUNTS_WITHIN_MS = 60 min` (lane A verified the fleet's mirror). Evidence: SQL
reproducing both counts over 1,000 horses: 21 horses read pickable by the engine and at four in the
database; `FOUR TABLE LIMIT ... x1` lines on every MTT registration pass and the 2 `opening_seat_rpc_failed`
in the hour. Change: `REGISTRATION_LOAD_HORIZON_MS = BOOKING_COUNTS_WITHIN_MS` (imported). Pin in
`HorseConcurrency.test.ts` updated in the same edit (was `toBe(30 * 60_000)`).

### 10. P1 NOT FIXED IN CODE (DB) - horses cannot late-register; a finalized pool is an exception, not a reason: MIGRATION FILE
`_audit/laneD-migrations/horse_door_admits_late_registration_and_names_a_finalized_pool.sql`. Evidence:
pg_proc text (5) above; log: `HorseOverlayGuard ... Morning Free Buy (NLH) wanted 9..24 more and added NONE`
every 2 minutes with `Horse registration: 0 seated, skipped - registration_closed x9..x24` beside it - the
event is RUNNING with late registration open, humans may enter, horses may not (10.5). The migration
rewrites `fn_register_horse_for_tournament_before_maintenance_gate` to the human core's status test
(finalized -> `registration_closed` as a reason; RUNNING admitted while `fn_tournament_late_registration_open`),
the human core's cached-count expectation, and the human core's late seat (`fn_seat_late_registrant`,
55000 abort so an unseatable entrant is not charged); adds `fn_register_horse_for_tournament_before_atomic_
lifecycle_gate` (one `fn_ensure_late_registration_capacity` repair + retry, `late_registration` wake) and
routes the terminal gate through it. Every other line is byte-identical to production. Not mirrored: the
human door's `seat_first_variant` refusal (needs an internal flag on every horse signature; the engine never
registers a horse into a seat-first game). HorseOverlayGuard's "every candidate is outside its activity
window or at the four-table cap" line is a misdiagnosis of this (not any lane's file): it should print
registerHorses' failure summary; resolves itself once the door admits late registration.

### 11. P3 NOT FIXED IN CODE (DB) - a reused seat row is handed to a horse sat out: MIGRATION FILE
`_audit/laneD-migrations/horse_seat_first_seat_is_not_sat_out_on_reuse.sql`. fn_take_seat_and_buy_in
revives a vacated row with `is_sitting_out = false`; fn_seat_horse_in_seat_first_game does not. 0 live
occurrences (measured: every seat-first seat, REGISTERING or RUNNING, reads false). One line.

### 12. P2 FIXED - the discovery walk's REGISTERING read was unbounded (1,000-row silent cap)
`GameServer.discoverTournaments` first read. 335 REGISTERING today, 353 after a thaw, growing with every
activated club board; the 1,001st row would never start, ramp or fill and nothing would say so. Change:
`fetchAllRows` keyset on id (`GameServer.registeringBoard`), incomplete -> the existing
`registering_board_read_failed` skip. `for (const tournament of registering || [])`, the `{ pass:
topUpPass }` count, the readAt/read/retain order and the `error: registeringErr` pin are preserved.

### 13. P3 NOTED - the past-start MTT top-up has no per-call step
`topUpWithHorses` -> `registerHorses(id, max_players - live)`: sequential locked RPCs, unbounded per call
(the ramp caps itself at 6 per 45 s pre-start for exactly the lock-convoy reason). Breakfast Turbo took
229-240 calls per pass (2+ minutes of the settlement lane) before finding 1; a healthy 500-seat DSS event
past start and short of min_players would do the same once. Rare (only when the ramp missed min_players),
and Dan's "fill to a FULL FIELD" is the written rule; a per-call step (e.g. 4 x MTT_PRESTART_MAX_STEP, the
top-up re-runs every 45 s) is a pacing decision I did not take. Left, documented.

### 14. P3 NOTED - the engine's seat load counts seats at tables of COMPLETING/COMPLETED tournaments
`horseLoadMap` clause (a) excludes closed tables only; `fn_concurrent_game_load` (2026-09-10) also excludes
tables whose tournament is COMPLETING/COMPLETED/CANCELLED. Engine stricter by 1 seat today (measured).
Mirroring needs a nested embed tables -> tournaments whose FK name I did not verify (the PGRST201 lesson);
left.

### 15. P3 NOTED - `readSeatFirstPaidSeats` and the fast lane's board read are unpaged
`.in('tournament_id', ids)` over every REGISTERING seat-first row (158 today; ~675-id URL ceiling), then
`table_seats .in('table_id', ...)` capped at 1,000 rows. Fine at 3x today's board; the fast lane is
deliberately "three cheap reads". Left, documented.

### 16. VERIFIED (question 2) - the tournament budget does not starve the cash floor today
Numbers in (2). pickFreeHorses' cash-room reserve is 0 (325 seated vs 258 wanted); registerHorses has no
reserve at all (asymmetry noted, moot at reserve 0); 159 cash-lane and 54 both-lane horses idle.

### 17. VERIFIED (question 3) - the ramp is not outrunning completion
Numbers in (3): starts 5,355 / ends 5,435 per day; far bookings bounded by the curve; the concentration
was finding 6.

## Tests

- NEW `aFinalizedPoolIsNotFilled.test.ts`: section 1 (finalized refusal, once per row, no pick, no RPC;
  ordinary board unchanged; other-noop reasons logged; GameServer walk + fast lane + re-read pins),
  section 2 (held gate is the window: 3 behavioural cases + source), section 3 (seedOpenSeatTable),
  section 4 (`rampQueueRotation`: spread, stability, range, wiring), section 5 (bankroll wallet).
- `HorseConcurrency.test.ts`: the 30-minute pin replaced by `toBe(BOOKING_COUNTS_WITHIN_MS)` and 60 min.
- Re-checked against the edited source: seatFirstHoldRotates (`liveCount === 0` within 400 chars of the last
  `seatFirstHeldEmpty(`; hash/bucket function untouched), seatFirstCountSync (seedOpenSeatTable body: RPC
  present, no sync; createSpin/createSNG bodies untouched), seatFirstSeatPrecheck (loop body up to the log
  line: no else added, no break added, RPC args unchanged; behavioural harness rows carry no
  prize_pool_finalized so the new gate is false), seatFirstFillOrder (one break, the seats-full guard;
  `if (tErr || !tRow)` before `isSeatFirstFormat(`; horseLoadMap `return null` x2), HorsesStayInTheirClub
  (HELPER slice now also holds walletClubsForScope; every pin still present), aClubBoardFillsFromItsOwnMembers
  (`pickFreeHorses(poolWanted, false, tournamentId, pass)` unchanged), HorseTournamentBankroll (cost regex,
  `pool = pool.filter((h) => {`, `roll === undefined`, `rollPage.complete`, partition/slice lines unchanged),
  HorseTournamentTicketRail (lane -> bankroll -> partition -> slice order unchanged; reads a fixed
  migration file, not mine), theWalkReadsTheFleetOnce (`{ pass: topUpPass }` x2, clock set after the
  re-check, drain before the stall block, no inline await), seatFirstStartStall (`error:\s*registeringErr`
  and the label still present), spinLaunchParking (readAt < `.eq('status', 'REGISTERING')` < retain),
  DirectEngineRecovery (both loops still `while (this.directAdmissionIsCurrent(generation))`, no
  `new TournamentManager(`), pickFreeHorsesLimits, clubOwnerSngBoards, heldEmptyRotationAndSoleOpen,
  theClubProgrammeMirrorsTheHouse.
- I could not run vitest here; please run in `server/`:
  `npx vitest run src/services/aFinalizedPoolIsNotFilled.test.ts src/services/HorseConcurrency.test.ts src/services/seatFirstHoldRotates.test.ts src/services/seatFirstCountSync.test.ts src/services/seatFirstSeatPrecheck.test.ts src/services/seatFirstFillOrder.test.ts src/services/HorsesStayInTheirClub.test.ts src/services/aClubBoardFillsFromItsOwnMembers.test.ts src/services/HorseTournamentBankroll.test.ts src/services/theWalkReadsTheFleetOnce.test.ts src/services/seatFirstStartStall.test.ts src/services/pickFreeHorsesLimits.test.ts src/services/oneCandidatePerSeatIsABet.test.ts src/services/MttPrestartRamp.test.ts src/services/GuaranteedRestartLead.test.ts src/services/FourTableLimit.test.ts src/tournament/spinLaunchParking.test.ts src/tournament/HorseTournamentTicketRail.guard.test.ts src/engine/DirectEngineRecovery.guard.test.ts src/engineStartBudget.test.ts src/bootOrderDiscoveryFirst.test.ts`

## Migrations (files only, none applied) - `_audit/laneD-migrations/`

1. `resume_the_games_dealt_on_0908_that_never_left_registering.sql` - finding 3. Probe it as ONE MCP call
   with the final RAISE kept (an error is the success case), apply once outside :50-:03 with the RAISE
   removed, then watch `discoverRunningResumes` adopt the 36 and the finish sweep settle the decided ones.
   Settle the 4 satellites separately.
2. `horse_door_admits_late_registration_and_names_a_finalized_pool.sql` - finding 10. Reserve a version
   with `node scripts/new-migration.mjs`; probe in a DO block that ends by RAISE.
3. `horse_seat_first_seat_is_not_sat_out_on_reuse.sql` - finding 11.

## Verified - no issue (do not re-audit)

- `HorseTopUpPass`: `once` holds a pending promise keyed per pass, drops it when `keep` is false or the
  read throws, `forget` on any seat/registration; age measured from the request; `viaTopUpPass` bypasses
  when no pass. Fail-open/closed decisions are unchanged by the pass (unknown never held).
- `horseLoadMap`: keyset-stable ordering on both reads (user_id, table_id / user_id, tournament_id),
  runaway guard, null on any failed page (never an empty map), embed names
  `tables!table_seats_table_id_fkey!inner`, seat-first dedupe via `buildHorseLoadMap` mirrors the DB's
  NOT EXISTS clause; RUNNING absent from the registration read (correct: seats count).
- `pickFreeHorses`: whole fleet keyset-paged, incomplete -> [] and reported; club scope null -> no filter
  (fail open); shuffle with `nodeCrypto.randomInt` before the reserve trim; reserve = 2 x live cash tables
  minus everybody seated (humans included), chunked count, unreadable -> 0 and reported; slice after trim.
- `registerHorses`: busy = load >= 4 plus everybody already on THIS roster (paged, incomplete -> 0); ticket
  hints before lane/bankroll/count; `p_allow_wallet_charge: !hinted`; freeroll: broke horses first, broke
  measured against the cheapest paid event on the board; every RPC refusal and `ok:false` reason summarised;
  freeze `break`s the loop.
- `mttPrestartHorseTarget`: never above `seats - 1`, guarantee raises the floor only, step
  `MTT_PRESTART_MAX_STEP`, seat-first returns 0, past start returns 0 (the past-start branch owns it);
  `MTT_PUBLISH_LEAD_MS` 30 min = 40 ticks. Pinned by MttPrestartRamp / GuaranteedRestartLead, untouched.
- createTournament / createXMTT: `current_players: registered` written right after the register RPCs which
  themselves set the exact count - same value, no drift window (creation is 30 min before any human can see
  the row); createSNG writes it only for field SNGs; createSpin never.
- `seatFirstFillOrder`, `seatFirstCandidateCount`, `seatFirstSeatLedger` / precheck / refresh /
  `isExpectedSeatRefusal`: pure and as pinned; the verify re-read is lock-free; a `table_full` from the RPC
  stops the spares for the pass.
- `seedOpenSeatTable`: `continue` on freeze, refusals reported (FOUR TABLE LIMIT counts as a refusal here:
  2 in the hour, both the 30-vs-60 horizon of finding 9).
- `unseatedRegistrantHorses`: roster minus live seats, horses only (a human who has not sat has not
  decided), every read fails closed to [].
- `checkAndLaunchSpins/SNGs/ensureBoardOpen`: one REGISTERING instance per config name per owner,
  joinability by table status, BURST split per owner, satellites deliverable-only.
- `HorseTournamentCommitment`: pure; window = `BOOKING_COUNTS_WITHIN_MS` (60 min, the DB's), certain inside
  15 min, hazard 1/N per cycle, cash seats only, human table last.
- GameServer start gate: seat-first on paid seats (`readSeatFirstPaidSeats`: primary table = most seats then
  oldest, count = every live seat across duplicate tables), MTT on `current_players >= min_players` at
  T-60 s or `maxReached`; `tournamentEngines` re-checked synchronously before every admission; the
  fully-paid stall watchdog and `spinLaunchParks` untouched. No `is_horse` anywhere in the admission path.
- The launch (TournamentManagerBase): receipt claimed before any launch mutation, RUNNING committed only
  after `proveTournamentLaunchSetup` (status still REGISTERING, roster, seats, stacks, funding entitlements
  for spins) and before any dealer - the 09-08 shape cannot recur from this path (measured: none after
  09-08 14:53).
- tournament/*: the only horse branches are the add-on and rebuy input devices (10.5-sanctioned); seating
  and stack credit have no horse branch.
- DB: `fn_enforce_booking_game_cap` and `fn_enforce_four_table_limit` take the same per-account advisory
  lock, refuse at 4, count identically for horses and humans, no `is_horse`; `fn_enforce_tournament_capacity`
  counts every entry on a seat-first board (busted or not) and live entrants on an MTT;
  `fn_tournament_entry_cap_reached` = GREATEST(cached, entries) >= cap; `fn_ca_lock_tournament_seat_
  acquisition` admits ANNOUNCED/REGISTERING/RUNNING.
- `fn_seat_horse_in_seat_first_game`: primary table by the same election the engine uses; already_seated
  before the free-seat search; registers only a new entrant; `seat_taken` on the unique violation; count
  synced in the same transaction.
- 10.5 in every edited file: no `is_horse` filter denies a horse anything a human gets; the only
  `is_horse` reads are identification (who is a horse) and the fill order's "horses only" for registrants
  who have not sat, which protects a human's undecided money.
