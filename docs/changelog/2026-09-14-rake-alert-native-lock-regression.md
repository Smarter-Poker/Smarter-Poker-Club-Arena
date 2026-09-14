# Rake attribution alert regression

An actual September 6 tournament banked its 24-chip fee but hit a deadlock during player attribution. Its three players were attributed by the later repair pass. The installed authority now retries transient lock failures within its attribution subtransaction; an exact replay preserves the existing settlement.

The required PostgreSQL 17 job now executes the tracked preimage, guarded retry restoration and subsequent Diamond insertion. The resulting authority matches the production body `0e7baa1bfeb2a2d0fed749a52f32d520`. A real two-session row-lock cycle reproduces the original missing attribution and confirms the corrected call completes after one retry. The check also covers a real released lock timeout, four-attempt exhaustion, permanent errors, no-player-credit refusal, caller rollback, service access and unchanged exact replay.

The settlement authority and lane helper are actual repository definitions. Its financial callees are explicit local transaction recorders, so this test proves retry and rollback control, not accounting formulas or Diamond settlement. It complements the earlier 35-assertion native accounting proof in `docs/audits/2026-09-10-rake-attribution-retry-native.json`. It does not connect to production or install a migration.

Read-only production evidence on September 14 found the exact historical settlement attributed to all three players, 273 settlements in the preceding hour with none awaiting attribution, and no rake-attribution alerts in that hour. This is current observation, not a guarantee that future lock failures are impossible.
