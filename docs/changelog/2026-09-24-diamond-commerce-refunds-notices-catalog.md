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

**Withdrawing a product stops its open quotes (D06).** Before this change,
`fn_ca_commerce_product_support(sku, false)` stopped new quotes for a product,
but a quote already taken stayed open and could still be bought. It now marks
every open quote whose lines contain that product `withdrawn`, in the same
transaction. The purchase boundary refuses such a quote as it refuses any
quote that is no longer open (`quote_expired`, requote) and charges nothing.
The audit event and the response carry `quotes_withdrawn`.

**Staff reads for the Commerce Desk.** `fn_ca_commerce_price_versions(p_sku)`
lists every price version, newest first. `fn_ca_commerce_comparison_list(p_sku)`
lists recorded comparison evidence with its recorder, its verifier and whether
it is verified. Both are for platform staff or the service role; anyone else
gets `staff_required`.

**Consumer steps are independent.** Renewals, refunds and notices each run in
their own error boundary. A failure in one step is recorded in
`status.stepErrors`, reported under that step's name, and does not stop the
other steps in the same wake. This covers the case where the refund door is
not installed yet, so the engine can be released before or after the
migration.

**Commerce sells only what the platform can do.** Prompt 1's capability
registry (`20260924025555`, contract
`docs/handoffs/club-arena-product-completion/CAPABILITY-CONTRACT.md` section 2)
says commerce must not sell, enable or advertise a capability that is not
available. Both insurance modules now name the capability they sell,
`cash.insurance_ev_cashout` (deployed today), in
`ca_commerce_products.platform_capability_id`. The quote refuses such a
product with `sku_not_available` (and the capability id) while
`fn_capability_available` says no. Every purchase, upgrade and renewal quotes
first, so none of them can charge for it either; a renewal meeting it stops at
`needs_attention` without a charge. Staff cannot mark it supported meanwhile
(`capability_unavailable`). The quote is amended by anchor insert, pinned to
its installed md5, so nothing else in it changes. Capacity, reports and assets
sell no capability of the registry. This migration now needs the registry
installed first (it is, since 2026-09-24 02:55 UTC).

**A late trial reminder tells the truth.** Reminders wait for the consumer,
which is not running yet. A reminder delivered late used to say "Ends In 9
Days" whatever was left, and one reached after the trial ended was still sent.
Delivery now reads the trial row: the title states the days actually left, and
a reminder for a trial that already ended is suppressed on record
(`trial_already_ended`), never sent.

## Evidence

- `python3 tests/sql/run-diamond-club-commerce-refunds.py`: 135 checks pass on
  base + fixes + this migration, in a private socket-only cluster.
- Every fix was also reverted one at a time. Each revert made the runner fail,
  either at its own check or at the migration's own post-condition or a table
  constraint.
- `python3 tests/sql/run-diamond-club-commerce.py` (Prompt 1's registry, then
  base + fixes + this migration, with a validate step after each draft): 159
  pass, including the capability refusal and restore through the registry's
  own writer, and the truthful and suppressed trial reminders.
- `tests/sql/run-diamond-club-commerce-admission.py`: 30 pass, including its
  159-scenario regression.
- The consumer's unit tests (14) cover the wake order (claim with heartbeat,
  then renewals, then refunds, then notices), freeze gating (refunds never run
  during the freeze; notices still do), lifecycle fencing, and each step failing
  on its own. All six step-isolation tests fail against the previous consumer.

## Not done here

- **A partial refund does not shorten the right.** A pro-rata refund leaves the
  right in effect until its end, as the existing core does. Only a full return
  revokes it. Staff make that call when they decide.
- **"No rights used" is left to staff.** The server checks the 24-hour window and
  whether a newer purchase replaced the right. It shows `right_started` so the
  staff member can judge whether any rights were used.
