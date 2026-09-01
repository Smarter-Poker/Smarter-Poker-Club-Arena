# Phase 3 Copy Release Recertification

## What The Audit Reopened

The Phase 3 Title Case release remained in current `main` and production, but
the current post-deploy certification was red. The route sweep itself passed
148 of 148 routes, including the Club Members route. Three fixture-backed
certifications failed because `cleanup_reserved_certification_account` tried
to delete `diamond_transactions` after that journal became append-only. The
first refusal left the rest of each temporary identity behind.

The existing follow-on copy-rule pull request also changed the engine restart
cron from one tick to three ticks per allowed window without updating the
source pin that asserts the exact schedule. That made the client suite red even
though the workflow and its documented intent agreed.

## What Changed

- The reserved-account cleanup now supplies the append-only trigger's required
  maintenance reference only after it locks the Auth row and proves the
  `ca-customization-cert-*@example.invalid` marker.
- The maintenance setting is transaction-local and includes the reserved user
  ID. It cannot authorize a later request or a non-certification identity.
- Browser roles remain revoked; only `service_role` may execute the cleanup.
- The earlier synthetic `audit_trail` cleanup remains in the replacement
  function, before the Auth row whose foreign key deliberately restricts
  deletion.
- A structural unit test pins transaction scope, validation order, the
  maintenance reference, retained audit cleanup, and the grants.
- The engine deployment schedule test now asserts all three `:00`, `:20`, and
  `:40` recovery ticks that the workflow deliberately declares.

## Copy Rule Coverage

The recertification reruns all four static copy gates: JSX and attribute copy,
painted strings, navigation registry strings, and forbidden UI characters.
The follow-on release expands the same rules to engine-provided copy and adds a
database copy gate, closing dynamic-message paths that a page-source scan alone
cannot see.

## Real-Time Law

No visible event, state transition, subscription, or polling path changed.
This release changes copy contracts, certification infrastructure, and a
service-only cleanup function.

## Verification

- Complete client release gate: pass, including TypeScript, house rules, all
  client tests, production build, and bundle budget.
- Complete server suite: 3,372 tests across 300 files passed; server build
  passed.
- Targeted final regressions: 44 tests passed.
- Production database copy gate: passed.
- Production cleanup function: audit cleanup follows journal cleanup, Auth
  cleanup follows audit cleanup, browser execution is denied, and
  `service_role` execution is allowed.
