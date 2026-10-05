# Horse daily audit 2026-10-04: follow-through (2026-10-05)

Scope: the eleven flaws the 2026-10-05 analysis-tier run wrote for audit day
2026-10-04. Two ship as code here; the rest are classified with evidence.
Significance rule throughout: a result is called positive or negative only when
|bb100| > 2 x stderr. Pooled figures are inverse-variance pooled over runs.

## Shipped

### V46 short-deck chart: default OFF (`v46ShortDeck`)

Local replay of the exact league matchup (`runMatchup`, `LEAGUE_MATCHUPS`
definition, `EQUITY_GOVERNOR=off` exactly as `HorseLeagueComputeWorkerClient`
sets it, seeds 900000 + k x 7919 that the nightly never uses). Solver stores are
not hydrated locally; HorseLogic skips both solver paths for Omaha and short
deck (`!vi.isOmaha && !vi.isShortDeck`), so for these variants the replay is the
production brain.

| matchup                                               | runs | hands   | pooled bb/100  | z     |
| ----------------------------------------------------- | ---- | ------- | -------------- | ----- |
| shortdeck_v46_classes (local, pre-committed 80 seeds) | 80   | 960,000 | -0.51 +/- 0.15 | -3.37 |
| shortdeck_v46_classes (nightly, 2026-09-06..10-05)    | 30   | 360,000 | -0.24 +/- 0.24 | -1.0  |
| plo6_v46_classes (local)                              | 12   | 144,000 | +0.92 +/- 0.73 | +1.25 |
| plo6_v46_classes (nightly, all)                       | 30   | 360,000 | -0.44 +/- 0.47 | -0.9  |
| plo4_v46_classes (nightly, all)                       | 30   | 360,000 | +0.48 +/- 0.37 | +1.3  |

Short deck resolves negative; Omaha does not. The short-deck half of the chart
moves behind `v46ShortDeck` (default off). `v46Charts` keeps the Omaha half on.
`shortdeck_v46_classes` keeps its name and sign (arm A = chart on) so the nightly
series stays continuous. The 10-05 single-night readings (-2.87 short deck,
-5.19 plo6) that triggered this were one night each; plo6 does not reproduce.

A first local batch ran with the governor ON and throttled under load
(`[EquityGovernor] loop recovered ... throttled`); it was discarded.

### V51 river flat (`v51RiverFlat`, default on)

Root cause of the sampled `one_pair_river_stackoff` hands. Hand 1039665 (QcJh on
6c 5s Qd 9c 3s, tournament): check-raised on the turn and called, bet the
checked river, was raised to 15,656 and re-jammed 27,885. The raise left SPR
under 1.2, so HorseLogic's committed branch ran, and it answered every hand
clearing its call bar with `all_in`. Replayed through `decide()`: 200 of 200
seeds jammed; TT and AA over-pairs likewise. On the river a jam has no card to
deny and is called only by better, so one pair (or two pair whose second pair is
the board's) now calls. Sets and better keep the jam; the turn is unchanged.
Measured going forward by league matchup `v51_river_flat`; no improvement is
claimed until it resolves.

The handoff's hypothesis (one pair facing a river 3-bet jam) is not the leak:
QJ, QQ and TT fold that spot on 200 of 200 seeds. V15's equity cap is Omaha and
straight/flush only by design, so the hold'em hands were never in its scope.

## Classified, no code change

- **v43_tempo_read / v44_declined_governor "fire collapse".** Table mix, not a
  gate. Cash hands fell 1.18M to 0.66M on 10-04 and tournament share rose 69% to
  86%. v43 needs a river bettor with a tempo history; per cash hand it ran
  4.1-5.0/1k on 09-30..10-03, 3.3 on 10-04, 5.4 on 10-05. v44 checks
  `no_think_time` before `governor`; `v44_declined_no_think_time` rose 61k to
  157k the same day, so fewer turns reached the governor. No think-time, tempo or
  second-look code changed 10-02..10-04. Instrument note: the audit divides by
  `decide`, which is not either layer's population.
- **freq_no_3bet (55% of horses).** Not V46. The leak is a flat `three_bet <
0.03` in `fn_horse_frequency_leaks`, the same bar for every variant and format.
  44% of hold'em-heavy horses (V46 cannot touch them) already fall under it;
  Omaha-heavy 73%, mixed 59%. The share was 37-49% before V46's first league run
  and rose with the tournament share. Treat the bar as hold'em cash calibrated.
- **phase7_tournament_utility at 96.6%.** Fully accounted: the 147,249 gap on
  10-04 is exactly `phase7_utility_unavailable`, whose named refusals sum to it
  (recovery_option 79,468, field_reconciliation 47,419, baseline_not_modeled
  17,887, sample_calibration 2,466, equity_evidence 9). Deliberate refusals; the
  99% floor assumes rebuy/add-on recovery is modeled, which it is not.
- **v17_river_probe "-2.4 sigma".** One night. Pooled over 32 nights: 0.00 +/-
  0.01 bb/100. A precise null; nothing to ablate.
- **hu_v16_overlay.** Pooled 31 nights -0.26 +/- 0.10 (z -2.6). It is one rule
  (a -0.015 postflop threshold nudge whenever one opponent remains), not the two
  sub-rules the handoff named, and it fires in every heads-up postflop pot while
  the matchup only seats two. Left on; a decision for the owner.
- **self_tune real_bb100 = -9999.** Correct. Every sentinel row 09-29..10-05 has
  `real_hands` < 1,500 and every scored row has >= 1,501; the 1,500 bar is on
  real hands, and `hands` also counts non-real hands. No sentinel row moved a dial.

## Follow-up decisions (2026-10-05, afternoon)

- **hu_v16_overlay: default OFF.** Its only measurement is significantly
  negative (-0.26 +/- 0.10 over 31 nights, z -2.6). `v16Hu` is now opt-in;
  `hu_v16_overlay` keeps its name and sign (arm A = overlay on), and a new
  `v16_hu_overlay_6max` measures it in ring pots that come down to two players,
  where it mostly fired. Its receipt floor is removed (an opt-in layer is
  expected to be silent).
- **freq_no_3bet: retired, not re-banded.** Per game mix, the horses it flagged
  did better: hold'em-heavy -17.9 vs -23.1 bb/100 (z +2.3), mixed -21.0 vs
  -28.5 (z +3.4), Omaha-heavy no signal (z -0.8), cash 2026-09-21..10-05. Of the
  nine frequency bars only freq_too_loose separates results (mixed z -4.8); the
  rest show nothing either way. The bar is cash-only already (the earlier note
  that it covered every format was wrong). Migration
  `20261005190000_the_audit_stops_crying_wolf_on_mix_and_on_three_bets`.
- **Audit counter warnings: fixed in fn_audit_layer_drift.** v43_tempo_read and
  v16_reads_tell are divided by cash decisions, and reason / refusal / miss
  counters plus the named fallbacks are no longer judged as layers (their lanes
  are judged on `_fired` / `_eligible`). Replayed over 2026-09-28..10-05:
  73 collapse warns become 5, all real layers. The ledger floor for
  v16_reads_tell moves to 0.4% of `phase13_utility_cash` (observed 0.65-1.15%).
- **HorseDecisionJournal capacity test:** counts only `[HorseDecisionJournal]`
  warnings, so another module warning during the fake-timer advance on a loaded
  runner cannot fail it.
- **V31 solver pipeline: not commissionable from software.** The input bundle
  must bind the checksum and 1,326-combo order of a licensed PioSOLVER binary,
  and its producers are two licensed-PioSOLVER Windows hosts (M1, M2) with their
  own HMAC keys (docs/SOLVER-DATABASE.md). None exist; every V31 table is empty.
  `ca_gto_v31_approve_input_bundle` was not run because there is nothing real
  to approve.
