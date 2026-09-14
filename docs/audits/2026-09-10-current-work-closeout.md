# Current Work Closeout, 10 September 2026

The previously releasable web changes are published, and the inspected audit source and proof branches are preserved remotely. The overall audit is **not complete**. The full programme contains **216 original requirements**, including the user-excluded G07. **Phase 3 contains 58 of those requirements**: T12, K02, K11 and S09 are fully verified, and 54 remain open. The 7,038-row source inventory identifies coverage surfaces; it is not a record of line-by-line review.

The [machine-readable inventory](2026-09-10-current-work-closeout.json) records exact commits, CI runs, public readbacks, archive references, worktree observations and remaining dependencies. It supersedes the release status in the earlier resume-swarm report.

## Published And Verified

PRs [4105](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4105), [4163](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4163), [4169](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4169), [4178](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4178) and [4188](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4188) are merged. The web release verified at 16:41:39 UTC was `d88d6167811f59ce4123c1a8d47008d65044e354`.

- Required CI [34501761103](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34501761103) passed on attempt 2. One unchanged browser job was retried after a page-creation timeout before the test body. The retry passed 150 browser checks, 13 Table Studio cases and 3 mobile decision cases. Test assertions and timeouts were unchanged.
- Publisher [34503230506](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34503230506) passed its web build, all client shards and origin publication.
- Both public build-info endpoints returned HTTP 200 and the exact release SHA at 16:41:39 UTC: [static origin](https://ca-static.smarter.poker/build-info.json) and [Club Arena entry](https://smarter.poker/hub/club-arena/build-info.json).
- Earlier engine adoption of PRs 4105 and 4163 was verified at `0a76896196c1bea84de06d14ff998b83ab921117`. The Spin-only migration was applied separately as ledger version `20260910141101`.

Sentry release and source-map upload still return HTTP 403. The published distribution contains zero source maps. Capgo native OTA was skipped; web publication does not establish native OTA delivery.

## Four Approved Database Migrations Applied And Verified

**Target: PokerIQ-Production, project `kuklfnapbkmacvwxktbh`. All four approved migrations are applied and verified.**

The user explicitly approved these four migrations for this production target after the earlier automatic approval review rejection. Each exact reviewed SQL file applied successfully. The 17:20:23 UTC readback verified all six resulting function bodies, all ten inspected function metadata records, four unchanged dependency bodies, both unchanged triggers and all four exact SQL hashes in the migration ledger. Independent swarm readbacks also passed. [Deployment Evidence](2026-09-10-approved-database-deployment.json).

| Reviewed Candidate                                                                                                                                                                                                                                 | Resulting Behavior                                                                                                                                                   | Verification                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Started Tournament Cancellation Guard](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/24217c5024a4c031aec51dbddba531cd3c1b7842/supabase/migrations/20260910035015_started_tournaments_resume_or_settle_instead_of_cancelling.sql) | Refuses cancellation of a started tournament or one with committed awards, after existing receipt replay.                                                            | 14 native groups; refusal and locking coverage, not funded cancellation certification.                                                         |
| [Finishing-Place Debt Guard](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/24217c5024a4c031aec51dbddba531cd3c1b7842/supabase/migrations/20260910040332_a_refused_finishing_place_creates_no_debt.sql)                             | Refuses new debt or an increase of existing unpaid debt for a conflicting finishing place.                                                                           | 11 native groups; the old owner demonstrably increases owed debt to 150, while the candidate preserves 110.                                    |
| [Required Finishing Rank](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/24217c5024a4c031aec51dbddba531cd3c1b7842/supabase/migrations/20260910051131_a_tournament_elimination_requires_a_finishing_rank.sql)                       | Returns an early refusal for a missing rank. The existing deferred constraint already prevents durable null-rank elimination.                                        | 7 candidate native groups and the 6-group existing-constraint baseline.                                                                        |
| [Funded Satellite Seat And Escrow Correction](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/473bd2d41b88ad352819c77031ddc4dad209917b/supabase/migrations/20260910160106_satellite_seats_count_once_and_keep_the_funded_prize.sql) | Counts prestart seats once, avoids subtracting an already-excluded fee, and removes the empty direct-bounty phantom row. Preserves current ticket-redemption inflow. | 24 native checks, 5 observed lock waits and 13 committed input hashes; funded prize, bounty, fee, replay, rollback and authorization coverage. |

The exact SQL SHA-256 values and original-to-ledger filename mapping are in the inventory. The unchanged SQL files are recorded under their actual production ledger versions: 20260910171843, 20260910171857, 20260910171911 and 20260910171924. The three guard candidates and the funded satellite candidate verify original and resulting function definitions and execution metadata, with a 1-second migration lock timeout and 10-second migration statement timeout. They change future behavior and do not rewrite historical balances. These migrations do not activate the dormant accounting, canonical clock or exact-K satellite programme.

Proof bundles: [Tournament Guards](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/24217c5024a4c031aec51dbddba531cd3c1b7842/docs/audits/2026-09-10-current-guards-proof/evidence.json) and [Funded Satellite Helper](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/473bd2d41b88ad352819c77031ddc4dad209917b/docs/audits/2026-09-10-satellite-funded-current-closeout.json).

## Preserved Work And Remaining Activation

Nine archive references are verified in the inventory: tournament guards, commission capture, Round 2 source funding, payer completion, canonical clock, exact-K satellite, funded satellite helper, rakeback browser and original root history. Each has an exact remote commit and an explicit deployment status. Archive publication does not mean production activation.

The original-history archive at `251e1c5b07fc0a4b1f3e4c6fb6589562589e4839` preserves all 14 original commits and 72 file hashes. Four superseded migrations remain byte-preserved under historical documentation, outside active migrations. Its runtime and default CI match historical published parent `780398afa772b69f491586c9092016d1aca8dff6`; this is not a recertification of current production. Normal named-origin push hooks passed after preserving earlier failures and unchanged focused reruns. [Gate record](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/251e1c5b07fc0a4b1f3e4c6fb6589562589e4839/docs/audits/2026-09-10-root-original-history/gate-verification.json).

Remaining work is explicit:

- Accounting needs coordinated legacy exclusions, actual outer Union dispatch, common finality, source funding and coordinated backend/browser activation.
- The canonical clock still needs public lifecycle owners and complete manager, client and rolling-version composition.
- Exact-K satellite activation depends on externally owned Stage-B functions and legacy-client adoption.
- Sentry upload authorization and native OTA delivery remain unresolved.

The existing local clock rehearsal database is intentionally retained after automatic approval review rejected its cleanup. It is not an untracked source artifact or a production migration.

At the previous closeout, no new audit phase had been opened. The latest user request reopens the remaining in-scope work. The [12-phase plan](../CLUB-ARENA-12-PHASE-AUDIT.md), [216-requirement register](2026-09-08-platform-coverage/phase-requirements.json) and [54 open Phase 3 acceptance records](2026-09-10-phase3-independent-acceptance.json) remain authoritative. Phases 1 and 2 have scoped completion evidence, with their cross-phase obligations preserved. The four-migration deployment and this tracking correction close no additional full control.
