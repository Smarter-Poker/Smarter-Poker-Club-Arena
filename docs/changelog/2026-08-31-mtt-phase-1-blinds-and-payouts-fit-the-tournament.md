# 2026-08-31 — MTT Phase 1: the blinds and the payouts now fit the tournament

Phase 1 of 7 from `.agent/audits/2026-08-31-mtt-deep-dive-what-is-left.md`.
Tier 1 of that audit — the highest-value item on it.

## What was wrong

Measured across 579 completed MTTs in the seven days to 2026-08-31:

| | |
| --- | --- |
| avg levels DEFINED in a blind structure | 8.1 |
| avg level actually REACHED | 14.0 |
| deepest level reached | 124 |
| **events that ran past their own structure** | **554 / 579 — 95.7%** |
| ended with peak BB at the DECIMAL(10,2) ceiling (10,000,000) | 41 — 7.1% |
| ended with peak BB > every chip ever issued in the event | 72 — 12.4% |
| **ended with all chips in play worth under 3 big blinds** | **221 — 38.1%** |
| ended in a healthy > 20 BB state | 18 — 3.1% |

Every structure was 5–12 levels, and `blindEscalation` invented the rest by
**doubling once per level**. Seven of the eight largest fields (486–500
entrants, 12k–30k stacks) ended with the big blind at 10,000,000 — larger than
the sum of every chip in the tournament.

Payout depth was flat because the preset maps top out at `NINE`: a 334-runner
field paid 8.9 places, 2.7% of the field, against an industry norm of 10–15%.

## What changed

**1. `tournament/blindLadder.ts` (new, zero imports).** Ladders are generated
from a chip-friendly mantissa cycle rather than hand-written: `SLOW` 10
steps/decade (~1.26x), `STANDARD` 8 (~1.33x), `TURBO` 5 (~1.58x),
`HYPER_TURBO` 4 (~1.78x). Every emitted value is a real chip denomination and
the ladder is defined to any depth. `observedStepRatio` reads a structure's own
late-game cadence, clamped to [1.15, 1.6].

**2. Both preset maps now generate deep ladders.** `TournamentRecurringService`
(the hardcoded grid that actually runs most events) and
`ScheduledTournamentService`: STANDARD/SLOW 40 levels, TURBO 24,
HYPER_TURBO 16, SNG 20. **Level 1 of every preset is unchanged**, so advertised
structures and starting-stack-in-BB figures still read exactly as before.
Spin and Heads-Up keep their literals deliberately — Spin has its own
`spinBlindsForLevel` generator and Heads-Up is short by design.

**3. Overflow no longer doubles.** `escalationFactor` takes the ladder's ratio,
defaulting to 1.4 instead of 2. The anchoring contract — a pure function of
(index, persistedLength), identical before and after a restart — is unchanged
and still pinned.

**4. A big blind may never exceed the chips that exist.**
`capLevelToChipsInPlay` scales a level down so the event always holds at least
`MIN_TOTAL_BB_IN_PLAY` (20) big blinds, preserving the sb/bb/ante ratios.
Wired at `TournamentManagerBase.getBlindLevelAt`, fed by
`refreshChipCapInputs` in the elimination sweep (throttled to 60s). The entrant
count is a **high-water mark**, never `current_players` — that column drains as
players bust (it read 2 on a 115-entrant event at the finish) and a draining
supply would tighten the cap as the event progressed. An unknown total caps
nothing.

**5. Payout depth scales with the field.** `payoutStructureForField` pays ~15%
of the field (min 3, max 100, never more than half). Two regimes, because real
structures have two: a steep geometric top nine and a flat min-cash tail. It is
called **once**, at prize-pool finalisation, immediately before
`recalculateEliminatedPrizes` — the one moment entry is closed and the existing
reprice already re-values everyone who busted earlier. Ordering is
load-bearing: widen, then reprice.

Generated shapes: field 60 → 9 places, 1st 29.5% (the old `NINE` preset was
30%); field 334 → 50 places, 1st 21.1%, last 0.34%; field 500 → 75 places,
1st 15.9%, last 0.28%. Every structure sums to exactly 100.00.

## Two defects the tests caught in my own work

- Geometric decay **cannot** span 75 places: place 28 of a 500-runner field
  rounded to 0.00% — a paid place that pays nothing. Hence the two-regime
  model.
- The first draft generated a **25,000,000 big blind at TURBO level 30**, over
  `MAX_BLIND_VALUE`, because only STANDARD was checked. The law test now
  asserts the ceiling against **the presets that actually ship**, both maps.

## Tests

`blindsAndPayoutsFitTheTournament.law.test.ts` — 26 pins, each one a measured
production defect. `blindEscalation.test.ts` updated in this same commit: its
five doubling assertions now pin the new ratio, with the anchoring and
statelessness invariants preserved and the old behaviour named explicitly so it
cannot return quietly.

Full server suite: **266 files, 3,029 tests, all passing. `tsc --noEmit`
clean.**
