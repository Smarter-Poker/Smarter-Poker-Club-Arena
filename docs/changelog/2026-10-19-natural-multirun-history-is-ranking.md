# Recent multirun history ranks a subject instead of forbidding observation

Proof 39294419603 passed all four baseline cases, then failed before opening an
observer because no eligible table had both run counts in its recent history.
The bounded production read at 18:25:23 UTC found 32 eligible cash tables, zero
with both counts, four two-run hands and six three-run hands across different
tables. A fresh qualifying subject did not exist; an unchanged retry was not
justified.

Requiring both historical counts on one table was a predictive sampling
heuristic added by this delivery, not an acceptance requirement. Keep the same
ranking (balanced frequency, total frequency, population, table ID), but rank
all currently eligible subjects capable of player choice. The current bounded
read has 32 player-choice tables. Fixed mandatory-twice/three modes cannot
supply both formats on one subject, so the chooser excludes them using the
serving engine's case-insensitive mode semantics; the generic cash RIT gate
remains unchanged. Empty, malformed or one-format history cannot
make an ineligible or undiscovered table eligible. No eligible subject remains
an explicit failure.

One foreground observer, no replacement or retry, bounded indexed history
reads, the original setup/observation budgets, strict readiness and continuity,
all rivers before winners, every recipient within 2px and exact identity checks
remain unchanged. Actual live two-run AND three-run coverage is still mandatory;
historical counts cannot satisfy either. This is not a product latency repair
or a promise that both natural events will arrive within the observation.

Regression: new missing/one-format and eligibility cases failed on the former
chooser (3 failed, 42 passed); with ranking corrected, all 45 focused cases pass,
including the unchanged live-acceptance and DOM-witness regressions.

The fixed-mode negative case failed before the capability guard (1 failed,
45 passed). With that guard, all 46 focused cases pass.
