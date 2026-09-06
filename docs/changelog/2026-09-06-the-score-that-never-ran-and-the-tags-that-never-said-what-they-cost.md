# The score that never ran, and the tags that never said what they cost

2026-09-06, second pass. Both of these were named as open in the morning
report; both are closed.

## 1. The only absolute score had never been taken

The fleet plays itself, so its aggregate result is zero minus the drop **by
construction** and can never measure skill. The league measures config A
against config B. That leaves exactly one absolute number in the estate:
agreement with the push/fold charts, a reference the brain did not author.

It had never been written once. It sat at the END of `runLeague`, after a
matchup card whose own source comment says it is _"ALWAYS killed mid-card"_:

| run        | matchups completed | score |
| ---------- | ------------------ | ----- |
| 2026-09-04 | 28                 | none  |
| 2026-09-06 | **3**              | none  |

A budget break falls through to trailing code. A killed process does not. So
the estate's only absolute measurement was gated behind ninety minutes of work
that does not finish, and cost seconds itself.

**Now:** it runs before the matchup loop, it writes a row on the skip path too
(so "no score" and "the chart store was empty" stop looking identical from the
database), and a day whose card already ran still gets its score through the
`alreadyRanToday` short-circuit. Four law tests pin all of it, including that
it must never start reading `results` — the moment it does, it can no longer
run first, and the reason it must run first is that `results` is incomplete.

## 2. No tag had ever said what it was worth

`horse_review_rollup` carried tag COUNTS. A count says how often a shape
happened; it never says whether the shape was wrong. So the leak table could
only be ranked by loss total, which ranks situations **by how often they occur
in big pots** — and `river_aggr_lost`, at -778,000bb the largest number in the
table, read as the fleet's worst leak.

`leak_net_bb` puts the net beside the count. The first honest ranking, seven
days:

| situation                        | bb/hand     | hands  | won   |
| -------------------------------- | ----------- | ------ | ----- |
| `plo_naked_trips_stackoff`       | **-146.91** | 480    | 0.8%  |
| `plo_toppair_no_redraw_stackoff` | **-128.59** | 237    | 1.3%  |
| `coldcall_stackoff`              | -69.09      | 5,133  | 10.1% |
| `top_pair_weak_kicker_stackoff`  | -67.37      | 1,220  | 8.4%  |
| `preflop_stackoff`               | -66.04      | 1,146  | 18.0% |
| `limped_pot_bloat`               | -60.89      | 3,366  | 10.5% |
| ...                              |             |        |       |
| `river_raise_war`                | +12.27      | 7,858  | 55.7% |
| `river_aggr`                     | **+12.66**  | 75,811 | 64.5% |

River aggression is **profitable**, over 75,811 hands. The two PLO stack-offs
win under 1.5% of the time and cost more per hand than anything else the fleet
does — those are the real targets.

This is a genuine signal and the fleet aggregate is not, for a reason worth
stating: these tags are **asymmetric**. Only the horse in the bad spot carries
one, never its opponent. So a negative EV here is that horse's mistake, not a
chip moving from one pocket to another.

## What it cost to get there

Two bugs of my own, both caught by checking output against a second source
rather than by re-reading code:

- **The backfill grouped by the TIMESTAMP, not the date.** Every hand became
  its own group and `jsonb_object_agg`, which keeps the last value for a
  duplicate key, wrote one hand's net per tag instead of the sum. It read as
  river aggression netting +4,298bb on a day the raw table says +136,479bb.
  Found by cross-checking the rollup against `horse_hand_reviews` per day.
- **Mirror status was inferred from the week's cards.** `mirrored` meant "a
  `_won` key exists", so a situation whose mirror is real but RARE dropped out
  of the ranking — and the rarest mirrors are the worst situations. It would
  have hidden `plo_naked_trips_stackoff` and `plo_toppair_no_redraw_stackoff`,
  the two biggest losers in the fleet. Mirror status is a fact about the code,
  so it now comes from the fold family `HorseHandReview` names.

There was also a third naming shape nobody had noticed: river aggression is
`river_aggr_lost`/`river_aggr_won` (it was the first tag ever mirrored and got
a symmetric name), while everything since is `X`/`X_won`. Stripping only
`_won` left it showing a 100% win rate over 48,891 hands.

## And the nightly audit came back under its ceiling

`fn_audit_river_aggression_ev` made two full-day passes over
`horse_hand_reviews` — 26,969 rows in a 437MB table, ~43MB of heap each — to
answer one question:

|                           | before       | after      |
| ------------------------- | ------------ | ---------- |
| that step                 | **5,868 ms** | **107 ms** |
| every other step combined | 951 ms       | 951 ms     |
| whole audit, warm         | 3.3 s        | **2.7 s**  |
| findings                  | 82           | **99**     |

86% of the audit was one step, and it now reports twenty-one situations
instead of one. The 15s engine-client abort has real headroom again.

## Migrations

- `20260906093726_every_tag_carries_its_own_ev`
- `20260906093746_tag_ev_title_typo`
- `20260906093926_the_ev_ranking_pairs_every_mirror`
