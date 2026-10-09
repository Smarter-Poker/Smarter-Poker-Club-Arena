# A Spin Opens Two Seconds After Its Last Seat

**Date:** 2026-10-09

Over 24 hours every Spin started late against its one-second lead-in. Starting a Spin takes about 0.85 s of work, so a one-second lead-in left almost nothing for noticing that the last seat had been bought. Even after the fill job began starting a board the moment it filled (#6594), the typical delay was still 562 ms. Dan approved a two-second lead-in on 2026-10-09.

| Change                                                                                 | Where                                                                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SPIN_REVEAL.LEAD_IN_MS` is 2000 (was 1000), in both byte-identical copies of the spec | `server/src/config/spinSpec.ts`, `src/config/spinSpec.ts`                                             |
| The lead-in test now budgets the detection floor and the measured start work together  | `SpinStartsInOneSecondAndPlaysInFull.test.ts`, `spinRevealWindow.test.ts`, `sharedSpinReveal.test.ts` |

The re-anchor is unchanged: a start that is still late plays the wheel in full from the moment the engine can broadcast.

## Also Recorded Here

- **20261009233856 the freeroll listing says what it pays.** Every "$100 Freeroll" schedule (Midway and the Diamond Arena) pays its guarantee as a floor, but the listing read as $100 plus every rebuy. The 12 schedules now read "$100 Guaranteed Prize Pool. Entry Is Free. Every $1 Rebuy And $1 Add-On Goes Into The Prize Pool, Which Never Pays Less Than $100." Occurrences already open for registration keep their text, because `fn_guard_managed_game_lifecycle` locks a registered event.
- **20261009233911 two caller-driven checks are exempt from the sweep.** `fn_ca_integrity_identity_links` (an operator paged reader) and `fn_lightning_integrity_report` (the engine's signal door) carry exemption reasons, so the orphaned-checks watch reads clean.
- **20261009233939 the explained alerts close with their evidence.** These are the last 14 incidents and 28 alerts of the launch list: the Diamond felt replay and kill-switch readings, the 2026-10-06 house-horse retirement (closed with its cause recorded and no journal leg), the two refused transfers that moved nothing, the orphaned-checks watch, and the six refused-hand alerts of the three cleared Diamond tables.
