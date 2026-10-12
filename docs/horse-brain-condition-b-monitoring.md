# Horse Brain Condition (B) Monitoring

Horse Brain only. Under the winning contract as amended by the owner on October 9, 2026 ([amendment](horse-brain-winning-contract-2026-10-08.md#amendment-of-october-9-2026-owner-decision)), a strategy pack is selected on condition (a) alone. Condition (b), winning after rake against humans, is a post-launch check that can only **withdraw** a selected pack. This page is the procedure. Nothing here runs on a schedule; the owner (or an agent he assigns) triggers it.

## When To Run It

Run `status` whenever production human volume has grown. It reports, for every selected pack, whether the committed human calibration is adequate for the pack's family (at least 10,000 human seat-hands in the family, at least 20 human accounts, no account above 25% of human seat-hands):

```bash
cd server && npx tsx src/scripts/conditionBMonitor.ts status
```

Exit 0 means every selected pack's family is adequate. Exit 3 means at least one is not, and its line reads `unavailable_external_input` with the failing minimums. On October 9, 2026 every family fails all three (5 accounts, the most active one 68.5% of human seat-hands).

## When The Calibration Is Inadequate

Nothing can be decided. A human-calibrated measurement on an inadequate calibration is a development measurement: it can neither select nor withdraw a pack.

## When Production Has An Adequate Human Population

1. Refit the population from production human play (`server/src/scripts/humanCalibratedFit.ts`, on its fitting seeds), give it a new id, and commit it with its record and fresh held-out human seeds before any run (the addendum's Condition (b), Specified, unchanged).
2. For every selected pack, run its phase's human-calibrated check on those held-out seeds: `server/src/scripts/omahaHumanCalibratedCheck.ts` (PLO4, PLO5, PLO6, PLO8) or `server/src/scripts/phase12HumanCalibratedCheck.ts` (Short Deck, Pineapple, FLH, FLO8), `run` per profile and seed, then `assemble`. League seats played by the human-calibrated population are seated as humans (`is_horse: false`), and every league result carries their response counts per decision node (`humanCalibrated`), which can be compared with the fit's targets.
3. Read the verdicts:

```bash
cd server && npx tsx src/scripts/conditionBMonitor.ts verdict --summary=<assembled summary> [--summary=...]
```

Each line is `keep` (the after-rake two-sided 99% lower bound is not below zero), `withdraw` (it is below zero, on an adequate calibration and a complete run), or `no_decision` (inadequate calibration or incomplete run). For `withdraw` it prints the `withdrawn` value to commit.

4. A withdrawal is a reviewed change that sets the pack's selection `withdrawn` to that value (reason `condition_b_lost_after_rake`). The pack returns to shadow at the next engine release, and that approval generation never returns. The admission code and its tests already treat a committed `withdrawn` as a withdrawal (`HorsePhase10Authority.test.ts`, `HorsePhase11Authority.test.ts`).

## Tournament Packs

`runTournamentLeague({ ..., opponentPopulation: HUMAN_CALIBRATED_POPULATION_ID })` now seats a human-calibrated NLH field in the Phase 8 tournament league and reports the field's response counts (`humanResponses`). No human-calibrated tournament contract is committed yet, so `status` reports a tournament pack as unavailable external input. No tournament pack is selected.
