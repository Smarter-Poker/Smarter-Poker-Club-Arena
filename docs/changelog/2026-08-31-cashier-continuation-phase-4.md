# Cashier Continuation Phase 4 Of 10: Operational Resilience And Receipts

## Program Map

The earlier request to define a ten-phase continuation ended before a plan was
published. This file is the durable phase contract for the remaining work.

1. Ledger correctness and conserved money paths — complete
2. Authorization, hierarchy, and audit contracts — complete
3. Roster, ledger, and batch performance — complete
4. Operational resilience, recovery, and transaction receipts — this release
5. Cross-wallet statements, export, and date-range reporting — pending
6. Real-time cashier queue events and notification escalation — pending
7. Reconciliation analytics and anomaly investigation tools — pending
8. Internationalization, accessibility, and advanced mobile ergonomics — pending
9. Enforced performance budgets and degraded-network optimization — pending
10. Full production certification, rollback drill, and final zero-gap audit — pending

The previously shipped wallet directory/mobile launcher and production telemetry
remain prerequisites across this continuation; they are not being relabeled or
recounted here.

## What Existed

- Each failed data region had its own Retry button, but there was no single
  operator action that revalidated balances, authority, request counts, ticket
  counts, and the active record surface.
- Browser connectivity was not represented. A disconnected operator could open
  every money modal and only learn about the outage after submission.
- Partial batch failures were rendered only inside the amount modal. Closing it
  removed the recovery signal even though the retained idempotency keys still
  represented an unresolved intent.
- Trade ledger rows displayed a summary but could not be opened as a receipt or
  copied with the immutable transaction reference.

## What Changed

- Added online/offline event handling. All five Cashier mutation families now
  enforce the same connection guard, their controls disable while offline, and
  an already-open Club Bank Cashier closes when connectivity drops. Server-side
  authorization remains final; browser connectivity is only a safety gate.
- Added a #SmarterCasinoRealism reconciliation console with connection state,
  last successful balance verification, pending-action counts, and one
  `Reconcile Now` control. The timestamp advances only after the role, balance,
  wallet, and complete authorized roster load succeeds.
- Added a durable partial-batch recovery card. It preserves the original amount,
  recipients, per-target failures, and retry keys after the modal closes, then
  reopens the exact unchanged intent for an idempotent retry.
- Converted Trade Ledger rows into keyboard-accessible receipt controls. The
  receipt shows direction, amount, status, counterparty, entry type, recorded
  time, and the full immutable transaction reference, with clipboard fallback
  for older browsers.
- Added responsive 375px layouts for the console, alert, and receipt while
  retaining the Cashier's black-first vault, gunmetal, electric-blue visual
  language.

## Verification Contract

- `tests/cashier-phase4-ops-resilience.test.ts` proves the receipt text contract,
  all mutation guards, reconciliation freshness, durable batch recovery, and
  responsive receipt surface.
- Client typecheck, Cashier-focused tests, the full client suite, production
  build, protected CI, publication, and an authenticated production cold-load
  must pass before this phase can be called complete.

Real-time law: browser `online` and `offline` events and existing named
`MasterBus` balance events trigger the visible state; no snapshot diff or
polling interval was added.
