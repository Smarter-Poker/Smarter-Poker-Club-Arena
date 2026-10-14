# Post-Deploy E2E: the template club fixture waits out the hourly freeze (2026-10-14)

Run 38641820985 (main 09022d8a) failed 9+ Table Management certificates with
"refused game management on the standalone reserved club".

Cause, read from the job log: `prepare-template-staff` opened inside the :55
maintenance break. Creating the `Crest Cert Template` club inserts into
`chip_transactions`, which the freeze trigger refuses ("PLATFORM_FROZEN").
The step failed, `E2E_TEMPLATE_CLUB_ID` was never exported, and the specs fell
back to the default club 2a1132b9, which has since joined Midway Union.

Fix: `prepareProductionE2ETemplateFixture` now treats a freeze refusal of the
rolled-back qualification or of the creation call as "wait for the thaw" (the
same `waitOutPlatformFreeze` the cleanup paths use, at most two freezes), then
retries the same request id. Both calls are single transactions, so a refusal
committed nothing. Pinned by a unit test in `tests/unit/productionE2EAccount.test.ts`.
