# A league matchup that measures nothing says so

2026-09-21. Audit item "P1: League harness defects". The 2026-09-20 horse
audit (`horse_daily_audit.agent_analysis`) found `v16_deep_reads` at "0.00
bb/100 with 0.00 stderr over 12,000 hands on every run from 2026-09-13 to
2026-09-21" (its machine audit flags it `league_matchup_inert`), named "three
more that stopped running entirely after measuring nothing:
v16_ratio_rescale, v18_exploit_size, v31_gto_suit_aware", and for
`v16_ratio_rescale` asked to "Restore the matchup to the nightly league first,
then re-evaluate after 3 clean runs". The audit item asks for all three back on
the card.

## What was true

`horse_league_results`, `v16_deep_reads`, every row since 2026-09-08:

| run_date                            | bb/100 | stderr | hands       |
| ----------------------------------- | ------ | ------ | ----------- |
| 2026-09-13 to 2026-09-21 (9 nights) | 0.00   | 0.00   | 12,000 each |
| 2026-09-12                          | +0.16  | 0.32   | 12,000      |
| 2026-09-11                          | -0.04  | 0.03   | 12,000      |
| 2026-09-10                          | +0.03  | 0.04   | 12,000      |
| 2026-09-09                          | +0.45  | 0.28   | 12,000      |
| 2026-09-08                          | 0.00   | 0.14   | 12,000      |

In a duplicate-deal matchup the two arms differ only in the flag under test.
An exact zero with zero variance therefore means the flag changed no decision
in 12,000 hands: the arms played byte-identical poker. The matchup was inert,
and nothing in the league said so.

Why. V45 scoped reads (#3198, 2026-09-05) made `HorseMind.readStats` answer
from the `${scope}|${user}` bucket once that bucket holds `SCOPE_MIN_HANDS`
(40). Every decision in the league sandbox runs under a scope
(`HorseLogic.decide` sets one before `HorseMind.observe`), so each opponent's
scoped bucket passed 40 hands early in a matchup and took over every read. But
the harness settled each hand through `HorseMind.observeHandComplete(...)` with
NO scope, so the c-bet, 3-bet and big-bet counters the three V16 reads consume
were mirrored only into the pooled bucket. The scoped bucket that now answered
every read held zero opportunities, `foldToCbetOf` (needs 10),
`foldTo3BetOf` (needs 8) and `bigBetValueTendency` (needs 5) returned null in
both arms, and the layer never fired. Production passes `request.scope` on the
same call (`server/src/engine/horseDecision/workerRuntime.ts`); the league did
not.

Reproduced locally with `runMatchup(v16_deep_reads, pairs, seed)`:

| source                                             | pairs | seed 4242                          | seed 20260921                      |
| -------------------------------------------------- | ----- | ---------------------------------- | ---------------------------------- |
| main at de22f5f885 (2026-09-05 20:00Z, before V45) | 1,000 | -0.73 +/- 0.64                     | -0.10 +/- 0.08                     |
| main at bf83e6c304 (2026-09-11 23:38Z)             | 1,000 | 0.00 +/- 0.00                      | 0.00 +/- 0.00                      |
| main at bf83e6c304                                 | 6,000 | 0.00 +/- 0.00                      | 0.00 +/- 0.00                      |
| this branch, settlement without the scope          | 1,000 | 0 divergent pairs, 0.00 +/- 0.00   | 0 divergent pairs, 0.00 +/- 0.00   |
| this branch, settlement with the scope             | 1,000 | 4 divergent pairs, -0.73 +/- 0.64  | 2 divergent pairs, -0.10 +/- 0.08  |
| this branch, settlement with the scope             | 6,000 | 26 divergent pairs, +0.04 +/- 0.40 | 28 divergent pairs, -0.50 +/- 0.37 |

With the scope the 1,000-pair results are bit-identical to the pre-V45 tree:
the fix restores the reads exactly as they behaved before the scoped bucket
took them over. At the nightly 6,000 pairs neither seed resolves (both inside
2 stderr). That is a real answer: in a mirror the read returns the fleet's own
middling frequency, so the layer moves a decision rarely. Rare is a
measurement; zero is not.

Not established here: the source is inert locally from V45 on, yet the
production rows of 2026-09-06 to 2026-09-12 still carried variance and the
first production zero is 2026-09-13. The database records no server build SHA
to show what the nightly was running on those dates.

## What changed

- `server/src/benchmark/HorseLeague.ts`, `playHand`: the V16 harness passes
  `readScopeOf(gameVariant, seats.length)` to `observeHandComplete`, the same
  derivation `HorseLogic.decide` uses (variant x dealt count).
- `runMatchup` counts `divergentPairs` (pairs whose two passes settled to
  different chips, counted on the raw chip figure before bb normalisation) and
  returns `inert: true` when pairs were played and either no pair diverged or
  the per-pair differences have zero variance. A matchup that played no pair
  is not inert; it was not run.
- `runLeague` still writes an inert row, so the audit sees the shape, but
  reports it through `reportError(..., 'HorseLeague.inert')` with the matchup,
  hands and both configs, and its log line reads `INERT` instead of
  "not resolved", with `divergent=N` on every line. An inert matchup is a
  harness defect, never a measurement.
- `server/src/benchmark/HorseLeagueComputeWorkerClient.ts`: production runs
  every matchup in the compute worker, and the parent refuses any IPC result
  whose key set it does not know exactly. Adding the two fields without
  teaching that boundary would have made every `runMatchup` result malformed
  and refused the whole nightly card. `isLeagueResult` now accepts both exact
  shapes (the 11-key result assembled from components, the 13-key result from
  `runMatchup`) and checks the evidence agrees with itself: `divergentPairs`
  is a non-negative safe integer, no more than the pairs played, and `inert`
  is a boolean equal to the definition above.
- `server/src/benchmark/LeagueMatchupIsNotInert.test.ts` (5 tests): the
  standing `v16_deep_reads` matchup diverges at a fixed seed; a mirror
  (`a === b`) is named inert; a matchup whose flag reaches code is not; an
  empty matchup is not called inert; the worker boundary accepts both shapes
  and refuses evidence that contradicts itself.
- The notes beside the three commented-out matchups in `LEAGUE_MATCHUPS`
  carry the 2026-09-21 measurement, and the `v18_exploit_size` note now gives
  its real history (below).

## What was NOT changed, and why (pushback on the audit's ask)

The audit asked to restore `v16_ratio_rescale`, `v18_exploit_size` and
`v31_gto_suit_aware` to the nightly card. Each removal is documented in
`LEAGUE_MATCHUPS`, and a fresh measurement on today's code says restoring them
would recreate exactly the defect this change names.

Every row they ever wrote (`horse_league_results`, 12,000 hands each):

| matchup              | run_date   | bb/100 | stderr |
| -------------------- | ---------- | ------ | ------ |
| `v16_ratio_rescale`  | 2026-08-31 | +0.35  | 0.24   |
| `v16_ratio_rescale`  | 2026-09-04 | 0.00   | 0.00   |
| `v18_exploit_size`   | 2026-08-28 | 0.00   | 0.00   |
| `v18_exploit_size`   | 2026-08-31 | -0.04  | 0.15   |
| `v18_exploit_size`   | 2026-09-01 | 0.00   | 0.00   |
| `v31_gto_suit_aware` | 2026-09-01 | 0.00   | 0.00   |

Measured 2026-09-21 on this branch, divergent pairs at seeds 4242 / 20260921:

| matchup                                                         | 1,000 pairs | 6,000 pairs (the nightly size) |
| --------------------------------------------------------------- | ----------- | ------------------------------ |
| `v16_ratio_rescale` (`a: { v16Ratio: true }`)                   | 0 / 0       | 0 / 0                          |
| `v18_exploit_size` (`b: { v18ExploitSize: false }`)             | 0 / 0       | 0 / 0                          |
| `v31_gto_suit_aware` (seats 2, `b: { v31GtoSuitAware: false }`) | 0 / 0       | 0 / 0                          |
| control: heads-up `v11` (seats 2, `b: { v11: false }`)          | 7 / 2       | not run                        |

All three are 0.00 +/- 0.00 at both sizes and both seeds. The heads-up
control diverges, so the heads-up deal is not what hides `v31_gto_suit_aware`.
Restoring the three would add three rows a night that this change reports as
harness failures.

- `v16_ratio_rescale`: the audit's "2 runs pooling +0.175 bb/100" is the plain
  mean of the two rows above, and its "+/- 0.120" halves the one real error
  bar. One of the two rows is itself an inert 0.00 +/- 0.00 that measured
  nothing; the only measurement is +0.35 +/- 0.24 (1.46 stderr, unresolved)
  from 2026-08-31, before V38 (`v38Ev`, default on since 2026-09-03 per the
  note in `LEAGUE_MATCHUPS`) began answering every river spot ahead of the
  gate the flag rescales. The promotion rule (three significant positive
  nightly runs) cannot be met by a flag that changes no decision. `v16Ratio`
  stays OFF.
- `v18_exploit_size`: `valueThinMod` only leaves 1 against an opponent whose
  fold-vs-aggression rate leaves the middle band, and a self-play opponent
  does not. It is pinned deterministically in
  `server/src/engine/V18ExploitSizingIsMeasurable.test.ts`, where the effect
  is exact. (The existing note said it read 0.00 +/- 0.00 on 2026-08-31; that
  row read -0.04 +/- 0.15, and the note is corrected.)
- `v31_gto_suit_aware`: the existing note records ~195 live firings against
  924,871 decides; zero divergent pairs in 6,000 at two seeds agrees that the
  league cannot resolve it at any affordable sample.

Each stays one commented line away from the card. Re-added for a one-night
verdict, the harness will now say plainly whether it measured anything.

The same zero-stderr shape has also appeared outside these matchups, one night
each: `v18_squeeze_response` (2026-08-31), `v18_self_image` (2026-09-15) and
`v23_river_reads` (2026-09-18). From now on such a night is reported as
`HorseLeague.inert` instead of being written as a quiet zero.
