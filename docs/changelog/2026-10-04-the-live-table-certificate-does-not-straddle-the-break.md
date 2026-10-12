# The live-table certificate does not start into the next break (2026-10-04)

`Post-Deploy E2E`, run 37241065892, `Live-table and engine verification`: once failures were annotated (#6097, #6103), all three were the hourly break, not production.

- Two cases: "production engine is in scheduled maintenance (last_hand)".
- The SPIN case: no poker event for 45 s after the hand that ended at 22:53:04Z (`hand_history` for table 470f6e8d: the next hand 23:00:33Z, i.e. parked for the break and resumed on schedule).

The cases started at about 22:47Z; the break is announced at :53.

`scripts/ci/await-engine-gameplay.mjs` now refuses to start a certificate with less than 15 minutes (`CERTIFICATE_LEAD_MS`) before the next :53 announcement. It waits for that break and then, as before, for the exact engine to resume every table. The announcement minute is derived from `BREAK_START_MINUTE` and `LAST_HAND_LEAD_MS` in `MaintenanceBreak.ts`, and `tests/await-engine-gameplay.test.ts` reads both from the engine source. Only the CLI passes the wall clock, so library callers keep the old behaviour. The job's `timeout-minutes` grows from 60 to 76 for the longest pre-wait.
