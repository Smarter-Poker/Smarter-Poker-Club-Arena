# A Filled Spin Starts At Once

**Date:** 2026-10-09

Over 24 hours, all 17,636 Spins on production started late against their own reveal window. Lag p50 was 838 ms, p90 2,020 ms and p99 6,018 ms, and every one of those boards was filled by horses. The reveal is anchored one second after the last payment (`SPIN_REVEAL.LEAD_IN_MS`), and about 0.85 s of that second is the start work itself. The rest was detection. The fill job that bought the last seat never told the start path, so the board waited for the next fast-lane pass: one second of sleep plus about 0.37 s of reads, two passes when the read was stale, and 3.1 s in the worst trace.

| Change                                                                                                                                                             | Where                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| The fill that completes a board asks for its start at once, through `ensureTournamentManagerAdmission` and under every gate the fast lane keeps.                   | `GameServer.startFilledSeatFirstBoard`, called from `topUpPartialSeatFirst` |
| A step budget blown while a table idles (for example `idle_cluster_closed`) is logged, not reported as a dealing error. A budget blown mid-hand is still reported. | `ServerTableEngineDealing` deal-loop catch                                  |

The re-anchor stays as it was: when the start is still late, the wheel plays in full from the moment the engine can broadcast.

Law: `server/src/aFilledSpinStartsAtOnce.law.test.ts`.
