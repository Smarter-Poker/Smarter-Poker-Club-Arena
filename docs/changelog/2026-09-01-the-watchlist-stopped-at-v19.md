# The watchlist stopped at V19 (2026-09-01)

## What was wrong

`fn_audit_layer_silence` is a good detector. It reports a deployed layer that
fires zero times, it works, and it has caught real regressions.

It also carries a **hardcoded list of twenty features** that has to be edited
by hand every time a layer ships, and it had not been edited since 2026-08-27.

Measured: of the 60 features that fired in the last seven days, **forty were
unwatched** -- including every layer from V20 to V32:

    v20_commit_bar, v20_mzone_wired, v20_pressure_cap, v20_pressure_read,
    v20_weak2p_demote, v21_dominated_cap, v21_nut_status, v21_scare_cap,
    v21_scare_commit, v21_war_gate, v23_bounty_call, v23_plan_callonce,
    v23_plan_fold, v23_river_read, v23_spin, v24_bounty_pull, v26_prize_read,
    v27_gto_bb_defend, v27_gto_open_jam, v29_gto_flop_defend,
    v29_gto_flop_open, v30_gto_river_open, v30_gto_turn_open, v31_gto_open,
    v32_defend_call, v32_defend_fold, v32_defend_no_range,
    v32_defend_pass_strong

**A silent V32 would never have been reported.** `v23_river_read` fired ZERO on
2026-08-31 after 4,205 fires two days earlier, and nothing said so -- I found
it by reading the raw telemetry table by hand.

This is the same shape as everything else found today: an instrument that looks
identical whether or not it is covering the thing you think it covers.

## The fix

The root cause is the hand-maintained list, so a _longer_ hand-maintained list
is not the fix -- it would go stale again the same way. Two new checks derive
the watchlist from what each layer has **actually done**, so every future layer
is covered on the day it first fires, with nothing to remember:

- **`layer_went_silent`** -- fired on 2+ of the previous 7 days, zero today.
- **`layer_fire_collapse`** -- fires per 1,000 decisions fell below 40% of its
  own trailing median.

Rates, never raw counts: the fleet's daily volume swings by 40%, and a busy day
would otherwise mask a layer that stopped firing.

The new check reads `fn_audit_layer_silence`'s **output** to know what it has
already reported, rather than re-listing its twenty features, so the two
detectors cannot drift apart.

## Tuned, not guessed

Backtested before shipping and re-verified after apply:

| Day        | Alarms | What                                                                                                      |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------- |
| 2026-08-28 | 0      |                                                                                                           |
| 2026-08-29 | 1      | `icm_legacy`                                                                                              |
| 2026-08-30 | 1      | `icm_legacy`                                                                                              |
| 2026-08-31 | 5      | `v23_river_read` went silent; `icm_legacy`, `v16_unblocker`, `v18_self_image`, `v15_nut_status` collapsed |

Nothing on a quiet day, and on the day the V29-V32 solver stack displaced the
heuristic layers it names precisely those layers. A 30% floor missed
`v18_self_image`, which is the case that motivated the check, so the floor is
40%.

The `prior_fires >= 5000` and `n_days >= 3` guards keep a rare layer's noise
from reading as a signal.

## Honest about the innocent explanations

`icm_legacy` collapses because `icm_real` superseded it. That is correct
behaviour, and it is the one alarm that fires on quiet days. The
recommendation says so explicitly, along with the other innocent case -- a
newer layer returning early and displacing the ones below it, which is exactly
what V29-V32 did on 2026-08-31.

Both are worth confirming rather than assuming, because the third explanation
is a gate that broke.

## Verification

Applied via the Supabase MCP with post-apply assertions that check every
earlier hook survived the splice and that the 2026-08-31 tuning reproduces.
The file is committed here in the same change, which this morning's sweep
found I had failed to do twice.
