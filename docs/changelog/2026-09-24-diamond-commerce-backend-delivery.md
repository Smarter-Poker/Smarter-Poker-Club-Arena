# Diamond Commerce Backend: Delivery Record

Date: 2026-09-24. Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), completion.
What shipped is described in
`2026-09-24-diamond-commerce-refunds-notices-catalog.md` and
`2026-09-24-diamond-commerce-admission-shadow.md`. This file records how it
reached production and what was read back.

## Pull request

- #5196, every required check green, squash-merged 2026-09-24 14:00:28 UTC as
  `113059a96824fa82823896f146474ed5adf63e7d`.
- The staff Commerce Desk and the owner page growth stay in #5193: with them
  the whole app measures 2,816 kB gz against the 2,800 kB ceiling (main
  2,794 kB). #5196 alone measured 2,795 kB.

## Client

- `Publish Club Arena` run 36009651551 for `113059a96` succeeded.
- `ca-static.smarter.poker/build-info.json` and
  `smarter.poker/hub/club-arena/build-info.json` both serve `113059a9`.
- The served chunk `ClubDiamondCostsPage-KZfhDDfF-v6.js` carries the new
  service (`capability_unavailable`, `refund_requires_service_route`,
  `fn_ca_commerce_refund_request`).

## Migrations

- `20260924102040`: the first two dispatches (runs 36010147293 at 14:04 and
  36010852514 at 14:10 UTC) were refused by the database, which does not let
  migrations run during a maintenance window: a "Deployment Recovery" window
  announced at 14:03 held the freeze until its thaw. Nothing was
  committed. Once `fn_entry_purchases_frozen()` read false, run 36011338391
  committed in 668 ms at 14:15:07 and recorded the version.
- `20260924102056`: run 36011474185 committed in 332 ms at 14:16:00 and
  recorded the version.

## Readback (14:17 UTC)

- All 65 function bodies (`fn_ca_commerce_*` and the seven wired doors) are
  md5-identical (`prosrc`) to the qualified build: Prompt 1's registry, then
  the four commerce migrations over the harness fixture.
- `admission_enforced_from` is NULL; 0 admission decisions; exactly seven
  functions call `fn_ca_commerce_admit`; anon cannot execute the shadow
  report and no browser role can execute the gate.
- Both insurance modules carry `platform_capability_id =
cash.insurance_ev_cashout` (readiness `deployed`). Three policy versions are
  recorded.
- 0 purchases, 0 trials.

## Staff action (decision 5)

At 14:17 UTC, `fn_ca_commerce_product_support('union_back_office', false)` and
`('union_insurance_module', false)` ran in service context. Both returned
`success`, with 0 open quotes withdrawn, and both products now read
`supported = false`. They return when a union admission point exists.

## Engine

The renewal, refund and notice consumer ships with the next successful engine
release. The engine is still `8825af51` (uptime about 5.7 days at 14:13 UTC);
the 14:03 recovery window ended without a new engine. The launch cohort stays
refused until the consumer's heartbeat is live, by design.
