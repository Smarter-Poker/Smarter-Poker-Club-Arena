# Lane C - Operation Stable Hand: planner, caps, tag book, mutex, executor, beats, cluster census, tagger (audit 2026-09-11)

Files edited: `server/src/services/StableHand.ts`, `StableHandController.ts`, `StableHandSnapshot.ts`,
`StableHandBeats.ts`, `server/src/scripts/horsesTag.ts`; tests `StableHand.test.ts` (+3 describes / 8 cases),
`StableHandController.test.ts` (+2 describes / 7 cases), `StableHandBeats.test.ts` (+1 describe / 2 cases).
Read in full: StableHand.ts (1653), StableHandController.ts (713), StableHandExecutor.ts (820),
StableHandSnapshot.ts (318), StableHandBeats.ts (247), StableHandPlanBus.ts (93), StableHandState.ts (219),
StableHandTags.ts (404), horsesTag.ts (342), ClusterController.ts (693), ClusterMetrics.ts (255), FreeBuy.ts
Chicago helpers (L240-315), HorseSitVerdict.ts (as the mutex caller), the fleet's cap / tag / state / beat /
open-order call sites (HorseFleetManager L1860-1935, 2640-2880, 3150-3230, 3560-3680, 3930-4055),
`fn_cash_cluster_tick` from pg_proc, handlers/stableHand.ts, HorseBehavior.ts header.
`node --experimental-strip-types --check` passes on all 8 edited files. Every new pure-function assertion in
the three test files was executed against the edited sources with a strip-types harness (rewritten `.js`
imports) - all pass, including the pre-existing `assignPreferredStakes` pins. No em dash, no emoji in the diff.

## Live measurements (read-only SQL, 13:26-13:40 UTC = 08:26-08:40 Chicago)

- Open cash floor: DSS 53 tables (all cluster), 324 seats, 130 seated (40%), 59 horse bodies, 2.20 seats/body,
  0 humans. Midway 76 tables (all cluster), 480 seats, 204 seated (42.5%), 84 bodies, 2.43 seats/body, 0 humans.
- Stable Hand caps in the 60-min log: Midway 72 -> 82, DSS 50 -> 57, both hosts pinned AT the cap from the
  second cycle after the 12:55 boot (`fade0000=82/82 2a1132b9=57/57`). `held back by the per-host cap`:
  1,213 pairs on the first cycle, then 2,600-3,344 pairs EVERY cycle; `Seated N horses` per cycle: 87, 23,
  10, 22, then 1-8. The cap is the binding constraint on the floor right now, on both hosts.
- The engine's Chicago clock is right: caps 72->82 on N=584 back-solve to 10.3% -> 12.0% of N, i.e. the
  curve between 08:01 and 08:27 Chicago (interpolated 10 -> 14), matching the UTC-5 window of the log.
- `stable_hand_beats`: last beat 12 s old, 105 beats/host in the last hour, 15,696 rows. Latest row Midway:
  unique_live 82, cap_max 83, target 71, 12 FULL / 4 ONE_OPEN / 25 JOINABLE of 76, `shape_error 55`,
  `seats_per_horse_out_of_band avg=2.44`. DSS: 59/59, `shape_error 26`, avg 2.20.
- Tag book: 1,580 rows, `tagged_at` = 2026-09-04 08:42 on ALL rows although `preferred_stakes` carry the
  09-05 re-tag's values (10/20 and 20/50 appear: 20 Midway tags) - the re-tag did not stamp the column.
  Stake distribution cash tags: DSS 292 (0.02..2/5), Midway 815 (0.02 .. 20/50).
- Tag book vs the live ladder (`cash_games` enabled, not closed, per host): Midway cash tags with NO enabled
  game matching (variant AND stake) 92 of 815; 69 name a stake the host deals in no variant; 57 of those name a
  stake DSS deals (so they never fall through to the band). Per body (best of its two wallet tags):
  Midway 51 of 530 cash-capable bodies, DSS 2 of 292, can never sit at any cash table on their host.
- Enabled games matching a body's tags (one seat per game is enforced, ALREADY_IN_GAME): DSS avg 2.93, 156 of
  292 cash bodies have <= 2 games, 193 have < 4; Midway avg 5.15, 58 bodies at 0, 95 at 1-2, 254 < 4.
- `stable_hand_horse_state`: rest_weekday exactly 1/7 each (143 x 7), so 143 horses rest every day (774
  pairs `on a rest day` per cycle in the log, Friday); daily caps 510-660; 0 horses at their cap today;
  counters reset today on 266 rows (the seated ones); session_start_balance set on 636.
- `nothing_to_seat` / `Stable Hand open order ... refused`: 0 in today's log (both hosts at cap so no open
  order is emitted); 328 in the 09-09 90-min log, all `nlh 25/50 on host fade0000 ... switched off`.

## Findings

### 1. NOT FIXED - two written rules on occupancy: named, sourced, and put as options (CLAUDE.md 10.8 / 10.9)

Side A: `HorseBehavior.ts` L60-70, Dan verbatim 2026-09-02: "HORSES NEED TO BE OCCUPYING AT LEAST 75% OF ALL
SEATS IN THE CASH GAMES, AND THEY SHOULD BE PLAYING 4 TABLES AT ONCE" (`CASH_FULL_FRACTION = 0.75`,
HorseOccupancy.test.ts).
Side B: `StableHand.ts` L118-147 `OCCUPANCY_CURVE_PCT` ("Values are the OPORD's table verbatim"), peak 40%
(`peakCap`), night 5%. Where it is written: the OPORD itself is NOT in this repo (referenced by section
number in 30+ files, never quoted on the curve). The only agent-written provenance is
`docs/changelog/2026-09-04-operation-stable-hand-recon.md` s2 "Dan asked for 40% at peak" (a paraphrase,
no quote). The only Dan VERBATIM about the curve is the night ruling, `StableHand.ts` L85-97, 2026-09-04:
"there should not be 89 people playing in the middle of the night, cut that from 10% to 5%" - Dan read the
curve's output and adjusted one value of it, two days AFTER the 75% rule, which he never retracted.
So: side A is Dan verbatim; side B's night half is Dan verbatim and later; side B's daytime shape (40% peak,
9-22% mornings) is a table with no quote behind it in this repo. Under 10.8 that daytime shape is the
weaker document, but it is not "nothing" (Dan reviewed its numbers), so I did not change a constant.
What the arithmetic says (this is the part nobody had written down): with 4 tables per body the two
rules AGREE from about 11:00 to 00:00 Chicago (22% x 584 x 4 = 514 seats > 360 = 75% of Midway's 480;
22% x 416 x 4 = 366 > 243 on DSS) and disagree only 01:00-10:59, where Dan's later night ruling is the
more specific statement. With the MEASURED 2.2-2.4 tables per body they still agree 12:00-00:00. The
conflict is therefore confined to the morning ramp (08:00-11:00, 10% -> 22%) and the night, and TODAY
(08:30) is inside it: 59 + 84 bodies x 2.3 = 40-42% of seats.
Options for Dan, cheapest first: (a) keep the curve, get 4 tables per body (findings 3 and 4 are what
stops that; DSS then reaches 72% of seats at 08:30 on the same 59 bodies); (b) raise the 08:00-11:00
rungs of the curve (a config change in OCCUPANCY_CURVE_PCT, one edit + the T20-series pins); (c) drop the
daytime curve and keep only the 03:00-08:00 night cap. Recommendation: (a) now, it needs no ruling and
is where the seats are; (b) only if Dan wants 75% at 09:00 as well.

### 2. P1 FIXED - the tag book was drawn from the PLATFORM ladder, so 51 Midway bodies could never sit

`StableHand.ts` `assignPreferredStakes` (old L1606-1653) drew anchor + neighbour from `STAKE_LADDER`
(11 rungs) and `assignVariants` from `VARIANT_COVERAGE` with no knowledge of what the HOST deals.
Measured (above): Midway deals no 0.01/0.02, no 0.02/0.05, nothing above 2/5 in any variant, and 1/2 only
in pineapple/plo8/short_deck; 69 Midway cash tags name a stake the host deals nowhere, 23 more name one it
deals only in a variant the horse is not tagged for; 51 of 530 cash-capable Midway bodies (2 of 292 DSS)
have no sittable tag. And they never fall through: HorseFleetManager L2708-2716's stranded-tag test is
against `stakesWithAGame`, which is built from EVERY open table on the platform (L1686-1692), and DSS
deals 0.02, 0.05 and 50, so 57 of the 69 are refused `tag` at every Midway table forever
(`tags: 61032 pair(s) excluded` per cycle). Also produces the daily "No available horses for PLO4
0.01/0.02 Classic" lines: those DSS micro rungs are tagged on 23 DSS bodies only.
Change: `PreferredStakeOptions.dealt` (the bb's the host deals in at least one of the horse's variants):
rungs filtered to dealt; a drawn band with none dealt drops DOWNWARD to the nearest band with one (never
up); nothing affordable -> cheapest dealt rung; the neighbour rides only when dealt. `assignVariants`
takes `allowed` (variants the host has an enabled game of). `horsesTag.ts` reads each host's ladder from
`cash_games` (`loadHostLadder`, paged, fail-closed with a throw) and passes both. Without `dealt` the draw
is byte-identical to before (pinned). Simulated against the 1,164 live Midway memberships and the live
ladder with the edited code: cash tags with no matching game 95 -> 0, stranded bodies 59 -> 0, bodies with
< 4 matching games 248 -> 182. Tests: 'a tag names a stake its host deals' (6 cases).
TO LAND IT: `cd server && npm run horses:tag -- --club=all --dry-run` then `--force` (the no-op guard
compares row counts, so a re-tag needs --force; the tags then carry `tagged_at` = now, finding 10).

### 3. P1 NOT FIXED (config, not code) - DSS's ladder makes 4 tables per body impossible for 66% of its horses

One seat per game is the rule (HorseBuyerAllocation L112, DB ALREADY_IN_GAME); a tag is 1-3 variants x
1-2 rungs; DSS runs ONE game per (variant, rung) (`cash_games` DSS: 42 games, template 'classic' only)
while Midway runs three templates (classic/action/madness) on its popular rungs. Measured: 156 of 292 DSS
cash bodies have <= 2 matching games, 193 have < 4; Midway 254 of 530 < 4 (182 after finding 2). This is
the ceiling on `seats_per_horse` 2.2 that the beats alert on every cycle, and the reason "4 tables at
once" cannot be met on DSS by any seating code. Not code: either DSS gets action/madness templates on its
0.5/1, 1/2, 2/5 rungs (cash_games rows, an operator's), or Dan widens a horse's stakes past "a stake and
the one adjacent rung" (Section 8.7, and his 08-29 "a horse plays one stake level"). Flagged for Dan with
the numbers; not touched.

### 4. P1 FIXED (StableHand side; HorseSitVerdict edit described) - the mutex refused `brm` on an UNREAD roll

`HorseSitVerdict.ts` L215 `const balance = ctx.bankrolls.get(...) ?? 0` feeds `evaluateSit({ available:
balance })`; `StableHand.evaluateSit` L1294 `isLicensed(0, bb)` is false for every stake, so when the
bankroll read fails (`bankrollsLoaded` false, map empty) every tagged horse with a state row is refused
`brm` at every table - the exact 2026-08-31 shape, one gate down from the candidate filter that was
carefully made to fail open (HorseFleetManager L2748-2791). Reasoning trace, not a log hit: the read has
not failed in either log; it is the latent P0 the doctrine in the same file (L1428-1502) says must not
exist. Change: `SitRequest.available` / `sessionStartBalance` are `number | null`; null skips the two
money checks only (identity checks unchanged); `commitAllows` falls back to `available` when the session
start is null. Pinned: 'an unread roll is not a zero at the mutex' (2 cases).
EDIT NEEDED IN `HorseSitVerdict.ts` L215-229 (lane A's file):

```
const roll = ctx.bankrolls.get(`${seatClub}:${horseId}`);
const balance = ctx.bankrollsLoaded && roll !== undefined ? roll : null;
...
available: balance,
sessionStartBalance:
  balance === null
    ? null
    : (ctx.horseTables.get(horseId)?.size ?? 0) === 0
      ? balance                                   // a NEW session: never last week's start
      : (sitState.sessionStartBalance ?? balance),
```

The second half fixes a P3 in the same lines: `sessionStartBalance` is written when a session starts
(HorseFleetManager L3219) and never cleared, so the first sit of a NEW session is judged against the
previous session's start balance (636 rows carry one).

### 5. P1 FIXED - the planner asked for a band the host has no enabled game in; the seeder refused it forever

`StableHandController.ts` old L365-375 / L401-411: `neediestStakeBand(bandSeats)` over the platform's
four bands; `high` holds 0 seats on Midway because the operator closed every game above 2/5 on 09-04, so
its deficit (0.11) wins every under-curve cycle, `stakeForBand('high')` = 25/50, and
`openPlannedTables` (HorseFleetManager L4002-4023) refuses it: 328 identical lines in the 09-09 90-min
log; 0 today only because both hosts are AT the cap (`roomForMore` false). An order that can never be
filled re-issued every 30 s. Change: the snapshot reads the host's enabled ladder (`enabledGamesFor`,
`cash_games` enabled + not closed, paged, unreadable -> left OUT, never emptied); `HostSnapshot.enabledGames`;
`neediestStakeBand(seats, eligible)` returns null when no eligible band; `openOrderFor()` names the top
enabled rung of the band, nlh first, on `OpenOrder.stake`; no eligible band -> no order + alert
`open_suppressed_no_enabled_game`. Without a ladder the old order is emitted (old behaviour, the seeder's
own disabled check stays the last line). Tests: 'an open order names a game the host has' (5 cases) +
source pins on the snapshot read.
EDIT NEEDED IN `HorseFleetManager.ts` L3991 (lane A's file): `const stake = order.stake ??
stakeForBand(order.band);` (the PlanBus pins on `p_sb: stake.sb` / `p_bb: stake.bb` are unchanged).

### 6. P1 FIXED (own file) / EDIT DESCRIBED (fleet) - the stranded-tag fallthrough is platform-wide

Same root as finding 2 from the seeder's side: `HorseFleetManager.ts` L1686-1692 builds `stakesWithAGame`
over every open cash table on BOTH hosts, and L2712 tests a Midway horse's tag against it. Finding 2 stops
the tagger producing such tags; the seeder should still judge per host so a game switched off on one host
after tagging does not strand its horses. Edit: `const stakesWithAGame = new Map<string, Set<string>>()`
keyed by `String(t.club_id)`, `stakesWithAGame.get(hostId)?.add(...)`, and at L2712
`!tag.preferredStakes.some((s) => stakesWithAGame.get(String((table as any).club_id ?? ''))?.has(
Number(s).toFixed(2)))`. Update the three literal pins in
`theFeederFillsFromTheCountItOpenedOn.test.ts` L226-236 in the same edit.

### 7. P2 FIXED - `lastBeatAt` coerced a failed read into `never_beat` (10.86)

`StableHandBeats.ts` old L184 `if (error || !data) return null`. `beatVerdict(null)` = `never_beat`, and
HorseFleetManager L3639-3660 raises a financial alert "has never written a heartbeat - the controller
looks installed but is not running" on it; the dashboard printed the same verdict with HTTP 200. A
PostgREST blip said the controller was not installed while it beat every 34 s (measured above). Change:
a read error throws (the fleet's existing try/catch reports it and raises nothing; the dashboard answers
500 `stable_hand_dashboard_failed`); an honest empty table is still null. Pinned by source + both readers.

### 8. P2 FIXED - yield victims were picked blind: `sittingOut` false and `minutesAtTable` 0 for every horse

`StableHandSnapshot.ts` old L297-303 hard-coded both, so `pickYieldVictims` (Section 5.5: sitting out
first, then shortest time at the table) fell through to smallest stack on every table: a sitting-out horse
kept its chair while the shortest stack was stood for a waiting human. Change: the seat read selects
`joined_at, is_sitting_out` and fills both. `isRed` stays false (the invested figure lives in the
rotator's ledger read; documented). Source-pinned.

### 9. P2 NOT FIXED - `mayRebuyInSeat` / `inTwoHourWindow` / `TWO_HOUR_WINDOW_MS` have no live reader (lane A 11)

`StableHand.ts` L988-1005, `StableHandTags.ts` L395-404; `two_hour_window` is written every cycle
(HorseFleetManager L3601-3607, now keyed per game after lane A). The OPORD (Section 9, "2-hour same-key
window" in the recon's build list) makes it a SIT rule ("stops a horse buying straight back into a game it
just left"), which would belong in `evaluateSit` as a `rebuy_window` rejection. Not wired: it is a new
refusal gate on a floor whose complaint is too few horses, its provenance is the OPORD alone, and with the
game-level key a wind-down or session end would bar that horse from that game for two hours. Decision for
whoever owns the OPORD; the column write is cheap and correct meanwhile.

### 10. P3 FIXED - `tagged_at` never moved on a re-tag; the tagger's weekday was server-local

`horsesTag.ts`: the upsert row now carries `tagged_at: now` (the column default fires on INSERT only, so the
09-05 re-tag left all 1,580 rows at 09-04 08:42 - the freshness question in the brief was unanswerable).
`daily_cap_minutes` used `new Date().getDay()` (UTC on the engine) - now `chicagoNow().weekday`.
Remaining P3, documented in the file: the cap is FROZEN at tag time, so weekend_heavy's Fri-Sun 660 /
weekday 360 split cannot follow the calendar (all 143 weekend_heavy bodies carry whichever day they were
tagged on). Reader-side fix (HorseFleetManager L2733, lane A's file): `dailyCapReached(st, todayKey)` ->
compare against `tag?.personaCash ? dailyCapMinutes(tag.personaCash, chicagoWeekday) :
st.dailyCapMinutes`. Also noted: `personaOf` is per BODY from per-WALLET tags (last writer wins, SHARK
for Midway bodies) - deterministic, harmless, noted.

### 11. P2 NOT FIXED (dead path, documented) - the night park is a no-op; nothing consolidates the night

`StableHandController.ts` L497-518 never parks a cluster table; `StableHandExecutor.setTableFlag` L397
refuses one. Every open cash table on both hosts is a cluster table (53/53, 76/76 measured), so
`plan.park` is always empty and `park_pending` 0 in every beat since Gate 7. Dan's "fewer tables, more
players at each table" at night is now served only by `fn_cash_cluster_tick`'s BREAK rule (everyone fits
in the rest -> newest table breaks), which is per game, not per host. `unparkTables` costs one indexed read
per cycle for 0 rows. Left as is; the ClusterController owns table lifetime by design (R9).

### 12. P3 NOTED - `plan.stand` `shape_adjust` orders are never executed

`StableHandExecutor` executes `human_yield` and `occupancy_wind_down` only (`ripeYields` / `ripeWindDowns`
filter by reason); `planFloor` step 2/3 emits `shape_adjust` stands (FULL -> ONE_OPEN / JOINABLE). Reported
only, by design (executor header). Consistent with the shape being off (`shape_error 55`), not a bug;
recorded so nobody reads the beat's stand counts as executed.

## Verified - no issue (do not re-audit)

- Mutex key agreement: `gameKeyForTable` is the ONE function for the verdict's `sitKey`
  (HorseSitVerdict L214), the seeder's `sitOnKey` (L3211-3215: `takenKey = sitKeyOf.get(...)` = the
  verdict's key) and the seat-key diff that opens `closedKey` (L3597). All three agree on
  `host:cluster_id:variant:sb:bb`. `cash_sits_today` rows keyed on old table names read 0 until Chicago
  midnight (lane A), then self-heal.
- `evaluateSit` order: killed, other_host, other_club, seat_cap (min(4, tag max)), ladder top, rest_day,
  sit_cap, brm. `other_club` refusals (9-160 per cycle) are lane A's finding 2 (union tournament seats),
  `sit_cap` (37-48 per cycle) lane A's finding 3 (per-chair keys); both fixed in HEAD, not deployed.
  `aggregate_exposure` 66-881 per cycle: lane A finding 1, same.
- `stableHandHostCaps` / `hostAllowsNewBody` / `bodiesOnHostFrom`: N from the fleet's membership map
  (584/416, matches `eligibleBodies`); cap = `occupancyTargetForHost(...).max`; bodies count humans and
  horses; a body already on the host may open another table; human rescue bypasses; unreadable population
  -> no cap. Log caps agree with the beats' `cap_max` to the minute.
- `occupancyTargetForHost`: peak clamp then night clamp, +/-2pp band re-clamped, `min <= max`; night window
  03:00-07:59 inclusive; `curvePctAt` interpolates, no cliff.
- `chicagoNow` (Intl, America/Chicago, `% 24` for the ICU "24" midnight) and FreeBuy's `chicagoParts` /
  `chicagoDayKey` / `chicagoWallClockToUtcMs` (two-pass offset): correct; DST safe for the hours used.
  Verified live: the caps in the log back-solve to 08:01-08:27 Chicago against a 13:01-13:27 UTC window.
- Executor: freeze gate before any I/O; kill switch never stops a yield (`killed()` not consulted;
  `planFloor` emits no occupancy order on a killed snapshot); yields first, then wind-downs; `holdUntil`
  is a not-before (LEAVE_LOCKED honoured to the millisecond +1 s, no `forced`); MAX_YIELDS 12 / 4
  wind-downs per host per cycle; `applyTableFlags` after the stands, `writeBeats` after the work,
  `checkBanks` every 15 min, alerts on change only; `unparkTables` idempotent every daytime cycle.
  Night window read once per cycle from `chicagoNow()` (seconds after the snapshot's own; harmless).
- Executor vs fleet vs rotator: the wind-down cap and the seeder's refusal are the SAME number
  (`occ.max`), so a stand is not refilled; the rotator's release is bounded by open seats (lane B 5).
  No path stands more than one horse per table per cycle.
- `StableHandPlanBus`: TTL 65 s = two cycles; `seatBoosts` empty when stale; `takeOpenOrders` takes,
  so an order is acted on once; fleet honours boosts under the host cap (`seatBoosts()` only when the
  controller is enabled).
- `StableHandState.foldMutations`: a new Chicago day zeroes minutes and sits, keeps the rolling window,
  drops windows > 24 h; untagged horses get no invented rest day (`skippedUntagged`); NOT NULL columns
  carried on every upsert (the 23502 lesson); write failures return 0 and never throw into the cycle.
  Minutes accrue per BODY every 5 min, capped at 30 (restart-safe); `previousSeatKeys` empty after boot so
  no spurious windows.
- `StableHandTags`: per-club keyset paging on horse_id (the 1,579-of-1,580 lesson); half book -> null;
  tags-without-states served; TTL 10 min / 60 s; three-valued gates (`tagAllowsCash/Variant/Stake`
  undefined = no opinion); `dailyCapReached` / `sitsOnKeyToday` read 0 on a stale date - the reset is
  structural, no midnight job.
- `StableHandSnapshot`: population cached 5 min, max age 60 min, null -> host left OUT (never n = 0);
  tables / seats / waitlists never cached; every read paged or chunked and fail-closed on incomplete;
  humans on the list counted from `created_at`; `uniqueLive` counts every body. Status filter
  `waiting/running/active`: no cash table carries any other open status (measured: closed/running/
  waiting only; the engine's 'paused' is FSM-only).
- Beats: fresh (12 s), 105/host/hour; `beatVerdict` separates never/stale/ok and is 'ok' while
  disabled; pruned by the writer every 120 beats, 7-day retention.
- ClusterController (horse side only; the 09-10 audit covers the rest): the census is the fleet's
  `lastEligibleByTable` (decays after ELIGIBLE_MAX_AGE_MS, swapped whole per cycle), sent as one map per
  pass; the wake path reads Main 1's count from `rowByGame` (built from ticked AND rested rows, pruned by
  age). In `fn_cash_cluster_tick`: `buyers = waitlist + p_eligible_horses`; OPEN fires only when every
  seat of every live/opening table is taken, no feeder is opening, under the table cap, 2 min after an
  abandon; 2 buyers -> feeder, 1 -> 60 s hold then 5 min rest; an opening feeder with nobody after 6 min
  is abandoned; `dormant` = seated 0 AND eligible 0, corrected regardless of `enabled`; a dormant empty
  game rests 30 s unless wanted or woken. With the host cap binding, a NEW body is not a buyer
  (candidate filter L2825), so feeders do not open for bodies the curve forbids - consistent, not a bug.
- ClusterMetrics: bounded `kind` label, three call sites only, health snapshot; unchanged.
- `killed()` / `controllerEnabled()`: env-inline, default on; `killAllowsAction` yield + finish_hand only.
- Personas / `MAX_TABLES_BY_PERSONA` all 4 (Dan 09-02); `SITS_PER_KEY_PER_DAY` 3-5 per GAME per day
  is ample once the key is the game; `dailyCapMinutes` midpoints 510-660; `restWeekdayFor` uniform.
- `planExoticTrim` / `planLimitGames`: cluster tables excluded (R9), so `plan.close` is empty in
  production; the < 4 tagged rule gates `mayOpen`; limit games capped separately (Dan 09-04).
- No `is_horse` filter in any edited file denies a horse anything a human gets; the snapshot's horse
  reads are identification (who may be stood for a yield, who is not a waiting human) per 10.5.

## Tests to run (server/)

`npx vitest run src/services/StableHand.test.ts src/services/StableHandController.test.ts
src/services/StableHandBeats.test.ts src/services/StableHandExecutor.test.ts src/services/StableHandPlanBus.test.ts
src/services/StableHandSeatingWiring.test.ts src/services/StableHandTags.test.ts src/services/StableHandState.test.ts
src/services/HorseSitVerdict.test.ts src/services/theFeederFillsFromTheCountItOpenedOn.test.ts
src/cluster/ClusterController.test.ts`
(the last two only after the described HorseFleetManager / HorseSitVerdict edits, whose pins they hold).
