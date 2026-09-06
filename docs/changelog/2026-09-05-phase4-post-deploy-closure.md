# Phase 4 Post-Deploy Certification Closure

The first fully isolated production run proved the Cashier contract and its
authenticated browser suite, then exposed four defects in the surrounding
certification harness. This closure keeps those failures observable while
removing assumptions that were no longer true for a brand-new normal member.

## Closed

- Global setup now dismisses the fixture club's first-entry message through
  its real UI control, verifies the dismissal RPC, and only then captures the
  browser state reused by the lobby suite.
- Club Data now certifies the exact server-backed role decision. A normal
  member must receive the finance permission gate; authorized accounts still
  run the deep interaction, responsive, heartbeat, and accessibility checks.
- Union routes and navigation now certify the private allowlist instead of
  expecting the reserved normal-member account to see Dan-only controls.
- The reduced-motion mobile card check reuses the already prepared page and
  live CSS, removing a duplicate production download and browser context.
- Post-deploy account cleanup uses the exact-marker
  `cleanup_reserved_certification_account` RPC. The current-schema revision
  deletes trigger-bearing membership rows while the identity still exists,
  clears rate-limit and transient rows, preserves transaction-local journal
  maintenance, and verifies the Auth identity is gone.

## Database

`20260906015012_reserved_certification_cleanup_tracks_current_schema.sql` was
applied to production as one migration. Its hard guard only accepts locked
identities matching `ca-customization-cert-%@example.invalid`, and
the service-role-only grant remains intact.

## Verification Contract

Phase 4 is not complete merely because the targeted Cashier suite is green.
The post-deploy workflow must also provision the isolated account, run the
Cashier database and browser contracts, complete the broader production sweep,
pass its anti-skip honesty check, and hard-delete the account.
