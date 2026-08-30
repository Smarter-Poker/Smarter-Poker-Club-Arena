# Table Studio Commerce Certification

## Phase 1 Of 7

### Before

- `fn_purchase_feature` serialized and rejected a second receipt for the exact
  same feature.
- Table Studio also grants linked category entitlements when a complete theme
  is purchased.
- The purchase function did not consult that entitlement ledger. A client
  could therefore buy `studio:table_id:ice_cavern` after the Neon Ice preset
  had already granted `table_id:ice_cavern`, and be charged for an entitlement
  the account already owned.
- The component browser test mocked `fn_purchase_feature`. The production
  customization test exercised free designs only. No repeatable test proved a
  real server-priced debit, permanent receipt, entitlement delivery, second-
  device unlock, reload persistence, insufficient-balance refusal, or account
  isolation together.

### Build Plan

1. Make the database purchase guard entitlement-aware and serialize overlapping
   Table Studio purchases per account.
2. Add a production certification that creates isolated temporary players,
   uses real authenticated RPCs and real mobile browser sessions, verifies every
   currently sellable Table Studio SKU, and removes only the temporary fixtures
   in `finally` cleanup.
3. Pin the production workflow wiring and run focused unit, TypeScript, build,
   database, browser, and live-deployment verification before closing Phase 1.

### Safety

- No existing player account is funded, charged, or modified.
- Certification identities use a reserved `ca-customization-cert-*` prefix and
  are hard-deleted after each run.
- The service-role key remains in the Node test process and is never exposed to
  the browser page or application bundle.
- Cleanup refuses to operate on an identity outside the reserved prefix.

### Completed

- Installed an entitlement-aware `fn_purchase_feature` in production. Permanent
  customization purchases now share an account lock and check the canonical
  ownership predicate before any diamond debit.
- Added a destructive-safe certification harness that creates only reserved
  temporary accounts, removes onboarding VIP/promotional currency, funds the
  account through the real diamond ledger, and hard-cleans every fixture.
- Added a two-device mobile production test that queries the live catalog and
  bought all 60 currently sellable assets. It proved one charge per SKU, exact
  debit/receipt totals, entitlement delivery, no stale locks on the second
  device, live appearance updates, reload persistence, RLS isolation, and
  server refusal for insufficient funds or a mismatched user id.
- Proved the repaired overlap case: buying Neon Ice and then requesting its
  already-granted Ice Cavern felt returned `ownership_source: entitlement`,
  changed no balance, and created no duplicate receipt.
- The isolated production run passed on 2026-08-30 in 2.3 minutes and left no
  reserved Auth users or signup-error fixtures behind.
- Wired the certification into the post-publish production workflow and pinned
  that wiring with a source contract test.
- Repaired two malformed comments in the newly landed multi-table shell that
  were being parsed as CSS and emitted six production minifier warnings.
- Removed a placeholder-host assumption from the component browser mocks, so
  local Table Studio save and checkout coverage cannot escape to a configured
  Supabase project instead of exercising its isolated in-memory backend.
