# 2026-08-31 — Leaderboard Phase 2 Release Gate

The post-publication audit found defects in owner recovery paths, custom-plan
math, modal navigation, and database defense in depth. This pass closes them
before Phase 3 begins.

## Product And Reliability Fixes

- The published-program **Review Setup** action now snapshots the loaded setup
  before opening the wizard instead of opening an empty modal state.
- Settings and owner-context failures are visible and retryable. A transient
  owner-tools failure no longer erases otherwise valid club memberships.
- Confirmed logout and account changes clear the wizard; hydration does not.
- The hamburger deep link is consumed after opening and can be used repeatedly.
- Custom budget changes now rescale the submitted prize rows, including exact,
  non-negative cent apportionment for tiny budgets.
- The disabled-plan Back path returns to the decision step.
- Step focus, `aria-current`, body scroll locking, short-view height, and the
  fixed footer make the wizard usable with keyboards and small viewports.
- All browser numeric paths reject non-finite and oversized values.

## Database And Release Hardening

- Prize JSON now rejects nulls, strings, extra fields, duplicate ranks,
  out-of-range ranks, and invalid amounts at the server boundary.
- One canonical fail-closed resolver determines union versus standalone club
  funding; owner-context work is scoped before the resolver runs.
- An operation UUID is permanently bound to its exact publication intent.
- Browser roles no longer hold direct settings or version-table write grants.
- The funding foreign key now uses `ON DELETE RESTRICT`, consistent with the
  funding-scope constraint, and all four reward foreign keys have covering
  indexes.
- The production wallet-authority helper is replayable from migration source.
- A blocking CI gate rejects every newly introduced duplicate migration
  version. Historical deployed migrations remain immutable.

## Verification Contract

The production behavior harness always runs inside `BEGIN`/`ROLLBACK`. It
checks union-funded and standalone-club-funded publication, exact retry
idempotency, stale and unauthorized rejection, immutable published programs,
canonical period activation, hostile JSON, and browser grants. When production
has no standalone club, the harness creates a temporary club inside the same
transaction and proves afterwards that zero fixture rows remain.

Money movement: **none**. Automated payout settlement remains outside Phase 2.
