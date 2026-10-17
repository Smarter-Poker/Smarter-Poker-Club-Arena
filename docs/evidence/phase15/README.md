# Phase 15 completion evidence (2026-10-16)

Aggregates only: counts, outcomes, first-difference field paths and (format, variant,
street) cells. No decision, hand, player or table identifier, no cards, no raw journal. The
private copy and the per-decision verdicts stay on Dan's Mac
(`$HOME/agent-work/hb-phase15-journal`, and the replay guest's disk image beside it).

| File                                                       | What it is                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `replay-declaration-4c3509e5-20261016.md` (+ `.sha256`)    | The predeclared window, written and committed (18:45:55Z) before any record was read              |
| `replay-declaration-addendum-20261016.md` (+ `.sha256`)    | The release change inside the window and the supplementary batch P, written before any replay     |
| `replay-20261016/selection-summary.json`, `P-summary.json` | What the declared rules selected from the copy (counts by variant, lane, admission)               |
| `replay-20261016/phase15-exact-replay-serving-*.{json,md}` | `scripts/phase15-exact-replay.mjs` output for each batch and source                               |
| `replay-20261016/aggregate.json`                           | Outcomes per batch and per variant, acceptance and receipt joins                                  |
| `replay-20261016/diag-P-4c3509e5.json`                     | DIAGNOSTIC, not replay evidence: the two `analysisMs` mismatches re-run with the fixed comparator |

## Journal copy aggregates (18:50Z to 19:04:49Z, 31,156 decision records)

Execution witnesses by (lane, status, reason): fast intended 30,230; deep not_executed
second_look_unchanged 879; fast not_executed second_look_replaced 24; deep intended 23;
fast not_executed turn_abandoned 5; fast coerced 1.

Durable plan receipts: 1,969 accepted exact wagers with a nonempty batch; 1,968 with their
receipt; 1 without, accepted in the copy's last 60 seconds; 12 decisions whose execution
record was not yet in the copy.

Policy ownership: all 30,254 FAST decisions carried a registered ownership receipt and a
sealed eight-node policy graph.

Out-of-domain / unavailable share per 5-minute bucket (at least 50 decisions), min..max:
flh 0.000..0.053 / 0.0000..0.0059; flo8 0.062..0.103 / 0.0052..0.0179; nlh 0 / 0;
pineapple 0.094..0.197 / 0.0000..0.0068; plo4 0.029..0.030 / 0.0009..0.0031;
plo5 0.022..0.035 / 0.0022..0.0049; plo6 0.055..0.057 / 0.0045..0.0074;
plo8 0.111..0.119 / 0.0070..0.0185; short_deck 0.044..0.099 / 0.0031..0.0105.

Decisions per active minute (min, median, max): flh 7, 50, 57; flo8 21, 58, 61;
nlh 1, 2,265, 2,496; pineapple 23, 70, 89; plo4 1, 801, 986; plo5 19, 495, 542;
plo6 3, 256, 324; plo8 2, 110, 129; short_deck 2, 96, 110.

Reference agreement (FAST; final policy action against the reference node; exact / same
action other amount / different action): nlh cash 4,366: 0.9915 / 0.0069 / 0.0016;
nlh tournament 11,645: 0.9912 / 0 / 0.0088; plo4 cash 1,203: 0.9776 / 0.0067 / 0.0158;
plo4 tournament 4,875: 0.9811 / 0 / 0.0189; plo5 cash 854: 0.9719 / 0.0105 / 0.0176;
plo5 tournament 2,588: 0.9664 / 0 / 0.0336; plo6 cash 851: 0.9741 / 0.0035 / 0.0223;
plo6 tournament 1,067: 0.9709 / 0 / 0.0291; plo8 cash 808: 0.9666 / 0.0062 / 0.0272;
flh cash 331: 0.9698 / 0 / 0.0302; flo8 cash 416: 0.9976 / 0 / 0.0024;
pineapple cash 549: 0.9872 / 0.0091 / 0.0036; short_deck cash 701: 0.9957 / 0.0043 / 0.
First divergent node: reference_legality nlh 131, plo4 104, plo5 99, plo6 39, plo8 7,
pineapple 7, short_deck 3, flo8 1; variant_policy plo8 20, plo4 14, plo6 14, plo5 12,
flh 10; tournament_utility nlh 8, plo4 1.

## Telemetry (horse_brain_telemetry, 2026-10-16 to about 19:00Z)

phase15*plan_commit_posted 262,544; phase15_plan_receipt_applied 262,080;
phase15_plan_refused*\* 0; phase15_plan_retirement_unconfirmed 154;
phase15_deep_execution_not_executed 102,855; phase15_deep_execution_intended 2,882;
v44_second_look_flipped 2,882.

## Prometheus (7 days to 2026-10-16 19:10Z, 1-minute step, maintenance breaks excluded)

Horse actions per minute (poker_actions_fleet_total{audience="horse"}): min 0, p0.1 13.8,
p1 94.4, p5 161.1, median 3,300.6, max 5,507.9; under 30 in 11 of 10,080 minutes.
Expired worker jobs per minute: median 0, p99 11.4, max 66.6.
