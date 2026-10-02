# 2026-09-28 - A layer collapse is measured against the layer's own population

## What was wrong

The 2026-09-27 horse audit carried 135 warns; 113 were `layer_fire_collapse`.
`fn_audit_layer_drift` divided every layer's fires by fleet-wide `decide`, so
a shift in table mix read as a collapse on every layer of every shrinking
variant at once. That day the fleet swung toward tournaments
(`decide_tournament` 1,722,377 to 2,216,287) and FLH volume fell
(`phase13_variant_flh` 28,738 to 10,892). The FLH layers it named still fired
on 98.5% of FLH decisions, up from 92.5% the day before.

The cost was real: the flood hid a genuine decay the same day, `v15_nut_status`
per Omaha decision falling from 4.5% to 3.3% while Omaha volume was flat.

## Fix

Section 2 of `fn_audit_layer_drift` now divides each layer by the population
it can fire on:

| Layer                                                                                     | Denominator                                   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| population counters (`decide_*`, `phaseN_variant_*`, `_format_`, `_objective_`, `*_seen`) | not judged as layers                          |
| `phaseN_<variant>_*`                                                                      | `phaseN_variant_<variant>`, else phase13's    |
| `phase13_*`, `*_utility_cash`, `vpip_floor_*`                                             | cash decisions (`decide - decide_tournament`) |
| phase13 tournament hand-offs, `icm_*`                                                     | `decide_tournament`                           |
| bounty layers                                                                             | PKO + mystery-bounty decisions                |
| spin layers                                                                               | `phase8_format_spin`                          |
| `v15_*` / `v17_short_deck`                                                                | `decide_omaha` / `decide_short_deck`          |
| other `phaseN_*`                                                                          | `phaseN_seen`                                 |
| everything else                                                                           | `decide`                                      |

A layer whose own population fell at least as far as it did is not reported.
The finding's evidence now names the denominator and its value on both days.

## Measured (read-only replay against production telemetry)

| day        | old | new |
| ---------- | --- | --- |
| 2026-09-27 | 113 | 10  |
| 2026-09-26 | 21  | 9   |
| 2026-09-25 | 5   | 4   |
| 2026-09-24 | 50  | 23  |
| 2026-09-23 | 14  | 4   |

## What it still cannot tell

Telemetry has no per-variant cash counter, so a variant-scoped phase13 counter
(for example `phase13_plo4_eligible` on 2026-09-27) can still move with the
cash/tournament split inside that variant. The recommendation text says so.

Pinned by `tests/layer-collapse-reads-its-own-denominator.law.test.ts`.
