# Preserve the bettor's history after an all-in call

The Omaha V40 pressure read selected the last `all_in` actor as the current
bettor even when that action only called an existing bet. A short caller could
therefore replace a three-street bettor and remove that bettor's earlier
barrels from the horse's decision. In the isolated regression, changing only
the short call's recorded action label changed a fold into a 50-chip call.

Use the authoritative controller's raise flag: an all-in call leaves it
undefined; a genuine short raise records `false`, and a full raise records
`true`. Both boolean values retain the new aggressor. Ordinary bets and raises,
earlier-street counting, model parameters and variant admission are unchanged.

`HorseAggressorHistory.test.ts` exercises actual HorseLogic decisions for PLO4,
PLO5, PLO6 and four-card Hi-Lo8, plus authoritative HandController call/short
raise/full raise records. Scalar equity and the separate V20 pressure model
are isolated so the test measures public-history attribution. The four
call-off regressions fail before the fix. A deliberately incorrect full-raise
only predicate fails the genuine short-raise control; the final 11 cases pass.

This is a source correctness regression, not profitability or fleet coverage
proof. Protected checks, the centralized certified engine delivery and actual
source-bound accepted decisions remain required before claiming it is live.
