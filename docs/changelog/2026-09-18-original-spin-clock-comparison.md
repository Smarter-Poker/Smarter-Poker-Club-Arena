# Original Spin closure and elapsed clock metadata

The five named September 8 Spins could not complete after their clocks advanced: the original-standing guard compared the stored level-start timestamp and clock index with the captured witness. Production readback found only those two fields changed; original hands, ranks, prizes, fees, blind amounts and physical evidence still matched.

The additive migration excludes exactly `tournament.level_started_at` and `tournament.blind_level_state.index` from that comparison. It preserves the immutable witness, exact manager identity, operation replay, all monetary and physical guards, and the original terminal transaction. It refuses installation unless the current function definition, owner, permissions and settings match the reviewed predecessor.

The existing native PostgreSQL qualification reproduced three old clock-only failures, then completed all five original cases with elapsed clocks, two concurrent first-completion races and ten actual decoded receipts. Changed big blind, small blind and ante still refuse without writes; changed installer authority refuses atomically. All 160 financial assertions passed. This is isolated qualification, not production payment or installation evidence.
