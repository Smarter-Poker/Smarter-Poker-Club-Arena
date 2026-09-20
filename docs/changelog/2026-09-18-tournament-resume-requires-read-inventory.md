# Tournament resume requires readable inventory

Tournament resume discarded database errors when loading tables and counting live entrants. A failed inventory read could be treated as an empty tournament, trigger a rebuild, or start the level clock and scheduler without proven table admission. An unknown entrant count was also treated as zero.

`TournamentManagerBase.resumeLifecycle` now refuses a table-query error or unreadable inventory before admission. For a confirmed empty inventory, it requires an error-free, nonnegative safe-integer entrant count before rebuilding or continuing. Refusal uses the existing lifecycle failure path. Confirmed empty inventory with zero entrants retains its existing behavior; a positive count still uses the existing rebuild.

Validation on base `27910f933f3e545ded26eb12ab4d576c4e6c9366`:

- `cd server && ./node_modules/.bin/vitest run src/tournament/ResumeCurrentStatus.test.ts`: the new cases produced **11 failures and 18 passes before the repair**, then **29 passes after the repair**. Coverage includes errors with partial data, unreadable inventory/counts, and valid empty/populated behavior.
- `./node_modules/.bin/tsc --noEmit -p server/tsconfig.json`: passed.
- Scoped `git diff --check`: passed.

This is local source and regression evidence. It does not establish the cause of the observed production lease churn, prove that churn is fixed, or claim deployment or production verification.
