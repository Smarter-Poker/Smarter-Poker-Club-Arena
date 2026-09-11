# Lane F - the horse fleet inside must-move games, and across Classic / Action / Madness

| #      | finding                                                        | sev | status |
| ------ | -------------------------------------------------------------- | --- | ------ |
| P0-F1  | the session rotator was dead for 3h31m, silently                | P0  | **DONE** |
| P1-F2  | a horse's seat change died with the memo, not with the stay      | P1  | **DONE** |
| P1-F3  | Madness and Action evict the fleet at hand 11                    | P1  | **DONE** |
| P2-F4  | a stale changelog note calls a live path dead                    | P2  | REPORTED, not deleted |
| P2-F5  | `DEFAULT_TABLES` is a 14-entry array with no table behind it     | P2  | REPORTED (see F6 for what was removed) |
| P3-F6  | dead round-robin and an unused union constant in the fleet       | P3  | **DONE** |

Audit of 2026-09-09. Everything below was read from production
`kuklfnapbkmacvwxktbh` (Club Arena). **The swarm brief named
`ydsaqnnuwyvtyxgvrnys`, which is `pepnationlab-prod` and holds no `cash_*`
object at all** - a query against it returns an empty result rather than an
error, which is the CLAUDE.md 10.86 shape exactly. Every figure here was
re-read against the right database; times are UTC.

---

## P0-F1 - THE SESSION ROTATOR WAS DEAD FOR 3h31m, AND NOTHING SAID SO

**Status: root cause closed by another lane at 20:55:08; the code fragility
and the silence are FIXED HERE.**

### What happened

At **17:23:50** and **17:25:29** three migrations landed that added composite
foreign keys from `table_seats` to `tables`:

| version          | name                                          | added                            |
| ---------------- | --------------------------------------------- | -------------------------------- |
| 20260909172350   | one_committed_cash_game_seat_per_player        | `live_seat_parent_cannot_close`  |
| 20260909172529   | terminal_tables_cannot_commit_live_occupancies | `active_seat_game_scope_parent`  |

`table_seats` then had **three** relationships to `tables`:

```
table_seats_table_id_fkey       FOREIGN KEY (table_id) REFERENCES tables(id)
live_seat_parent_cannot_close   FOREIGN KEY (table_id, active_parent_key)
                                  REFERENCES tables(id, seat_admission_key)
active_seat_game_scope_parent   FOREIGN KEY (table_id, active_game_scope)
                                  REFERENCES tables(id, seat_game_scope)
```

**PostgREST refuses an unqualified embed when more than one relationship
exists** - `PGRST201`, HTTP 300, "Could not embed because more than one
relationship was found for 'table_seats' and 'tables'".

`HorseSessionRotator.rotate()` opens with exactly that embed. It is the ONLY
read the rotator has, it pages the whole room, and every page returned 300:

```ts
.from('table_seats')
.select('table_id, user_id, ..., tables!inner(id, big_blind, tournament_id,
         status, settings, cluster_id, role, main_index, lifecycle, created_at)')
```

and the error handler was **a bare `return` with no log, no report, no
metric**:

```ts
if (error || !chunk) return;
```

### What that turned off

The rotator is not one feature, it is the fleet's whole departure side. Every
one of these stopped, silently, for three and a half hours:

- session-end departures (book a win, stop a loss, end of session);
- **the lone stand** - a horse alone at a dead cluster table for 10 minutes;
- **tournament leaves** - a horse giving up a cash seat for its event;
- **seat changes** - the button Dan gave every player in a must-move game;
- top-ups and short breaks;
- the retiring-table drain;
- **and the human release rule** (Dan 2026-09-02): a horse standing up because
  a real person is on the waiting list. That is the ONE thing that opens a
  seat for a human, and it was off.

### The evidence, from the felt rather than from a log

There was no log to read - that is the defect. It was found from the table
state:

| read 18:5x                                                   | value                    |
| ------------------------------------------------------------ | ------------------------ |
| `docker logs --since 3h ... \| grep -c 'SessionRotator'`      | **1** (the boot banner)  |
| cluster tables holding exactly one horse                      | 4                        |
| minutes that lone horse had been seated                       | **415, 129, 121, 54**    |
| `LONE_TABLE_MINUTES` (the rule it broke)                       | **10**                   |

The engine had booted at **17:56:01**, i.e. entirely inside the ambiguity
window, so it never had a working pass to compare against.

The same embed was failing on the tournament paths at the same time, and
those DID log - which is how the shape was confirmed:

```
[Tournament.Move_aborted_seat_claim_unreadable]  ... Could not embed because more
  than one relationship was found for 'table_seats' and 'tables'
[Tournament.late_reg_seat_claim_unreadable]      ... same
[TournamentRecurring.horse_load_seats_failed]    ... same
```

### Recovery, and proof the diagnosis is right

Migration **20260909205508 `one_relationship_between_seats_and_tables_the_
invariants_become_triggers`** (another lane, **20:55:08**) dropped both
composite keys and re-expressed the invariants as triggers. Confirmed at
**22:32:18** - `table_seats` now has exactly one FK to `tables`.

The rotator came back on the next cycle, and its first recovered pass is the
proof of what had been lost:

```
[SessionRotator] horse=4c3b0eeb leaving table=22f0279d
  - alone for 222 min with no hand dealt in 10 (lone stand)
```

**222 minutes against a 10-minute rule.** In the 100 minutes after the drop it
logged 53 lines: lone stands, tournament leaves, session departures, breaks.

### The other paths carrying the same unqualified embed

All were dead in the same window and are working again only because the
constraints were dropped. **None is in lane F**; they are listed with line
numbers so the integrator can route them:

| file                                          | lines            |
| --------------------------------------------- | ---------------- |
| `server/src/tournament/TournamentManagerEliminations.ts` | 1611, 1646 |
| `server/src/tournament/TournamentManagerBase.ts`         | 2692, 4807, 5347 |
| `server/src/tournament/seatClaim.ts`                     | 61        |
| `server/src/services/TournamentRecurringService.ts`      | 4294      |
| `src/pages/TablePage.tsx`                                | 12426     |
| `src/pages/BlacklistManagerPage.tsx`                     | 177       |
| `src/pages/AntiCheatPage.tsx`                            | 734       |
| `src/services/IntegrityActionService.ts`                 | 98        |

`src/pages/ClubHomePage.tsx:3361` was fixed on `main` at 18:10 by #3982, which
names `table_seats_table_id_fkey`. That is the correct pattern and this lane
applies it.

### The fix (lane F files only)

1. **`server/src/services/HorseSessionRotator.ts`** - the embed names its
   parent, so the number of foreign keys between the two tables can never make
   it ambiguous again:

   ```ts
   tables!table_seats_table_id_fkey!inner(...)
   ```

   Verified against production PostgREST at 22:32 with the service identity:
   both the old and new forms return HTTP 200 *now* (the constraints are
   gone), so the named form is proven equivalent, and it is the form that
   survives the constraints coming back.

2. **The silence is the real defect, and it is gone.** A failed page now
   reports and warns before declining the pass, throttled to one report per
   five minutes so a persistent failure stays readable:

   ```
   [SessionRotator] seat read failed (...) - pass declined; no session ends,
     lone stands, tournament leaves or seat changes until it reads
   ```

   This is CLAUDE.md 10.86 rule 1: "I could not tell" is its own outcome and
   never gets folded into "nothing to do".

---

## P1-F2 - A HORSE'S SEAT CHANGE DIED WITH THE MEMO, NOT WITH THE STAY

**Status: FIXED.**

`HorseSessionRotator.seatChangeAsked` remembers every `(gameId, horseId)` pair
it has asked the door about, and holds a *final* refusal
(`SEAT_CHANGE_USED`, `SEAT_CHANGE_NOT_FROM_MAIN`, ...) for
`SEAT_CHANGE_STAY_MS` = **12 hours**.

But the budget the door actually spends is **per stay**. Read from the live
function body of `fn_cash_seat_change_request`:

```sql
SELECT * INTO ro FROM public.cash_game_roster
 WHERE game_id = g.id AND user_id = v_uid AND left_at IS NULL;
IF NOT FOUND THEN INSERT INTO public.cash_game_roster (...) RETURNING * INTO ro;
IF ro.seat_change_used_at IS NOT NULL THEN RAISE 'SEAT_CHANGE_USED' ...
```

A player who leaves a game and sits in it again gets a **fresh roster row with
a null `seat_change_used_at`** - a new seat change. A human gets that. A horse
did not: its memo entry was keyed on the game alone and outlived the stay, so
for up to twelve hours it was never asked again. That is a feature denied to a
horse by construction, which is what CLAUDE.md 10.5 forbids, and it is the
same shape as the original defect this whole pass exists to fix (the door read
`auth.uid()`, so the horse had no button at all).

**Fix:** `pruneSeatChangeMemo(memo, seated, nowMs)` in `HorseBehavior.ts`
(pure, testable) - an entry survives only while it has not expired **and** the
horse still holds a seat in that game. Called once per pass from
`considerSeatChanges` with the set of `${gameId}:${horseId}` pairs seated right
now.

Production: 50 `seat_change_requested` events in 24h, 3 `seat_change_returned`.

---

## P1-F3 - MADNESS AND ACTION ARE EVICTING THE FLEET AT HAND 11

**Status: FIXED.**

This is the lane's central question ("does the fleet's VPIP behaviour per
template get it evicted en masse") and the answer is **yes**.

`cash_player_session` closures, 24 hours to 22:00:

| template | vpip_evicted | system | voluntary | **evicted share** | avg session |
| -------- | ------------ | ------ | --------- | ----------------- | ----------- |
| classic  | **0**        | 1,116  | 1,325     | **0%**            | 119.5 min   |
| action   | 206          | 414    | 152       | **27%**           | 47.7 min    |
| madness  | **586**      | 356    | 104       | **56%**           | **36.3 min**|

Where in the sitting it fires (hands on file at eviction, same window):

| template | median hands | avg hands | evicted at hands 10-12 | avg VPIP at eviction | floor |
| -------- | ------------ | --------- | ---------------------- | -------------------- | ----- |
| action   | **11**       | 17.7      | 118 of 206             | 26.4%                | 30    |
| madness  | **11**       | 21.1      | 293 of 586             | 44.4%                | 50    |

`fn_nit_check` fires the moment `hands >= maintain_hands (10)` and cumulative
VPIP is under the floor, so **hand 11 is the first possible moment** and that
is where the median sits. More than half of every Madness sitting ends there.

The widening layer is NOT dark and is NOT broken - `horse_brain_telemetry`,
2026-09-08: `vpip_floor` 408,868 fires, `satisfied` 254,359, `closing`
129,042, `prior` 25,467, `clamped` only 160. And the fleet clears its floors
**on aggregate**: action 45.9% VPIP against a floor of 30, madness 59.0%
against 50 (79,029 and 69,256 hands, 24h).

The defect is that clearing a floor on aggregate is not the test. The test is
a **cumulative 10-hand window**, and `vpipFloorMul` aims at `floor + 10
points` - so Madness horses aim at 60% and land at 59%, i.e. with **one point
of margin against a sample whose standard error at n=10 is about 15 points**.
A binomial at p=0.59 puts P(4 or fewer of 10) at ~22%, and the check re-runs
every hand after, which is how 22% becomes the observed 56%.

`tests/a-vpip-floor-must-be-reachable.law.test.ts` was written for exactly
this and its own words are the acceptance criterion being missed: *"a horse
that is booted every ten hands is not obeying the floor, it is churning the
game."*

**Consequence on the floor, and it is self-reinforcing.** An eviction writes
`barred_until` through `fn_cash_session_close` - **no seat in that game for
two hours**, horses included. Bar rows written in 24h: madness **467**, action
**198**, classic 27. Seated right now: classic 288 horses over 97 tables;
**action 3 over 21 tables; madness 10 over 21 tables**. Forty-two Action and
Madness tables are all but empty, and the mechanism emptying them is the
template's own floor.

**The floor VALUES (30 / 50) are Dan's** and are not touched here - they are a
game rule and 10.9 reserves those. What is in this lane is how hard the horse
plays to clear them, which is a code constant with a measurement behind it.

### The measurement that isolates the cause

For every horse sitting at a floored table that reached ten hands in the 24
hours to 22:00, the cumulative VPIP over its FIRST TEN hands - which is
exactly the number `fn_nit_check` judges at the first check:

| template | floor | sittings reaching 10 | mean VPIP over first 10 | **under floor at hand 10** |
| -------- | ----- | -------------------- | ----------------------- | -------------------------- |
| action   | 30    | 392                  | 47.1%                   | 25  (**6.4%**)             |
| madness  | 50    | 597                  | 59.2%                   | 104 (**17.4%**)            |

The mean clears both floors comfortably. The SAMPLE does not. A ten-hand
proportion has a standard error near 15 points, and the horse was aiming at
`floor + 10 points` - so the floor sat about two thirds of one standard error
below the target, and roughly a sixth of Madness sittings were already under
it before the eleventh hand was dealt. The check then re-runs on every hand
after, which is how a 17% first-check risk compounds into the 56% observed.

The widening layer was working the whole time and hitting its target: the
target was simply too close to the floor.

### The fix

`server/src/engine/HorseLogic.ts` - the cushion is derived from the window it
is judged over instead of being a flat ten points:

```ts
export const VPIP_JUDGED_OVER_HANDS = 10;      // tables.maintain_hands
export const VPIP_FLOOR_MARGIN_SIGMAS = 1.3;

export function vpipTargetFor(floorPct: number): number {
  const floor = Number(floorPct) / 100;
  if (!(floor > 0)) return 0;
  const se = Math.sqrt((floor * (1 - floor)) / VPIP_JUDGED_OVER_HANDS);
  return Math.min(0.95, floor + VPIP_FLOOR_MARGIN_SIGMAS * se);
}
```

| floor | target was | target now | prior multiplier | clamp (0.35) |
| ----- | ---------- | ---------- | ---------------- | ------------ |
| 30    | 0.40       | **0.488**  | 0.573            | clear        |
| 50    | 0.60       | **0.706**  | 0.397            | clear        |
| 70 (retired) | 0.80 | 0.888      | 0.315 -> clamped | pinned, as before |

1.3 sigma puts about a tenth of windows under the floor instead of a sixth,
and it is the largest margin that still leaves the layer room to steer at the
highest floor the product may set - at floor 50 the prior multiplier is 0.40,
clear of the 0.35 clamp that means "this floor cannot be reached by widening
at all". The retired 70 floor stays pinned at the clamp, so the existing law's
verdict on it is unchanged.

**Two test files were updated in the same change**, because this deliberately
replaces behaviour they pinned:

- `server/src/engine/HorseVpipFloor.test.ts` - the prior and loop
  expectations, each written as the arithmetic that produces it. One pin
  changed meaning and is called out in the file: a horse 12 points over a
  60 floor used to get its own style back, and is now still widened a little,
  because 12 points is inside one standard error - that is the exact state
  the evicted majority was in.
- `tests/a-vpip-floor-must-be-reachable.law.test.ts` - **its local
  `priorMulFor` helper restated the formula, so it would have gone on testing
  a shape the brain no longer used and passed while saying nothing true.** It
  now calls `vpipFloorMul` itself, and carries a new pin that the cushion must
  clear one standard error of the judged window, with the measurement above
  written beside it.

---

## P2-F4 - A STALE NOTE CALLS A LIVE PATH DEAD

`docs/changelog/2026-09-06-the-horse-launcher-against-the-feeder-games.md`
records, under "Recorded, not changed here":

> `claimOfferedSeats` is unreachable (`pruneHorseWaitlist` clears every horse
> row first) and, if it fired, bypasses lifecycle, stake, tag, one-seat-per-
> game and the four-game limit. Pinned by four tests; delete with them.

**Both halves are now false, and the note is dated the same day it stopped
being true.** In the same commit, `pruneHorseWaitlist` was narrowed to
`.eq('status', 'waiting')` and no longer clears `notified` rows - which is
precisely what `claimOfferedSeats` reads. And the path now checks the surplus
set, the disabled-game set, `breaking`/`closed` lifecycle, the club wallet,
the VPIP bar and the rejoin floor before seating.

A note that retires a working path is the 10.86 "expiry on a claim about the
environment" trap: the next agent reads it and deletes a live feature. Left in
place here rather than deleted, and named for the integrator.

---

## P2-F5 - `DEFAULT_TABLES` IS A 14-ENTRY ARRAY WITH NO TABLE BEHIND IT

Since Gate 7 the fleet inserts no table. `ensureAllTablesExist()` now only
walks `DEFAULT_TABLES` to log a seat-law warning, and the array still carries
`NLH Straddle 1.00/2.00`, whose own comment says the straddle lane is retired
and the name is "a fleet CONFIG KEY, not a live game". The seat-law check is
worth keeping; the array it reads is a shadow of a table writer that no longer
exists and does not match `cash_games` (150 rows, 109 enabled). P2 rather than
P3 because it is the kind of list an agent "wires back up".

---

## What was verified GOOD (asked by the lane brief, no defect found)

Every one of these was read from production at 18:00-22:32, not inferred:

| question (lane brief)                                    | answer |
| -------------------------------------------------------- | ------ |
| horses use the same seat change as humans                 | **yes** - one door, `fn_cash_seat_change_request`; the only line that differs is `fn_caller_is_engine()` naming the player. Same roster budget, same refusals |
| horses never sit on closed / breaking tables              | **yes** - 0 horse seats on `lifecycle` closed or breaking, 0 on `status='closed'` |
| a horse with two chairs in one game                       | **0** |
| a horse on a lifecycle-closed table                        | **0** |
| horses on non-cluster cash tables                          | **0** |
| the four-table limit does not count a within-game move     | **yes** - `fn_enforce_four_table_limit` returns early on `app.cash_seat_move = 'on'` |
| swaps are not reservations                                 | **yes** - the pending-move read filters `.is('swap_move_id', null)` |
| band supply falls back one band down when no game exists   | **yes** - `projectStakeBandOnto` is downward-only and fails open on an unread floor; mirrored in SQL by `fn_project_stake_band` |
| a horse only plays a stake its bankroll supports           | **yes** - `rollSupportsStake` = `available >= max(20, buyInsToSit) x 100bb`; the tagger applies the roll as a ceiling and never as a floor |
| the fleet respects the :55 freeze                           | **yes** - `isMaintenanceFrozen()` gates the seeding interval, `seedAllTables`, `seatHorse`, the rotator interval, `considerSeatChanges`, the tournament-leave loop, the Stable Hand executor and `openPlannedTables` |
| no `is_horse` special-casing that skips a player rule       | **none found** in this lane. `fn_nit_evictions` carries the *removed* horse predicate as a comment, and the fleet's `is_horse` reads are all identification (telling a horse seat from a human one so a HUMAN gets rescue priority) |
| a horse leaves a lone dead table after 10 minutes           | **the rule is correct; it was not running** - see P0-F1 |

---

## Production picture, 22:00-22:32

- 1,000 horses, 636 seated (`ca_horse_fleet_heartbeat`, cycle 7-10s, no
  degraded flag, `disabled_games_read_failed` 0).
- 139 cluster cash tables: classic 97, action 21, madness 21.
- Horse seats by template x band: classic 288 (micro 118, low 170, mid 5),
  action 3 (all low), madness 10 (micro 2, low 5, mid 3).
- 302 horse cash seats over 154 horses (1.96 tables each); 17 horses at four.
- Two hosts, and they are lopsided: DSS 69 tables / 269 seated (**at its
  Stable Hand cap, 127/127**), Midway Union 69 tables / **33 seated** of 435
  seats, cap 27/181. Reported as an observation rather than a defect - the
  binding gate is the club-membership and tag filter (68,168 pairs excluded
  for "no membership that can pay", 62,943 by the horse's own tag), not the
  cap.
- `cash_cluster_events` 24h: 22,504 `move_planned`, 21,988 `seat_moved`, 194
  `feeder_opened`, 159 `feeder_live`, 36 `feeder_abandoned` (**82% of opened
  feeders now go live** - the 2026-09-06 programme's target was "well above a
  half", against a 14/25 baseline). 15 `controller_tick_error`.
- Four-game load over the 584 Midway horses: 393 at 4, 128 at 5, 19 at 6, 1 at
  7. Loads above four exist because a chair in an event already entered is
  honoured rather than refused (`fn_enforce_four_table_limit`, 2026-09-09).
- 73 REGISTERING tournaments are **overdue by more than an hour** holding
  2,550 bookings. Outside this lane, named because those bookings sit inside
  `fn_concurrent_game_load`'s 60-minute window permanently and so hold cash
  seats off the floor for as long as the tournaments stay stuck.

---

## P3-F6 - A DEAD ROUND-ROBIN AND AN UNUSED UNION CONSTANT

**Status: FIXED.**

Both are leftovers of the table writer Gate 7 deleted on 2026-09-05, in
`HorseFleetManager.ts`:

- `getNextClubId()` plus its `clubIndex` cursor - **no caller anywhere**. It
  round-robined a club id onto a table this file was about to INSERT. The
  wallet a seat is bought from is decided by `resolveSeatClub`, which asks the
  database's own rule rather than taking turns.
- `MIDWAY_UNION_ID` - **exactly one reference in the file, its own
  declaration.** A table's union is read from the row (`t.union_id`) by
  `eligibleClubsFor`.

Removed with a comment saying what each was and why it went, so neither is
"wired back up" by the next agent. `SHARK_CLUB_ID` / `JAQK_CLUB_ID` and
`clubIds` STAY - they seed the set of clubs the bankroll loader pages, which
is live.

---

## Reconciliation after the integrator merged origin/main (171 commits)

Two server tests went red on the merged tree, both mine, both **source-text
pins on a spelling this lane deliberately changed**. Neither disagreed with
the fix on intent; both were moved to the new mechanism in the same edit
(CLAUDE.md 10.6), and both were made STRICTER, not weaker.

**First, the thing worth recording:** `origin/main` never fixed this read.
#3982 disambiguated the LOBBY (`src/pages/ClubHomePage.tsx`), and migration
`20260909205508` dropped the composite foreign keys. `origin/main`'s
`HorseSessionRotator.ts` still carries the unqualified `tables!inner(...)` at
line 272 and the bare `if (error || !chunk) return;` at line 282 - it works
only because the constraints were removed, and it is one migration away from
being dark again. This lane's fix is the only one on that path.

| test | asserted | why red | moved to |
| ---- | -------- | ------- | -------- |
| `PagedReadsCannotLieAboutBeingComplete` > "declines the pass on a failed page rather than rotating half a room" | the literal one-liner `if (error \|\| !chunk) return;` | the branch is now a block that reports before returning | the guard still exists, its branch still `return;`s, **and** it must carry `seat_read_failed` and a `console.warn` - the silence is now pinned as a defect |
| `theClubProgrammeMirrorsTheHouse` > "the rotator walks one horse out per cycle through the engine" | `tables!inner(id, big_blind, ... created_at)` | the embed names its foreign key now | the same full column list, against the **qualified** embed - strictly stronger, since the read can no longer be broken by a migration in another lane |

`PagedReadsCannotLieAboutBeingComplete` also gained a new pin - the read names
its foreign key and no unqualified `tables!inner(` may come back - because
that file's whole subject is a paged read that cannot lie about being
complete, and a read that returns nothing because PostgREST refused it is the
purest form of that lie.

### Proof the law can still fail

Two mutations, applied to `HorseSessionRotator.ts`, run, then reverted:

| mutation | red |
| -------- | --- |
| the reporting block -> `if (error \|\| !chunk) return;` (a silent decline) | **3 failed**: `aDeadReadIsNotAnEmptyRoom` "reports and warns before it declines the pass" + "throttles the report", and `PagedReads` "declines the pass on a failed page" |
| `tables!table_seats_table_id_fkey!inner(` -> `tables!inner(` (the actual 2026-09-09 outage condition) | **4 failed**: `aDeadReadIsNotAnEmptyRoom` "embeds tables through table_seats_table_id_fkey by name" + "carries NO unqualified tables embed", `PagedReads` "names its foreign key", and `theClubProgrammeMirrorsTheHouse` "the rotator walks one horse out per cycle" |

The file was restored from a byte copy taken before the first mutation and
re-verified afterwards (qualified embed present once, `seat_read_failed`
present once, zero occurrences of the bare-return form).

---

## Gate

Run on the host, in the worktree, after every change above.

Before the merge:

```
server/  npx tsc --noEmit                                   EXIT=0
server/  npx vitest run <21 files>        21 passed (21)    501 passed (501)
root/    npx vitest run <4 files>          4 passed (4)     316 passed (316)
```

After the integrator's origin/main merge and the two pin moves above:

```
server/  npx tsc --noEmit -p .                              EXIT=0
server/  npx vitest run <12 files>        12 passed (12)    259 passed (259)
```

The 12 include both previously-red files, this lane's law, and the horse
suites the changes touch.

The 21 server files: `aDeadReadIsNotAnEmptyRoom.law`, `HorseSeatChange`,
`HorseStakeBands`, `HorseFleetRetireSurplus`, `aDisabledGameIsNotSeeded`,
`HorseFleetSeatLaw`, `HorseFleetPolicyWiring`, `HorseFleetNoDuplicateTables`,
`theFeederFillsFromTheCountItOpenedOn`, `HorseBuyerAllocation`,
`HorseLoneTable`, `StableHand`, `StableHandController`, `StableHandExecutor`,
`StableHandPlanBus`, `StableHandState`, `StableHandTags`, `StableHandBeats`,
`StableHandSeatingWiring`, `HorseVpipFloor`, `TheTunerDoesNotFightTheFloor.law`.

The 4 root files: `a-vpip-floor-must-be-reachable.law`, `law-registry.law`
(which is what proves the new `docs/laws.d` entry is registered),
`unit/horsesAreTreatedIdentically`, `unit/waitlistWritePaths`.

No migration was written by this lane, so none was reserved and none needs
probing. Nothing was committed, pushed or applied.

---

## Files changed by this lane

| file | change |
| ---- | ------ |
| `server/src/services/HorseSessionRotator.ts` | P0: the embed names its foreign key; a failed page reports and warns before declining; the seat-change memo is pruned against the room |
| `server/src/services/HorseBehavior.ts` | P1-F2: `pruneSeatChangeMemo`, pure and tested |
| `server/src/engine/HorseLogic.ts` | P1-F3: `vpipTargetFor`, `VPIP_JUDGED_OVER_HANDS`, `VPIP_FLOOR_MARGIN_SIGMAS`; the cushion is derived |
| `server/src/services/HorseFleetManager.ts` | P3-F6: dead `getNextClubId` / `clubIndex` / `MIDWAY_UNION_ID` removed |
| `server/src/services/aDeadReadIsNotAnEmptyRoom.law.test.ts` | **new** - the law that would have caught the P0 |
| `docs/laws.d/a-dead-read-is-not-an-empty-room.md` | **new** - its registry entry |
| `server/src/engine/HorseVpipFloor.test.ts` | pins moved to the derived cushion, with the derivation |
| `tests/a-vpip-floor-must-be-reachable.law.test.ts` | calls the real function instead of a local copy; new sigma pin |
| `server/src/services/PagedReadsCannotLieAboutBeingComplete.test.ts` | pin moved to the reporting branch; new pin on the named foreign key |
| `server/src/services/theClubProgrammeMirrorsTheHouse.test.ts` | the same column list, pinned against the qualified embed |

**Shared files touched: none.** Every file above is lane F's. The tournament
and client paths carrying the same dead embed are listed under P0-F1 with line
numbers and were deliberately NOT edited - they belong to other lanes and are
not broken while `table_seats` has one foreign key.

---

## What I could not finish, precisely

1. **The other eight files carrying the unqualified `tables` embed** (P0-F1
   table). They are not broken right now, because the composite keys were
   dropped at 20:55:08. They are one migration away from being broken again,
   and the fix is one identifier each. Left for their lanes rather than edited
   across four programmes mid-audit; the integrator has the exact lines.

2. **Why the Action evictions are tighter than variance alone explains.** The
   evicted Action population averaged 26.4% VPIP against a floor of 30, while
   the surviving population plays 43-47%. That gap is larger than a 10-hand
   sample accounts for, so there is probably a sub-population playing
   genuinely tight - short stacks, a particular variant, or horses whose
   `ownVpip` never reaches the brain. `vpip_floor_prior` was only 6% of fires
   on 09-08, so a missing `ownVpip` is not the main driver. Isolating it needs
   a per-horse join of `ca_hand_facts` against stack depth and variant that I
   did not get to. The cushion fix helps this population too (it widens the
   prior as well as the loop), but it is not a diagnosis.

3. **The Midway Union floor is starved and I did not find the binding gate.**
   69 tables, 435 seats, **33 seated**, against DSS's 69 tables / 269 seated.
   Midway is at 27 bodies of a 181 cap, so the Stable Hand cap is NOT binding.
   The candidate filter drops 68,168 horse/table pairs for "no membership that
   can pay" and 62,943 by the horse's own tag per cycle, which is where the
   answer is, but attributing it needs a per-club breakdown of the tag book
   against the open tables that I ran out of budget for. Recorded as an
   observation, not a defect: no rule is provably violated.

4. **73 REGISTERING tournaments overdue by more than an hour**, holding 2,550
   bookings. Every one of those bookings sits permanently inside
   `fn_concurrent_game_load`'s 60-minute window and so holds a cash seat off
   the floor for as long as the tournament stays stuck. Outside this lane
   (tournament admission), named because it is a live drag on the cash floor
   this lane audits.

---

## Files read line by line

`HorseFleetManager.ts` (4,216), `HorseBuyerAllocation.ts` (177),
`HorseLifecycleManager.ts` (674), `HorseLoneTable.ts` (153),
`HorseSessionRotator.ts` (1,333), `HorseBehavior.ts` (678),
`StableHand.ts` (1,653, the ladder / bankroll / tag sections),
`StableHandController.ts`, `StableHandExecutor.ts`, `StableHandPlanBus.ts`,
`StableHandTags.ts`, `scripts/horsesTag.ts` (342),
`HorseLogic.ts` (`vpipFloorMul`, the tightness chain, `HorseGameStateV2`),
`HorsePreflop.ts` (the `t()` / `tCall()` bars), `HorseGameLoad.ts`,
`HorseRejoinConstraints.ts`, `ServerTableEngineBase.evictExpiredSitOuts` +
`vpipFloor()`, `ServerTableEngineTurns.ts` (the brain's game state).

Tests read: `HorseStakeBands`, `HorseSeatChange`, `HorseFleetRetireSurplus`,
`aDisabledGameIsNotSeeded`, `HorseVpipFloor`, `a-vpip-floor-must-be-reachable`,
`aBarredHorseIsNotABuyer`, `horsesAreTreatedIdentically`, `waitlistWritePaths`.

Live SQL bodies read (never the migration file): `fn_cash_seat_change_request`,
`fn_nit_check`, `fn_nit_evictions`, `fn_cash_vpip_status`,
`fn_cash_session_close`, `fn_cash_rejoin_floor`, `fn_concurrent_game_load`,
`fn_enforce_four_table_limit`.
