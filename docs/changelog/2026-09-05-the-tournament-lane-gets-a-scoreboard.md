# The tournament lane gets a scoreboard and a leak profile

2026-09-05. From the deep audit: _62% of horse play gets no feedback at all._

Seat-hands in the week: tournament 5,322,596 (66%), cash 2,034,824, hu_cash
634,618. The self-tuner is cash-only by design; `horse_daily_nets` records
tournament chips as 0.0 bb/100 because chips are not bb-comparable; and no
table anywhere held a horse's ROI, ITM or finish. The 61,955 tournament review
rows written that week (23,921 tagged) were read by nobody.

## 1. A scoreboard

`horse_tournament_daily` - per horse/day/type/variant: entries, invested
(buy-in + fee + rebuys + add-on), won (prize + bounties + mystery), ITM
entries, finish percentile sum, best finish. `fn_horse_tournament_daily_compile
(p_day)` builds it from `tournament_players x tournaments` COMPLETED that day;
`fn_run_horse_daily_audit` now calls it for its day (patched in place from
the live definition, so no other step is overwritten) and then judges it
through `fn_audit_tournament_results`: an `info` row per type with ROI and
ITM over seven days, a `warn` (`tournament_roi_negative`) under -15% on
2,000+ entries, and a `critical` (`tournament_results_missing`) when
tournaments completed and the scoreboard is empty. Backfilled eight days;
tonight's numbers as the audit will print them:

    MTT       ROI  +4.0%  ITM 19.5%  27,225 entries
    SNG       ROI  -5.0%  ITM 50.0%  44,898 entries
    SPIN      ROI  -8.8%  ITM 33.7%  83,799 entries
    SATELLITE ROI -31.2%  ITM 50.0%   1,328 entries

The fleet plays itself, so a type's pooled ROI is minus the fee plus any
overlay; the recommendation text says to compare against -fee% rather than
zero. `ca_horse_tournament_card(p_days)` is the same card for the horse pages,
admin-gated and allowlisted like the other `ca_horse_*` console functions.

## 2. A leak profile

`horse_review_rollup` has no format column, so the tournament share comes
straight from the review rows: `fn_horse_tournament_leaks(p_since)` returns
per-horse tag counts and reviewed hands over `format = 'tournament'`. The
tuner writes them as `leaksTournament` / `leaksHandsTournament` next to the
V41 family maps. The tournament family never falls back to the pooled map -
cash verdicts are not event verdicts.

## 3. The brain reads it

`tourneyLeakPremium(mods)`: a horse whose tournament stack-off rate
(`TOURNEY_STACKOFF_TAGS`, both card families) is at or above the 8% tagged bar
pays up to 0.03 extra ICM survival premium, added inside `icmRisk` at all
three call sites (preflop, the V38 all-in price, postflop). It calls off less,
jams less light, and bluffs less - in the format where the verdicts came
from, and nowhere else. Receipt `v41_tourney_leak_read`, once per tournament
decision; flag `v41Leaks`.

## Tests

`HorseV41TournamentLeaks.test.ts` (5): parse, no fallback to cash, premium
cap and bar, a tagged horse folds a bubble call-off at least as often as a
clean one with the receipt firing, nothing fires at a cash table or with the
flag off. Ledger rows for the table, the params, the profile keys and the
receipt. Migration applied; manifests regenerated.
