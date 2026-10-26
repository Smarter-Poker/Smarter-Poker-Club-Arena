# Horse range advantage is measured on and off every night

The public-range advantage read that shipped with the continuation work (#7838, #7866) changes heads-up postflop initiative: it drives the range c-bet upgrade, the V38 EV initiative and the pot-limit small sizes. After it went live, same-hour live hand reviews showed Hold'em "big bet, then fold" rising from 9.5% to 13.3% of reviewed hands (14:00–15:00 UTC, 2026-10-23 vs 2026-10-24), while river aggression that lost fell from 35.8% to 32.0%. Outcome tags cannot say whether the extra initiative earns, and no league matchup measured it.

`v52RangeAdvantage` (default on, so production play is unchanged) now gates the layer. With it off no own range is built, so every consumer falls back to the earlier rule: the Hold'em high-card dry-board shortcut and no range edge in Omaha. The nightly league gains `v52_range_advantage` (Hold'em) and `plo4_/plo5_/plo6_v52_range_advantage` mirror matchups, arm A = production, and the legacy all-off arm includes the flag. A focused test pins all four cards and proves the Hold'em and PLO6 arms diverge at 300 pairs.

Next: read the pooled nightly results. A variant where the layer resolves negative gets it repaired or defaulted off there, following the V16 overlay and short-deck chart precedent.
