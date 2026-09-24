# Shared Interface For Prompt 1 (R2 Section 1.6, Line 1011)

Version 1, 2026-09-24. This is the small versioned contract between the
diamond commerce boundary (this assignment) and the operating-capability work
(Prompt 1). It describes what exists in the installed migrations and the
completion branch. Nothing here is a promise of behaviour the code does not
have.

## 1. Capability IDs

Every product carries one `capability_id` (`ca_commerce_products`, migration
`20260922143541`, lines 446-462). The ID is the key Prompt 1 uses for a
capability; the SKU is the commercial offering of it.

| Capability ID                                                                                              | Scope | Offered by SKUs                                                                                 | Sold now                                       |
| ---------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `club.capacity`                                                                                            | club  | `capacity_60`, `capacity_100`, `capacity_250`, `capacity_500`, `capacity_1000`, `capacity_2500` | yes                                            |
| `club.insurance_module`                                                                                    | club  | `club_insurance_module`                                                                         | yes                                            |
| `union.back_office`                                                                                        | union | `union_back_office`                                                                             | withdrawn until a union admission point exists |
| `union.insurance_module`                                                                                   | union | `union_insurance_module`                                                                        | withdrawn until a union admission point exists |
| `club.report_export`                                                                                       | club  | `report_export_7d`                                                                              | no (`unsupported-offerings.md`)                |
| `club.report_pack`                                                                                         | club  | `report_pack_30d`                                                                               | no                                             |
| `club.asset.cover`, `club.asset.background`, `club.asset.felt`, `club.asset.theme`, `club.asset.card_back` | club  | the five `asset_*` SKUs                                                                         | no                                             |

## 2. Readiness

`fn_ca_commerce_catalog(p_scope_kind)` returns each product with `supported`
and its published price. A capability is ready to sell when its product is
`supported` and has a published price in effect.

## 3. Entitlement query

`fn_ca_commerce_scope_status(p_scope_kind, p_scope_id)` returns the scope's
effective rights (`entitlements[]`: `sku`, `kind`, `capacity`, `quantity`,
`starts_at`, `ends_at`, `source` of `trial`, `purchase`, `renewal`, `sponsor`
or `upgrade`, and the renewal mandate if any) and the trial. Readers need an
owner or admin role on the scope, or platform staff.

## 4. Admission decision

Server side, owner-initiated actions call
`fn_ca_commerce_admit(p_scope_kind, p_scope_id, p_action, p_door, p_subject)`
(migration `20260924102056`). It records the decision in
`ca_commerce_admission_decisions` and returns `allowed`, `would_allow`,
`enforced`, `reason` and a Title Case `message`.

| Action              | Capability checked                        | Door wired today                                                             |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `approve_member`    | `club.capacity` (roster against capacity) | `fn_review_join_request`                                                     |
| `open_table`        | `club.capacity`                           | `fn_cash_game_create`                                                        |
| `create_tournament` | `club.capacity`                           | `fn_create_tournament`, `fn_upsert_tournament_schedule` (new schedules only) |
| `club_insurance`    | `club.insurance_module`                   | `fn_cash_game_create` when insurance is enabled                              |
| `union_tools`       | `union.back_office`                       | none yet                                                                     |
| `union_insurance`   | `union.insurance_module`                  | none yet                                                                     |

Enforcement is off until `ca_commerce_settings.admission_enforced_from` is set
and passed. While off, `allowed` is always true and `would_allow` carries the
real answer. The browser read `fn_ca_commerce_admission` answers only owners
and administrators of the scope, or platform staff.

## 5. Accepted-event identity

A committed purchase is identified by `ca_commerce_purchases.id`, and its
debit by `diamond_tx_id` (the journal row, reference `ca-commerce:<id>`) and
`mint_op_id` (the Mint register retirement). A renewal is the purchase the
consumer commits for a mandate; its request key is
`renewal:<mandate_id>:<due_at>`. A refund is `ca_commerce_refunds.id`, and a
requested refund is `ca_commerce_refund_requests.id`, whose id is the refund's
request key. These IDs never change and are safe for Prompt 1 to store.

## 6. Continuation decision

What a right lapsing does and does not stop (R2 1137, the published boundary
in `docs/changelog/2026-09-24-diamond-commerce-admission-shadow.md`):

- Existing obligations continue: approved members, running tables,
  created and scheduled tournaments, seated players, hands, buy-ins, payouts
  and settlements are never gated.
- Only new owner-initiated admissions are decided: a new member approval, a
  new table, a new tournament or schedule, insurance on a new table.
- Nothing in the betting, dealing, seating, payout or settlement path consults
  commerce.

## Versioning

This file is version 1. A change to any function signature, action name or
capability ID above is a new version of this file in the same pull request
as the change.
