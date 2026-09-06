# Spins, round 19: the three "open" items were mine, and they are closed

2026-09-05, following round 18. Dan, on the three things I had listed as open:
"NONE OF THESE ARE MINE, THESE ARE YOURS TO FIX."

He was right about all three, and the first one turned out to be the largest
defect of the day.

---

## 1. The 2026-09-01 write failure: a guarded UPDATE that matched nothing

I had filed this as "cosmetic, harmless, a watch item". It was neither
cosmetic nor spin-specific, and it is still live until this ships.

**Measured:** 53 tournaments across FOUR variants (30 sng, 21 spin, 1
satellite, 1 freezeout) that dealt hands and ended, every one carrying
`started_at` NULL - and **not one `running_flip_failed` report between them.**
47 of the 53 landed on 2026-09-01 alone, but the trickle runs across every day
before it, on every format.

**The mechanism.** `TournamentManagerBase.start()` flips the row to RUNNING
with:

```
.update({ status: 'RUNNING', started_at: startedAtIso })
.eq('status', 'REGISTERING')                 // the guard
...
.select('status')                            // the confirmation
if (!flipErr && confirmed !== 'REGISTERING') runningFlipped = true;
```

`start()` has **no status gate at its top** - it reads the row and proceeds -
so it genuinely runs against rows that are already RUNNING: a second engine
winning the race, a recovery driver, a restart re-entering. When that happens
PostgREST updates **zero rows and returns no error**, and the confirmation only
ever asked about `status`. An already-RUNNING row answers "not REGISTERING",
the flip is declared a success, and nobody ever writes the start.

Silent, and permanent.

**Why a null start is not cosmetic.** `late_reg_mins` is arithmetic ON that
column - `started_at + mins`, in the footer countdown and in
`make_interval(mins => late_reg_mins)` server side. Every duration ever
reported comes from it. And the repair sweeps bound themselves on it, where
`NULL > now() - interval` is NULL, which is not true: **the row is invisible to
the very jobs written to rescue it.** That is the whole reason four spins sat
un-stamped for four days while a quarter-hour cron ran over them.

**The fix.** The confirmation asks the question it always meant to ask - is
there a start on this row. A live row with no start gets one, guarded
`.is('started_at', null)` so it can never overwrite a real one, and the lost
race is reported instead of swallowed. A **finished** row is never given an
invented start: that is 10.9's rule about settled records, so those are
reported and left alone.

Guarded by `server/src/tournament/aStartedTournamentHasAStart.guard.test.ts`.

---

## 2. The ladder charged 7.874% while booking 8.00%

`SPIN_RAKE_RATE` is 0.08, `fn_spin_settle_game` deducts 8%, every report says
8%. The ladder expected **2.763772x** against the 2.76x that three seats at 8%
imply, so the house actually took 7.874%. The 0.126pp went out to players in
prizes and came out of the club reserve, which is why `spin_bonus_pools` kept
drifting away from its seed.

**Two guards measured it and both rounded it away.**
`assertSpinRakeInvariant` compares `round2(expected)` with `round2(implied)`,
and 2.7638 and 2.7600 both round to 2.76. The 2026-08-31 seed migration
accepted any edge within **0.005** of 0.08 - half a percentage point, four
times the drift. A guard that rounds away the quantity it exists to measure is
not a guard. Both are exact now (1e-9 in TS for double noise; `numeric` exact
equality in SQL).

**Solved as an equality, not fitted.** Hold every tier from 4x up at its exact
frequency and there is exactly one integer solution:

```
f2 + f3      =  8,740,492      (10,000,000 less the fixed 1,259,508)
2*f2 + 3*f3  = 21,411,700      (27,600,000 less the fixed 6,188,300)
=>  f2 = 4,809,776,  f3 = 3,930,716
E[m] = 27,600,000 / 10,000,000 = 2.76      edge = 8.000000%
```

**What a player sees:** 2x moves 47.7203% -> 48.0978% and 3x 39.6848% ->
39.3072%. That is it. Every tier anybody celebrates - 4x, 5x, 10x, 25x, 50x,
100x - keeps its frequency to the unit, and since the denominator is now
exactly 10,000,000 their probabilities read cleaner than before (9.000000%
rather than 8.999911%). Expected return 92.126% -> 92.000%. The 500x
retirement's arithmetic is untouched; 100x still holds all 1,008 units.

Live: `spin_tier_spec` reads total 10,000,000, units 27,600,000, E[m]
2.7600000000, edge 8.00000000%.

### A drift trap fixed on the way past

`spinSpecMatchesDatabase.test.ts` hard-coded ONE migration filename. Reseeding
the ladder from a newer file left it parsing the old one and reporting that
`spinSpec.ts` had "drifted" from a table that no longer existed - red for the
wrong reason, pointing at the wrong file. Its own header says "if the ladder
moved somewhere else, move this test with it". It now follows the newest
migration that seeds the ladder, and a second resolver follows the newest that
defines `fn_spin_fairness_check`, because those are two different questions.

---

## 3. Spin escrow: enforced, but only after making it safe to enforce

The soak, across every spin escrow row that exists: **3,913 completed, 274
cancelled, 83 running, 27 registering, 1 completing - zero would-refuse in any
of them**, worst bank 0.00, cancelled spins refunding exactly the 13,280.00
they took, zero R1/R5 breaches.

**But "it would have refused nothing" is not "it is safe to enforce."** One
path legitimately pays more than the escrow holds, and it is deliberate: when
the club reserve is too thin for the drawn prize, `fn_spin_settle_game` draws
what is there, writes a SHORTFALL row, and the players are paid in full anyway

- the code says so in as many words. Turning enforcement on without touching
  that converts an operator top-up into a **refused prize**. A stranded player is
  exactly what 10.9 exists to prevent, and it would have been caused by a guard I
  switched on.

The shortfall has **never fired** - zero SHORTFALL rows, ever - which is why it
is safe to fix now and was unsafe to enforce without fixing.

The escrow could not see it: the shortfall is prose on a row whose amount is
0.00, no chip moves at settle, so no ledger leg fires. That is an R8
completeness gap on its own terms.

**All three changes are additive.** `fn_spin_settle_game` and
`fn_ca_escrow_apply` belong to Phase 5.2 and are left exactly as they are -
replacing either risks clobbering in-flight work, and a bad transcription of a
settle function is worse than the bug it fixes.

- **A.** A shortfall books itself into the escrow as `overlay_in`, derived
  (`multiplier * buy_in - drawn`) and never parsed out of the note.
- **B.** New spin escrow rows are born enforced - unless the row opens with a
  bank already negative, in which case it stays tracked. `fn_ca_escrow_apply`
  can open an escrow "at first sight" from the shadow of an event already in
  flight, and an event broken before the escrow saw it must not have its next
  payment refused by a guard switched on afterwards.
- **C.** The 4,319 existing rows flipped, asserted first, only where the banks
  are sound.

Live: 4,319 of 4,319 spin escrow rows enforced, zero negative banks.

**Reverting is one statement** plus two `DROP TRIGGER`s. Nothing here is
one-way.

---

## Files

- `server/src/tournament/TournamentManagerBase.ts` - the flip confirms a start
- `server/src/tournament/aStartedTournamentHasAStart.guard.test.ts` - four pins
- `server/src/config/spinSpec.ts` + `src/config/spinSpec.ts` - the rebalance and
  the exact invariant (byte-identical copies)
- `tests/config/spinSpec.test.ts` - pins moved with the behaviour they guard
- `tests/config/spinSpecMatchesDatabase.test.ts` - follows the newest migration
- `supabase/migrations/20260905165154_*` - neither sweep is blind to a null start
- `supabase/migrations/20260905171024_*` - the ladder charges the 8% it books
- `supabase/migrations/20260905171518_*` - a spin pays only what it holds

---

## 4. The final sweep found nine defects in this session's OWN work

Dan: "ONLY AFTER YOUR DONE WITH EVERYTHING I WANT YOU TO RUN A FINAL SWEEP...
CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES
ANYWHERE AND EVERYWHERE."

Two independent audits over the whole branch. Everything below is a defect
introduced or woken by today's work, and every one is fixed.

### 4.1 The CSS cap undid the fix it was written for, on Spins specifically

**The worst one.** The short-canvas rule shipped as five selectors of the form
`.table-page[data-seats='3'] .seat-wrapper--top .seat`, with a comment
asserting they were 0-3-0. A class AND an attribute on one compound is
**0-4-0**, so the rule beat both of the rules it was written to lose to:

```
.table-page--tournament .seat-wrapper--top .seat   0-3-0   tournaments uncapped
.seat-wrapper--top .seat.seat--empty               0-3-0   SIT plates uncapped
```

TablePage puts `table-page--tournament` and `data-seats` on the **same
element**, and a Spin is a tournament with three seats. So the 56px cap applied
to **every Spin** - the exact opposite of Dan's item 7, shipped under its
name - and shrank empty SIT plates against his 2026-08-31 ruling.

The ring list moved inside `:where()`, which contributes zero specificity: the
selector is now genuinely 0-3-0, still beats the 0-2-0 base rule, and ties the
two exemptions, which win on source order because they are written after it.

**Neither existing test could have caught it.** The text pin asserts text and
source order; the e2e spec renders neither `table-page--tournament` nor
`seat--empty`. A cascade is arithmetic, so `tests/unit/topRailCapCascade.test.ts`
now does the arithmetic - it computes specificity, and the first assertion is
that the cap rule is 0-3-0 and not 0-4-0.

### 4.2 A 46-click crack, unmasked by the sound fix

`playSpinTicking` tested `stepOffsetsMs && stepOffsetsMs.length > 0`, so an
empty **array** fell through to a 46-click fallback. SpinWheel hands over the
caught-up schedule, and a client arriving after the chase has ended passes `[]`
with a duration of 0: every fallback offset computed `0 * anything = 0` and all
46 clicks fired on the same millisecond, at velocities ramping to 1.0. One loud
crack instead of a chase.

It was unreachable until today only because the cue was rank `ui` and always
lost the frame to `playSpinStart`. Taking the cues off that gate unmasked it -
the honest cost of that change. `undefined` now means "improvise a schedule",
`[]` means "nothing left to strike", and the two are no longer one sentence.

### 4.3 321 test fixtures committed as migrations

`git add -A` swept in 316 `*_squatter_holding_this_second.sql` files (each
containing the single line `-- squatter`, written by the migration-reservation
law test) and five empty `*_the_first_agent_reserves_a_name.sql` stubs, two of
them with malformed 16-digit versions. They would have been applied to
production as 321 no-op migrations. Removed.

### 4.4 The same bug class, rewritten in SQL hours after fixing it in TypeScript

`fn_spin_repair_missing_multiplier` did
`UPDATE ... WHERE id = x AND COALESCE(spin_multiplier,0) <= 0` and then
incremented its counter unconditionally - so a row stamped by another pass
between the SELECT and the UPDATE was counted as repaired **and** given a
`financial_alerts` row describing work that never happened. Reachable by
design: two pg_cron jobs drive this function under **different** advisory
locks. `GET DIAGNOSTICS ROW_COUNT` now decides, and a miss reports as
`lost_the_race`. Pinned.

That is "a guarded update that matched nothing is not an error" - section 1 of
this changelog - written again, in another language, the same afternoon.

### 4.5 A dormant horse filter that today's backfill woke up

`AnalyticsDashboard.tsx` counted live players with `.is('horse_id', null)`.
That column was NULL on every row until the 2026-09-05 backfill stamped 1,285
live horse seats - at which point the untouched line would have started
silently dropping every one of them from an operator's "live players now".
CLAUDE.md 10.5: horses "COUNT everywhere a human counts" and are "NEVER
silently filtered out of a report, a total, or a ledger". Filter removed.

### 4.6 A stale scope could paint spin rows over a cash sheet

`closeQuickJoin` left `spinSheetScope` populated and the loader only cleared it
after several round trips, so the next press re-opened the sheet with the
previous table's scope live. A realtime event landing in that window wrote spin
rows - and `loading: false` - over a sheet that was still loading. Cleared on
close, and synchronously on open before the first await. (Moving that state
above `closeQuickJoin` was itself required by
`tests/no-tdz-in-table-route.law.test.ts`, which caught the use-before-declare.)

Also: the `tables` listener was `event: 'UPDATE'` only. The recycler opens a
replacement board by INSERTing the tournament row and then the table row, so on
UPDATE-only the refresh woke before the table existed, dropped the board for
having no table, and never re-triggered. `event: '*'` now.

### 4.7 A guard that watched two numbers that no longer exist

`spinOddsOnBuyInSheet.test.ts` asserted the page does not contain `4_772_073`
or `3_968_518`. The rebalance retired both, so the guard went on proving that
two absent numbers are absent - green, and blind to the frequencies that
actually ship. It reads the ladder now. Scoped to the two seven-figure rungs,
because the rest are round (`1_000`, `100000`) and collide with ordinary
timeouts and z-indexes; a guard that fails on a z-index is a guard the next
agent deletes.

### 4.8 A field that always read zero

`fn_spin_sweep_unbooked` returned `skipped_no_entrants`, declared and never
incremented - the entrant test lives in the WHERE clause. Removed rather than
wired: an absent field is honest, a constant one is a placeholder an operator
can mistake for a measurement.

### 4.9 Comments that would have taught the next agent to revert the rebalance

`spinSpec.ts` still argued 2.7638 / 7.87% / "the tiers below actually sum to
10,000,099" in five places - including the docblock of `SPIN_FREQ_DENOMINATOR`
itself, which now states the opposite of the value it documents. `SpinMetrics.ts`
carried it into an **operator-facing runtime log string**. This is the shape
CLAUDE.md 10.7 exists to describe: a rule written down in the repo, so the next
agent reads the repo and re-enforces it. All corrected, and dated, so the
history still reads.

### What the sweep checked and found clean

No TODO/FIXME/`@ts-ignore`/`.skip`/`.only` in any added line. No SQL
referencing a column or function that does not exist (verified against the live
catalogue, including that `fn_ca_escrow_apply`'s seventh positional argument is
`p_overlay_in`). The shortfall trigger's ordering is correct - the
`jackpot_draw` row is inserted before the SHORTFALL row in the same
transaction, and the whole settle runs at tournament start, long before any
`prize_out`. Effect cleanup tears down the channel and the debounce. Both
`spinSpec.ts` copies byte-identical. The fairness guard cannot false-alarm
across the ladder transition (z = 0.41 at n = 31,153 against a trip at 4).

**Verified after every fix: 13,976 client tests and 5,743 server tests, zero
failures; tsc clean on both sides.**

### One thing the sweep flagged that I did NOT change

The audit questioned whether the rake rebalance is Dan's under 10.9 ("prices,
rake ... in FUTURE events"). It is his, and he assigned it explicitly on
2026-09-05: "NONE OF THESE ARE MINE, THESE ARE YOURS TO FIX." That ruling is
recorded in the migration header and here; it is not in CLAUDE.md, so anyone
re-opening the question should read this paragraph rather than assume the
default.
