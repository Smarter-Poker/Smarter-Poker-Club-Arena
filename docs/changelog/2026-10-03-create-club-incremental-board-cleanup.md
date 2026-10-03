# Create Club Incremental Board Cleanup

## Problem

The reserved production Create Club certificate can be interrupted while the
bounded Spin/SNG board controller has created only part of its twelve-game
starter board. Those one-through-eleven rows are a valid pristine State-A
fixture, but the cleanup helpers had inherited the post-reset State-B rule
that permits only zero or twelve rows. Certification therefore stopped at
`WELCOME_CERTIFICATION_BOARD_LEASE_LINEAGE_REFUSED` before it could retire its
own exact unused fixture.

## Correction

- Restore the unique allowlisted subset rule for only the three State-A board
  cleanup helpers: matched count must equal distinct slot count and may not
  exceed twelve.
- Keep the post-reset State-B helper strictly zero-or-twelve.
- Bind each source rewrite to its exact preimage and postimage digest, make the
  migration replay-safe, and reassert the private catalog and ACL contract.
- Preserve the existing lease freshness, protocol-v2, F06 custody, prelaunch
  origin, zero-activity, delete-permit, reserved-identity, and financial
  retirement safeguards.

## Verification

- The isolated PostgreSQL 17 harness now creates a five-row exact State-A
  board with matching waiting tables, prelaunch origins, and stale engine
  leases, then proves all five rows and the 100,000-chip certificate fixture
  retire completely.
- The same harness replays the migration and retains the existing partial
  State-B refusal test.
- The source contract pins all six function-body digests, both rewrite states,
  the unchanged State-B rule, timeouts, ACL/catalog shape, and retained safety
  markers.

No real club, union, player, horse, wallet, game, or chip balance is selected
for mutation by this correction.
