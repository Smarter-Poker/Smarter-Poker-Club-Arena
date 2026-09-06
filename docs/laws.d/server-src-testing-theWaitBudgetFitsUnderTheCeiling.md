# server/src/testing/theWaitBudgetFitsUnderTheCeiling.law.test.ts

A wall-clock wait in the server suite budgets strictly less than `testTimeout`, with at least 5s of headroom, and both numbers come from `src/testing/waitBudget.ts` rather than being restated. Two tests had independently de-flaked a fixed sleep into a conditional wait and both picked `10_000` — the same value as the ceiling — so vitest killed the wait at the instant it would have given up and CI printed "Test timed out in 10000ms" naming nothing; that cost PR #3272 three pushes with no local reproduction (2026-09-06).
