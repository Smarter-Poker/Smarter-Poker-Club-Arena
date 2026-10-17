# Diamond board bootstrap migration disposition

## DA24: the retired board bootstrap must not be replayed

Trusted Migration Ledger run39004996148 failed after the old20261016042047 bootstrap passed its24-hour grace. That file inserts the original25 templates per club and asserts exactly50 active rows. The serving engine9ccf3e42 owns the current26-template board in `fixedBoard.ts` and `syncFixedBoard`; both files are byte-identical to this candidate. Read-only production has26 distinct active templates per club,52 total. The bootstrap has no corresponding history record under its source version/name, and no fixedBoard SQL was found in the earlier20261016 installation window. Its old50-row assertion is not a statement of today's owner-directed timetable.

Replacement migration20261016182049 is recorded with name `the_hard_coded_board_and_the_weekly_events_keep_chicago_time`, bodyMD51382705956097acbfe1a41d82bb15200. Its installed board ownership guard has MD5a3c21621b4ccda762d938a13b58d7db1; the live trigger exists and zero active timed schedules in either club lack a time zone (05:21:41UTC). Together with the serving engine-owned board, this supersedes the one-shot bootstrap.

Record that specific retirement in the maintained superseded registry, naming20261016182049 and the evidence. Preserve the old SQL byte for byte, including its50-row assertion; do not rerun it, change live schedules/prices, fabricate installation history or weaken the ledger checker. A regression pins the specific disposition, the untouched historical source SHA256 and the replacement ownership contract. The trusted ledger reads default-branch code only, so its hosted correction must be verified after protected integration. This metadata repair changes no runtime or database records.

Local qualification: the disposition test fails before the registry entry (1 failure,15 passes), then16 ledger-law tests and the existing board-owner suite pass.991 source-binding pins remain exact. This is a metadata-only correction; production data and immutable historical SQL are unchanged.
