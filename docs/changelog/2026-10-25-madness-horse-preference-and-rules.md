# Madness horse preference and exact-rule qualification

For new PLO5 Madness seats with the existing 50% VPIP, BB ante and bomb-pot rules, order already eligible candidates using measured PLO performance. Shrink bb/100 toward neutral by hands/(hands+5000), using the existing qualification sample weight. This is advisory aggregate PLO evidence, not a PLO5-specific skill certificate or a solver grade.

Read hands and bb/100 in the existing roster request. Invalid, stale or failed reads revert to the existing weighted draw. Preserve activity schedules, bankroll checks, seat admission, four-table limits, every candidate and every seated player. Other rule profiles retain their existing draw. No new per-table query or production data change.

Regression coverage exercises the reader and selector together, sample-size boundaries, stale/failed data and other profiles. Real HandController and HorseLogic tests cover six-player PLO5 1/2 ordinary BB-ante hands, double-board 3BB bomb pots, a short stack, action acceptance and chip conservation. Existing fleet funding, policy and seating tests remain applicable.

Local qualification passes 59 tests across seven suites and server TypeScript. Protected CI, merge, the existing engine release route, installed identity and natural new-seat behavior remain separate delivery gates. Routine engine activation is at 04:00 America/Chicago; no emergency admission is requested.
