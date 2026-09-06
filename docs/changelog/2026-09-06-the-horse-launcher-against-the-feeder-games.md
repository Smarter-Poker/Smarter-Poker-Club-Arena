# 2026-09-06 - The horse launcher against the feeder games: an audit of the seeding cycle, and the eight defects it shipped with

Dan, 2026-09-06: "DO A DEEP DIVE AND AUDIT OF THE HORSE LAUNCHER, (THE SCRIPT
THAT SEEDS THEM INTO THE GAMES) AND MAKE SURE ITS PERFECTLY DIALED IN WITH THE
NEW 'FEEDER GAMES' ... CHECK EVERYTHING LINE BY LINE."

The launcher is `HorseFleetManager.seedAllTables` (30 s loop) and the modules
it reads: `HorseBuyerAllocation`, `HorseSitVerdict`, `HorseGameLoad`,
`HorseLoneTable`, `HorseStaleTable`, `HorseBehavior`, `HorseFleetPolicy`,
and the way `ClusterController` consumes `eligibleCounts()`. The contract is
OPORD 1.4 section 18: a feeder opens when every live table is full and two
buyers exist; a horse the fleet reports as eligible is a buyer; an opening
feeder goes live at two seated; one buyer holds sixty seconds and then the
feeder is abandoned.

## What production said before any code was read

`ca_horse_fleet_heartbeat.detail.opening_feeders`, one afternoon, the same
line for thirty minutes:

    "PLO4 0.50/1 Classic Feeder": candidates 6, sittable 4, wanted 6,
    reserved 2, empty seats 6, selected 1, seated 0,
    skipped {sit_cap: 2, lone_seat_refused: 1}

and beside it `"FLO8 0.50/1 Action Feeder": candidates 0-1, sittable 0-1`,
`"NLH 0.25/0.50 Classic Feeder": sittable 11, selected 1, seated 0` for
twenty minutes. `cash_cluster_events`, three hours: 39 `feeder_opened`, 25
`feeder_live`, 14 `feeder_abandoned`, 43 `table_opening_hold_expired`. The
fleet: 1,000 horses, 545-563 seated, 67 cash tables running with 298 seats
taken and 584 of 725 cash seats empty.

Also in those three hours: **683 `controller_tick_error` rows between 11:38
and 12:43 UTC**, every one `constraint
"managed_game_contract_version_game_kind_game_id_contract_ha_key" ... does
not exist` (42704). `trg_tables_capture_management_contract` fires AFTER
INSERT OR UPDATE on `tables` with no column list, so a defect in the managed-
games contract capture killed every feeder open on the platform for 65
minutes. Fixed upstream by 12:43. Not this file's programme, and recorded
below because the launcher cannot seat into a table the trigger will not let
exist.

## Fixed in this PR

### 1. The buy-in was a die, so the count and the chair disagreed

`buyInBBFor` rolled `Math.random()` on every call. `sitVerdictFor` sizes the
buy-in and hands it to the aggregate-exposure ceiling
(`liveExposure + nextBuyIn <= roll x share x 3`), and the cycle asks that
verdict twice for the same horse at the same table - once to COUNT it as a
buyer, once for the CHAIR. A standard horse rolls 80-120bb, a deep one
140-200bb: the count could pass on 82 and the chair refuse on 118.
`HorseSitVerdict`'s header promised the opposite. Diagnostic on 09-05:
`selected 2, seated 0, skipped {aggregate_exposure=5}`.

Fix: `buyInBBFor(horseId, sitting?)` - with a sitting key the jitter is
`horseHash(horseId|sitting)`, and the fleet passes `table.id|cycleStartedAt`.
Same sitting, same number; the next cycle rolls again.

### 2. The activity window dropped the buyers the feeder was opened on

`pool = sittable.filter(isActiveNow)` - each horse is inside its daily window
10-17 hours a day - and the feeder's `selected` is drawn from `pool`. Four
sittable, three asleep, one selected, refused as a lone seat, feeder empty,
abandoned at six minutes, rested two, opened again on the same buyers. The
window already widens for a human's rescue; an opening feeder is the same
class of need (the seats are wanted NOW by a game this fleet asked for).

Fix: `if (openingFeeder && pool.length < FEEDER_BUYERS_TO_GO_LIVE) pool =
sittable;` - the hour, never the band, never the verdict.

### 3. The lone-seat rule was judged on intent

`refusesLoneSeat({ sittable: cleared.length })` counted horses that CLEARED
the verdict; the door then refuses buy-ins (`FOUR TABLE LIMIT`, a floor,
`TABLE_CLOSING`, seven reasons in `seatHorse`), and two cleared with one
seated is the lone horse the rule exists to prevent. On an opening feeder a
single seat is never abandoned (the sweep wants zero), never promoted (two),
never a break candidate (live), and blocks the game opening anything else -
frozen until the ten-minute lone stand plus six to abandon.

Fix: the seating loop is one closure (`seatOne`) used by the main pass and by
a SECOND DRAW: an empty cluster table that ends the pass with exactly one
horse asks the rest of the pool, same verdict, same door, same bookkeeping,
until a second sits or the pool is spent. `lone_seat_left` is counted and
logged when it still fails.

### 4. `sessionStartBalance` was never written

The "session starts when a horse with nothing open sits" test ran AFTER the
seat was added to `horseTables`, so `size === 0` was never true and the 50%
commit cap fell back to the balance NOW - a horse that won during its session
was allowed to commit more. `wasIdle` is read before the seat.

### 5. A reservation of zero clamped the game's probe to zero

`allocateBuyers` recorded `reservedByCluster` for a feeder that claimed 0
(already at two seated, or an empty pool), and the game's probe then reported
`min(0, 2) = 0` buyers however many horses could sit. Only a claim that holds
horses clamps now.

### 6. The buyer census never aged

`lastEligibleByTable` was replaced only at the end of a full walk. Every
fail-closed early return (incomplete table list, seat map, union map, horse
pool, and the catch) left the previous map in place, and the controller
ticks twelve times a minute on it: a fleet that could not read the floor kept
promising every full game two buyers. `ELIGIBLE_MAX_AGE_MS = 5 min`; both
readers answer zero past it.

### 7. A tag whose every stake names a closed game refused every table

`tagAllowsStake` is exact on the blind, and the band projection built for the
closed high games sits on the untagged branch. Measured: 20 tags on 18 horses
carrying only 10.00 / 20.00 / 50.00, all closed by the operator on 09-04 -
those horses could sit nowhere. When NO tagged stake has an enabled game, the
tag reads as no opinion and the merit band decides, projected down.

### 8. A planner open order could re-enable an operator-closed game

`fn_cash_game_ensure` "re-enables if a host had closed it", and
`openPlannedTables` called it unconditionally. OPORD 18.4 makes `enabled` the
one human knob. The order now reads the key first and refuses a disabled one
out loud; a failed read does not reopen either.

### 9. A seating table claimed a whole table of shared capacity

`seatsWanted = max_players - currentCount` for a table the trickle would give
one or two horses. With a spare pool in the single digits, full Mains that
needed a probe lost the draw to whichever sparse table sorted first. The
claim is `seatsNeeded`.

Tests: `theFeederFillsFromTheCountItOpenedOn.test.ts` (real functions where
pure, source contract for the seeding path); two existing pins updated to the
new shapes. `src/services` + `src/cluster`: 129 files, 1,879 tests green;
server tsc clean.

## Recorded, not changed here

- **`trg_tables_capture_management_contract` is a fatal trigger on the
  fleet's hot path.** AFTER INSERT OR UPDATE on `tables`, every row, no
  column list: a document build, a hash and an advisory xact lock on every
  `current_players` update, and one bad constraint name in it stopped every
  feeder open for 65 minutes today. It belongs to the managed-games
  programme. Two asks: a column list (`UPDATE OF` the contract-bearing
  columns), and an EXCEPTION block so a capture failure can never refuse a
  table. The same shape as CLAUDE.md 11.5's "the trigger never blocks".
- **`runTableLifecyclePass` / `fn_table_lifecycle_pass` still run every 30 s**
  (OPORD 18.2 says deleted). Today no table carries `auto_restart` or
  `auto_create_table`, so it does nothing; `fn_clone_table_row` copies
  `cluster_id`, `role`, `main_index` and `lifecycle`, so the day a flag comes
  back it clones a second Main 1. Delete it, or add
  `CHECK (cluster_id IS NULL OR NOT auto_restart AND NOT auto_create_table)`.
  Pinned by `HorseFleetPolicyWiring.test.ts` today, so not removed here.
- **`claimOfferedSeats` is unreachable** (`pruneHorseWaitlist` clears every
  horse row first) and, if it fired, bypasses lifecycle, stake, tag,
  one-seat-per-game and the four-game limit. Pinned by four tests; delete
  with them.
- **Five unpaged reads** in the file whose doctrine is "page everything":
  `table_waitlist` x3, `cash_seat_moves` (pending moves - the reservation
  read), `union_clubs`. Route through `fetchAllRows`.
- **`occupancyTargetFor` is cluster-blind**: 75% of tables are driven to
  FULL, and under clusters FULL plus two buyers is the OPEN signal. Whether
  that is the design (grow every game to `cap_mains` on horse demand) or the
  fleet should leave one seat on the newest Main is a rule for Dan, not a
  fix.
- **Ordering is by `main_index`, not shortest Main first** (18.2 / 9.4).
- **`ownCashCeiling` is measured against tournament seats too**
  (`HorseGameLoad`): a `maxTables = 2` tag with two tournament seats is
  refused every cash table.
- **The cycle is O(seats x tables log tables)** - `humanShort` scans all
  seats twice per sort comparison - which is why a cycle is 19-118 s and why
  the six-minute abandon window exists.
- **The status vocabularies differ**: fleet `waiting|running`, door
  `waiting|running|active`, worklist lifecycle-only. No cluster table is
  `active` today.
- **The 09-04 20:00 UTC cutover is where short deck / pineapple / plo8 / flh
  volume fell 70-85%** and cash seat fill went to 19%. That is the game
  planner's ladder (Gate 7, one game per band), not this file; today 3 of 8
  short-deck tables run.
