# Cashier Phase 5: Production Certification And Operations

## What Shipped

- Added privacy-safe cashier operation telemetry for roster page latency and
  batch send/ticket outcomes. Failures are retained; routine successes are
  sampled. Amounts, recipients, notes, and free-form error messages are never
  stored.
- Added service-role-only hourly health and daily failure views, insert-only
  authenticated RLS, bounded fields, and a 30-day retention function.
- Added a post-deploy database canary that verifies the applied migration
  versions, exact money-function hashes, SECURITY DEFINER/search-path posture,
  execution ACLs, cashier RLS policies, browser balance triggers, performance
  indexes, and telemetry access rules.
- Added a transaction-rolled-back authenticated RLS probe that exercises the
  telemetry insert using the same JWT role shape as the browser.
- Added a dedicated authenticated production Playwright assertion for the real
  club cashier route. It proves the redesigned Trade surface is mounted and the
  first visible tab, never the second, is selected on entry.

## Release Gates

- Migration `20260831235992_cashier_operational_telemetry.sql` must exist in the
  live migration ledger before merge.
- `scripts/verification-harness/cashier-release-contract.sql` and
  `cashier-telemetry-rls.sql` must pass against production.
- The post-deploy workflow must run both database canaries and
  `production-cashier.spec.ts` after every successful Club Arena publication.
