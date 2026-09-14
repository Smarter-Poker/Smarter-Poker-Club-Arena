# A rise is not a leak until the mirrored EV says so

2026-09-14, from the daily horse audit analysis reading the 2026-09-13 row.

## What was wrong

`leak_tag_spike` in `fn_run_horse_daily_audit` calls a tag a leak on the
strength of a **loss-only count**. It compares today's per-1k rate of a tag
against a seven-day baseline and warns when it rises.

The same audit run already knows better. `fn_audit_river_aggression_ev` reads
`fn_horse_tag_ev`, which pairs every `<tag>` with its `<tag>_won` mirror and
ranks the situation across BOTH outcomes - and that function's own
recommendation text says why, in as many words:

> Ranked by bb per hand across BOTH outcomes, which is the only honest
> ranking: a loss-only total ranks situations by how often they occur in big
> pots.

The spike detector *is* that loss-only total. On 2026-09-13 it produced three
warnings and **every one of them was wrong**. Measured on the live seven-day
window:

| tag | mirrored EV | hands | win rate |
| --- | --- | --- | --- |
| `straight_into_flush_stackoff` | **+18.27** bb/hand | 2342 | 69.0% |
| `nonnut_straight_stackoff` | **+27.18** bb/hand | 2080 | 78.9% |
| `straight_into_flush_stackoff_won` | (the WIN side of the first pair) | | |

Those are two of the fleet's most profitable situations, and the third finding
warned that **winning was happening more often than usual**. An agent following
the recommendation ("a spike after a deploy means the brain regressed on this
pattern") would have tuned the horses away from +18 and +27 bb/hand spots.

The detector is not useless - it is right about `dominated_straight_stackoff`,
which `fn_horse_tag_ev` puts at -3.71 bb/hand. So the fix is not to silence it.
It is to make it read the number the audit has already computed.

## What changed

The spike branch now resolves the tag to its situation (strip `_won` / `_lost`,
the identical expression `fn_horse_tag_ev` uses) and looks up the seven-day
mirrored EV:

- **EV >= 0** - new code `leak_tag_spike_positive_ev` at `info`, stating the
  measured EV and saying plainly not to tune away from it or open a league
  matchup for it. It becomes a real warning on its own the day the situation
  turns negative.
- **EV < 0** - the original `leak_tag_spike` warn/critical, unchanged.
- **EV null** - also the original warn, unchanged. Null means under 100 hands
  in the window, or the fold family, which has no winning mirror by
  construction.

`mirrored_bb_per_hand` is carried in the evidence of **both** paths, so the
reader can always see which of the three cases they have. This is CLAUDE.md
10.86 rule 1: "I could not tell" is a distinct outcome and must have its own
name. There were three outcomes here and the detector only had two.

This repairs nothing and adds no detector (10.11 / 10.12). It stops an existing
detector asserting a cause it never checked - the same correction the
2026-09-12 migration made to `fallback_went_quiet` and `league_card_starved`.

## How it was applied

The body is patched by an **asserted, single-occurrence text replacement**
rather than by retyping all 16,464 characters of the function, so every line
outside the replaced block is provably byte-identical to what production held.
The migration counts occurrences of the pre-image block exactly and aborts,
changing nothing, unless it finds exactly one. Observed pre-image md5
`4a153233b1f149ee52a6932b54393342`. A replay is a no-op rather than an abort.

Cost: `fn_horse_tag_ev` is called once per **spiking** tag, measured at 77ms,
and only tags with 20+ flagged hands that also cleared the 1.5x baseline reach
it - three on 2026-09-13. The function's 60s `statement_timeout` is unchanged
and is not at risk.

## Verified

Applied outside the :50-:03 break window (production DDL policy rule 8), then
`fn_run_horse_daily_audit('2026-09-13')` re-run. All three findings changed
from `warn`/`leak_tag_spike` to `info`/`leak_tag_spike_positive_ev` carrying
`mirrored_bb_per_hand` 18.27, 18.27 and 27.18. No `leak_tag_spike` warning
remains for that day, which is the correct answer: not one of the three was a
leak.
