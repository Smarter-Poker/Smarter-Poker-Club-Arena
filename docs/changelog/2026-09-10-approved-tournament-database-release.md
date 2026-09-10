# Approved Tournament Database Release

On 10 September 2026, the user explicitly approved four reviewed migrations for PokerIQ-Production (`kuklfnapbkmacvwxktbh`). All four applied successfully. They refuse cancellation after a tournament starts or commits awards, prevent conflicting finishing-place debt creation or increases, return an early refusal for missing elimination rank, and correct funded satellite seat counting and escrow components.

The existing deferred rank constraint remains enabled. The satellite correction preserves ticket redemption inflow. No historical balances were rewritten, no callers were added, and no canonical clock, accounting or exact-K Stage-B activation was performed.

| Production Ledger Version | Migration                                   |
| ------------------------- | ------------------------------------------- |
| 20260910171843            | Started Tournament Cancellation Guard       |
| 20260910171857            | Finishing-Place Debt Guard                  |
| 20260910171911            | Required Finishing Rank                     |
| 20260910171924            | Funded Satellite Seat And Escrow Correction |

The migration files use these actual ledger versions and contain the exact SQL approved in the archived candidates. The original file paths, archive commits and unchanged SHA-256 values are mapped in the [deployment evidence](../audits/2026-09-10-approved-database-deployment.json).

Production verification at 17:20:23 UTC matched all six changed function bodies, all ten inspected function metadata records, four unchanged dependency bodies, both unchanged triggers and all four ledger SQL hashes. Two independent reviewers also confirmed the installed definitions and authority. Security advisors returned no finding naming the changed or pinned functions; global findings are recorded without claiming they were introduced or resolved by this release.

The reviewed native proof contains 14 cancellation groups, 11 obligation groups, 7 elimination groups and 24 funded satellite checks with 5 observed lock waits. Existing baseline evidence remains preserved. Production economic functions were not invoked to test the changes.

This PR records the already-applied SQL and deployment evidence on main. It does not reapply the migrations. The wider audit remains Phase 3 of 12, with 4 of 58 controls fully verified. The [current-work inventory](../audits/2026-09-10-current-work-closeout.md) records remaining activation requirements.
