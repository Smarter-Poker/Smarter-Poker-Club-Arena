# 2026-09-24: diamond commerce refunds, notices and catalog lifecycle

Assignment CA-DIAMOND-COMMERCE-2026-09-22 R2. Migration
`supabase/migrations/20260924102040_diamond_commerce_refunds_notices_and_catalog_lifecycle.sql`
builds on the installed base (`20260922143541`) and its fixes (`20260924033509`).
It replaces nine functions, each checked against its live body before the
replacement, and adds three tables. Nothing is debited or credited when it is
installed.

## What changed, and why

**Refunds (R2 6.4).** Before this change the exact-value core
`fn_ca_commerce_refund` could only be called by staff through a service route,
and owners had no way to ask for a refund. Now:

- Owners ask with `fn_ca_commerce_refund_request`. Only the payer can ask, so a
  sponsored purchase is refunded to the sponsor.
- The server works out the amount under refund policy version 1, which is kept
  in the new versioned `ca_commerce_policies` table:
  - a purchase made in error is refunded in full within 24 hours, unless a newer
    purchase has replaced it;
  - otherwise the unused whole days are refunded pro rata when the club or union
    closes, the service was unavailable, or staff find a platform defect;
  - the free month is never charged.
- A purchase line can have only one open request.
- A named platform admin approves or declines with `fn_ca_commerce_refund_decide`.
  Staff cannot decide their own request, and cannot approve more than the
  refundable remainder.
- The engine's commerce consumer pays each approved refund through the
  unchanged core with `fn_ca_commerce_execute_approved_refunds`. The request id
  is the core's request key, so each refund is paid exactly once.
- If the wallet cannot take the credit yet (the D64 balance limit), the request
  moves to `owed` with its reason. The payer is told once, and the same consumer
  tries again on every wake until the credit goes through. This is the owner of
  the obligation paying it when it can. It is not a repair job: no earlier live
  path owed or paid this money.
- The profile wallet guard is unchanged. The core still answers
  `refund_requires_service_route` to browser sessions.

**Consumer heartbeat.** `fn_ca_commerce_claim_due_renewals` now records
`ca_commerce_settings.consumer_heartbeat_at` on every call. The launch cohort
refuses with `consumer_not_running` unless that time is less than ten minutes
old: the reminders and renewals it creates would have no owner otherwise. The
cohort also sends each owner it enrols a Title Case notice with four facts:
the scope is free, the date the free month ends, nothing is charged unless they
authorize it, and they manage it under Club And Union Diamond Costs.

**Sponsored renewals (R2 5.2).** A sponsor can now authorize renewal of a right
their sponsorship paid for. The renewal is quoted through the sponsorship, so
the existing effectiveness, coverage and budget checks apply. The club owner
still gets `payer_required`, and a sponsorship that is revoked or out of budget
leaves the renewal in `needs_attention` without charging anyone.

**Notices (R2 4.1, 4.3).**

- When a price goes up, every payer with an authorized renewal on that product
  gets a notice. It gives the old price, the new price, the date and their
  ceiling.
- Each authorization of a renewal schedules one balance check for 72 hours before
  the due date. When the check comes due it compares the balance with that day's
  price. If the balance is short, the payer gets the shortfall and the deadline;
  if not, the check is marked suppressed and nothing is sent.

**Consent versioning (R2 5.4).** Each mandate now records the version of the
renewal terms and of the ceiling sentence the payer accepted. A mandate carried
forward to the next period keeps its original consent. Before this change, the
purchase boundary created the carried mandate again as if it were a new
acceptance.

**Catalog lifecycle (R2 7.3, 4.4).** A price now goes through these steps, and
each step writes an audit event:

1. `fn_ca_commerce_price_draft` creates a `draft`.
2. `fn_ca_commerce_price_validate` checks it: the price is positive, the rule fits
   the product, the cap is valid and the term is defined.
3. `fn_ca_commerce_price_publish` publishes it (unchanged, apart from the notices
   above).
4. `fn_ca_commerce_price_retire` retires it. Retirement only takes effect now or
   later, and never leaves a supported product with no price.

For price comparisons, staff record evidence with
`fn_ca_commerce_comparison_record`. A different staff member confirms it with
`fn_ca_commerce_comparison_verify`, and only that sets `comparison_verified`.

**Owner reads (R2 1.2, 7.2).**

- The scope status adds `balance_breakdown` (available, reserved and pending
  refunds, kept as separate figures) and the refund requests the reader can see.
- Receipts add their refund requests and the current state of each right,
  including how much of it can still be refunded.
- A former owner can still read the receipts they paid for. The new owner sees
  none of them.

## Evidence

- `python3 tests/sql/run-diamond-club-commerce-refunds.py`: 123 checks pass on
  base + fixes + this migration, in a private socket-only cluster.
- Every fix was also reverted one at a time. Each revert made the runner fail,
  either at its own check or at the migration's own post-condition or a table
  constraint.
- `python3 tests/sql/run-diamond-club-commerce.py`: unchanged, 155 pass on
  base + fixes.
- With this migration added to the base harness, all 155 still pass once a
  `fn_ca_commerce_price_validate` step follows each draft. A draft is no longer
  publishable directly.
- The consumer's unit tests cover the wake order (claim with heartbeat, then
  renewals, then refunds, then notices), freeze gating (refunds never run during
  the freeze; notices still do), lifecycle fencing and refused runs.

## Not done here

- **A partial refund does not shorten the right.** A pro-rata refund leaves the
  right in effect until its end, as the existing core does. Only a full return
  revokes it. Staff make that call when they decide.
- **"No rights used" is left to staff.** The server checks the 24-hour window and
  whether a newer purchase replaced the right. It shows `right_started` so the
  staff member can judge whether any rights were used.
