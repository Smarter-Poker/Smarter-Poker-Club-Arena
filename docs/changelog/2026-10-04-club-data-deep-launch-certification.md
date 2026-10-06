# 2026-10-04 - Club Data Deep Launch Certification

## Changed

- Kept the Club Data ledger available when the club-name lookup fails and made the read failure visible instead of presenting an empty success state.
- Replaced the capped Financial Admin rake read with `ca_financial_admin_revenue_series`, which returns seven complete UTC days from both cash rake and tournament fees with exact period totals, authorization, contract metadata and freshness data.
- Bound shared Stats results to the exact user, asset, club, range and timezone request so a late response cannot paint figures from a previous scope. Invalid or missing club routes now replace browser history instead of creating a back-navigation trap.
- Made Bomb Pot and Insurance CSV exports await the native download result, report current-scope failures, and ignore stale or unmounted completions.
- Extended the production mobile certification to Data, Stats, Rate Audit and Settlement History, including route readiness, real settlement data and 44px interactive controls.
- Added one maintained PostgreSQL 17 wrapper for the nine Data console fixtures and wired it into CI classification and the accounting shard. The cash-native integrity manifest records the additive workflow and classifier changes.
- Removed the unused `tests/e2e-page-load-audit.ts` file, which was excluded from both Vitest and Playwright and had no caller.

## Verification

- Focused Data and Stats tests, changed-source and changed-test suites, type checking, linting, source bindings, schema guards, migration uniqueness, stats budgets and a clean production build passed on the exact candidate.
- All nine isolated PostgreSQL 17 Data fixtures passed, including authorization, grants, complete-day coverage, more than 5,000 cash rows, tournament fees, fractional values, zero days and exact raw conservation.
- Production installation, protected merge, publication provenance and signed-in production behavior remain release evidence, not source claims, and are recorded in the task checkpoint.

## Deliberately Not Changed

- No engine source or engine contract changed, so this delivery does not require an engine activation.
- No production financial data, player chips or active games were used as test fixtures.
- Existing route structure and the approved Club Arena cinematic visual authorities remain intact.
