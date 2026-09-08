# BBJ Applied Share Confirmation

The applied payout path coerced arbitrary values with Number() and published them as paid. Missing, negative, non-finite and fractional-cent amounts could close a pending claim and produce incorrect completion data or notifications. It also accepted component shares that did not equal the total and an applied response without a payout identifier.

The existing Main/Mini attempt path now validates all five amount fields as nonnegative safe cent values, accepts PostgreSQL decimal strings, requires component shares to equal the total in cents, and requires a nonempty applied payout identifier. Validation runs before notifications and before the caller settles its pending claim. Invalid receipts use the existing recovery path; no new worker or reconciler was added.

## Evidence

The actual payout module reproduced 42 failing cases before correction, with 30 controls passing. After correction, server TypeScript and the full 6,874-test suite across 482 files pass. Tests cover each amount field, one-cent total disagreement, missing payout identity and valid decimal-string responses.

No database schema or production financial data was changed. This establishes receipt validation and engine control flow, not proof that every recipient was credited. It does not validate recipient rows against the award, reconcile per-player rounding, strengthen replay receipts, or prove that a nonempty payout identifier belongs to this hand. Parked recipient notifications and durable queue confirmation remain open.

Read-only runtime check at September 8, 2026 12:27:54 UTC: engine e692442a, status ok, zero stalled tables. Static-origin build-info timed out and the WorldHub build-info route returned HTTP 502. Neither response proves a deployed frontend version; source test success is not deployment success. Full audit remains incomplete.
