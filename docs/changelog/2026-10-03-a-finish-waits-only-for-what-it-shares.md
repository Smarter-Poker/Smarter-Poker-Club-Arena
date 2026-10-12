# A finish waits only for what it shares (2026-10-03)

Migration `20261003164157`. Law `tests/a-finish-waits-only-for-what-it-shares.law.test.ts`.

## What production said

Decided Spins and Sit & Gos reached their receipt (receipt `settled_at` minus the last elimination) at p50 3.2 s and p95 15.5 s between 16:00 and 16:35 UTC (929 finishes). `fn_complete_tournament_terminal` is not 2-12 s of CPU. Uncontended, just after the 16:35 restart, it took 0.41-2.1 s (mean 1.04 s over 35 calls). The rest of the tail was waiting. The postgres log records each wait with its call stack. Finish waits over 1 s, 15:30-16:35:

| wait                                                       | count | total   |
| ---------------------------------------------------------- | ----- | ------- |
| F(scope) exclusive (another finish of the same bank scope) | 226   | 1,094 s |
| F shared (behind an F-exclusive request)                   | 154   | 569 s   |
| `agent-commission:<club>` (behind a cash commission batch) | 74    | 135 s   |

- **The qualifier ask stalled every finish.** 312 of the 315 F-exclusive requests came from `fn_get_satellite_qualifier_state`. Each one waited for the slowest finish in flight, and every new finish then queued behind it. Between 15:47:27 and 15:48:37 seventeen finishes of 10-19 s ran back to back.
- **Every finish scanned every table its club ever had.** Closing the tournament table runs `fn_refresh_club_activity_counts`. Its live-table count had no index and read all of `public.tables` (430k rows, about 0.4 s serial in the finish). It then rewrote the `clubs` row even when nothing had changed. That fired 23 triggers and held the row lock until commit.

## What changed

- The ask now locks through `fn_ca_lock_satellite_answer_lane(uuid)`. It takes G shared, F **shared** and T(first) through the re-entry path of `fn_ca_lock_settlement_lane_for_finish`, so it never names F itself and the lane doctrine is unchanged. It then takes T(second), in uuid order. The satellite's payer (F exclusive, both T keys) and sweeps are still waited for and excluded. So are global authorities, both tournaments' hands and rolling authorities, and a finish of the target. Unrelated finishes are no longer blocked. The payer and every other caller keep `fn_ca_lock_settlement_lane_for_satellite_finish`. Only the owner can execute the helper.
- `idx_tables_club_activity_live` is a partial index on `tables(club_id)` whose predicate is exactly the refresh filter. The refresh writes the club row only when a count changed.

Nothing changes in money paths, receipts, escrow, conservation proofs, F06 or seat guards, or the engine. One note: the engine comment in `TournamentManagerEliminations.ts` (#5967) still says the ask takes F exclusively. Its five-minute answer reuse is still correct, and now it simply saves round trips.

## First dispatch refused

The first version added an overload of `fn_ca_lock_settlement_lane_for_satellite_finish`. The doctrine check inside the migration refused it, because rule 2 lists one name per overload. The whole transaction rolled back at 17:12 UTC. Only the `CONCURRENTLY`-built index remained, and the file was never installed. It was corrected in place to the helper above, and the overload-law allowlist entry was removed.
