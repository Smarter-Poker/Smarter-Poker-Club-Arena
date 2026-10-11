# Two Detectors Read What Really Happened

**Date:** 2026-10-11

Three incidents were raised by detectors on 2026-10-11. Two were detectors answering wrongly and are fixed at the detector. The third was a real, short settlement lag and was closed with its cause.

## The Absent Player Check Read A Reused Chair

`fn_ca_absent_tournament_players` (hourly conservation sweep at :52) filed critical incident 5ae05f8a at 16:52 and 17:52: "2 player(s) are still in this event with no chips and no chair, the oldest for 0.6 hour(s)" on Coffee Break Freeroll (PLO4). Nobody was stranded. At 17:52:00 fifteen of that event's players were inside their 30 second rebuy decision, every one resolved by 17:52:41, and no knockout candidate anywhere was older than 10 minutes and unresolved at 16:52 or 17:52. The event finished and paid at 18:14.

The detector clocked a player's absence from `max(table_seats.left_at)`, or from registration when no seat row named them. `table_seats` keeps one row per chair (unique table and seat number) and the seating path reuses a vacated row, so the chair a player has just lost is re-taken seconds later and stops naming them. Those players read as absent since registering (17:11 to 17:15, so 37 minutes) or since an earlier table's departure.

Every elimination writes a `tournament_knockout_candidates` row and every move a `tournament_seat_move_receipts` row, and neither table reuses a row. Absence is now clocked from the latest of: any seat row still naming the player, the latest knockout candidate (from the end of its rebuy prompt, capped at 5 minutes after the bust, because a pending rebuy decision is not absence), and the latest move receipt. Registration is the clock only when none of the three exists. The maintenance break clause is unchanged.

## The Burn-In Gate Read 25 GB Every Hour

`fn_ca_midway_burnin_gate` (cron `ca-burnin-gate-hourly` at :58) failed 8 of 24 runs on the 120 second statement timeout (critical incident 30e42f14) and took 87 to 115 seconds when it passed. Its settlement check counted failed and stuck settlements with a filter over every `ca_settlements` row updated in 24 hours: about 1.2 million rows, 47 seconds, 1.2 million heap reads on a 25 GB table.

Both counts only ever count rows that are not final. The check now counts, in one statement and so one snapshot, the rows updated between the window start and ten minutes ago minus the final rows in the same range, using the two existing indexes without reading the table. When that difference is zero, no row old enough to be stuck is unfinished, so stuck is exactly zero and failed is exactly the failed rows of the last ten minutes. Otherwise the original exact query runs. No index was built. Every other check and the output are unchanged.

## The Settler Lag Warning Was Real

Warning incident 8a04443a (`fn_settler_lag_check`, 18:52) was true. The rakeback settler saved its cursor at 18:01:59, and its 18:26 cycle failed ("Cash source retry failed", "Cash source batch failed", `supabase_timeout`) inside the 18:15 to 18:53 database connection pool exhaustion. The cursor held, as it should, and the 18:52 check saw 48.7 minutes without a save against a 45 minute grace with 3,766 rows waiting. After the hourly break the settler drained from 19:00, and at 19:46 the check read healthy (last save 16 minutes ago, cursor lag 0.3 hours). The detector is correct and was not changed.

| Change                                                                                                   | Where                    |
| -------------------------------------------------------------------------------------------------------- | ------------------------ |
| Absence is clocked from the latest knockout candidate, move receipt or seat row, not from a reused chair | Migration 20261011200626 |
| The gate proves the settlement window clean from two index counts before it reads the table              | Migration 20261011200626 |

Both changes were proved first in a rolled-back transaction on production with copies built in the temporary schema. On live data the new absent check returned 0, as did the old one at that moment. On a fixture of six players (a bust 40 minutes ago that never resolved, the 17:52 shape inside a rebuy prompt, a bust 60 seconds ago after leaving an earlier table 30 minutes ago, a player never given a chair, a player moved 2 minutes ago, and a player whose last seat and last move were 25 minutes ago) the old check reported 6 absent and the new one 3: exactly the three genuinely stranded. The new gate ran in 2.0 seconds over 24 hours (it had taken 87 to 115), and over a 2 hour window its every check matched the old gate's exactly. Applied once at 20:06 UTC as 20261011200626.

Law: `tests/two-detectors-read-what-really-happened.law.test.ts`.
