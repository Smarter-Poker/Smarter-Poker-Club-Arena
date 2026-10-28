# Accounting identity uses the maintained job ceiling

PR 8289 already increases the hosted accounting ceiling to 50 minutes based on failed run 40528107352 and successful comparable Spin run 40520906517. The BBJ identity reader still declared 40 minutes, so its current-workflow assertion stopped the funded qualification before executing cases. Align the reader and exact-boundary fixtures with that existing 50-minute job. The original 300-second case ceiling, 90-second cleanup reserve, actual provider start time, and refusal when time is insufficient remain unchanged.

Validation: all 35 current identity regressions and the existing CI job-identity contract. No production database mutation or financial case was replayed locally.
