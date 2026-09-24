# Shared Interface With Prompt 1 (R2 Section 1.6, Line 1011)

Version 3, 2026-09-24. The small versioned contract between the diamond
commerce boundary (this assignment, the consumer) and Prompt 1's technical
platform (the owner of capabilities and accepted events). Prompt 1's side is
`docs/handoffs/club-arena-product-completion/CAPABILITY-CONTRACT.md` and
`supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql`;
this file says what commerce does with it. Nothing here is a promise of
behaviour the code does not have.

Version 1 (earlier the same day) was written before Prompt 1's registry
existed and named only commerce's own product keys. Version 2 maps them onto
the registry and adds the accepted-event reference. Version 3 (migration
`20260924182605`) adds the readiness fields the catalog now returns and the
private capacity products written quotes create.

## 1. Two kinds of id, and how they meet

Prompt 1 owns **technical capability ids** (`cash.insurance_ev_cashout`,
`club.membership_cap`, ...), with a readiness ladder; "available" means
`deployed` or `production_verified`. Commerce owns **commercial product
capability keys** (`ca_commerce_products.capability_id`, migration
`20260922143541`) and SKUs. A product that sells a technical capability names
it in `ca_commerce_products.platform_capability_id` (migration
`20260924102040`).

| Commerce capability key                  | Scope | SKUs                                  | Sells platform capability     | Sold now                                       |
| ---------------------------------------- | ----- | ------------------------------------- | ----------------------------- | ---------------------------------------------- |
| `club.capacity`                          | club  | `capacity_60` ... `capacity_2500`     | none (commercial roster size) | yes                                            |
| `club.insurance_module`                  | club  | `club_insurance_module`               | `cash.insurance_ev_cashout`   | yes, while that capability is available        |
| `union.back_office`                      | union | `union_back_office`                   | none                          | withdrawn until a union admission point exists |
| `union.insurance_module`                 | union | `union_insurance_module`              | `cash.insurance_ev_cashout`   | withdrawn until a union admission point exists |
| `club.report_export`, `club.report_pack` | club  | `report_export_7d`, `report_pack_30d` | none                          | no (`unsupported-offerings.md`)                |
| `club.asset.*`                           | club  | the five `asset_*` SKUs               | none                          | no                                             |

A written quote above 2,500 members creates a private `club.capacity` product
(`capacity_wq_<hex>`, `private_scope_kind`/`private_scope_id` naming the one
club, `written_quote_id` naming the quote). It sells no platform capability
and is visible and quotable only for that club and platform staff.

`club.membership_cap` (Prompt 1) is the per-player limit on how many clubs one
account may join. It is not club capacity and commerce never sells it.
`variant.ofc` is excluded and never sold, listed or bundled.

## 2. Readiness: commerce sells only what is available (contract section 2)

- `fn_ca_commerce_quote` refuses a product whose `platform_capability_id` is
  not available (`sku_not_available`, with `capability`). Every purchase,
  upgrade and renewal quotes first, so none can charge for it; a renewal
  meeting it stops at `needs_attention` without a charge.
- `fn_ca_commerce_product_support(sku, true)` refuses `capability_unavailable`
  for such a product.
- `fn_ca_commerce_catalog` returns, per product, `platform_capability_id` and
  `platform_available` (the answer of `fn_capability_available`), so the
  owner page offers the insurance module only while it is available.
- Commerce never writes readiness. A capability moves only through
  `fn_set_capability_readiness`.

Pinned by `tests/sql/run-diamond-club-commerce.py` (`CAP` checks), which
installs Prompt 1's real migration first and steps the capability down and
back through its writer.

## 3. Entitlement query

`fn_ca_commerce_scope_status(p_scope_kind, p_scope_id)` returns the scope's
effective rights (`entitlements[]`: `sku`, `kind`, `capacity`, `quantity`,
`starts_at`, `ends_at`, `source` of `trial`, `purchase`, `renewal`, `sponsor`
or `upgrade`, and the renewal mandate if any) and the trial. Readers need an
owner or admin role on the scope, or platform staff.

## 4. Admission decision

Server side, the admission doors call
`fn_ca_commerce_admit(p_scope_kind, p_scope_id, p_action, p_door, p_subject)`
(migration `20260924102056`). It records the decision in
`ca_commerce_admission_decisions` and returns `allowed`, `would_allow`,
`enforced`, `reason` and a Title Case `message`.

| Action              | Checks                          | Doors wired                                                                   |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `approve_member`    | roster against `club.capacity`  | `fn_review_join_request`, `fn_agent_attach_player`                            |
| `join_member`       | roster against `club.capacity`  | `fn_join_club` (clubs that admit automatically), `fn_redeem_club_invite_code` |
| `open_table`        | `club.capacity` right in effect | `fn_cash_game_create`                                                         |
| `create_tournament` | `club.capacity` right in effect | `fn_create_tournament`, `fn_upsert_tournament_schedule` (new schedules only)  |
| `club_insurance`    | `club.insurance_module`         | `fn_cash_game_create` when insurance is enabled                               |
| `union_tools`       | `union.back_office`             | none yet                                                                      |
| `union_insurance`   | `union.insurance_module`        | none yet                                                                      |

Enforcement is off until `ca_commerce_settings.admission_enforced_from` is set
and passed. While off, `allowed` is always true and `would_allow` carries the
real answer. The browser read `fn_ca_commerce_admission` answers only owners
and administrators of the scope, or platform staff;
`fn_ca_commerce_admission_report` gives staff the per-door and per-club
shadow totals.

## 5. Accepted events (contract sections 4 and 5)

- **Rule 1, continuation.** Admission never checks an existing event: only a
  new member, table, tournament, schedule or insurance offer. Seating,
  registration, rebuys, stages, payouts and settlement of an accepted event
  never consult commerce, so an accepted event runs through its conclusion
  whatever happens to the trial or renewal. Commerce needs no call to
  `fn_event_continuation` for that.
- **Rule 2.** Commerce never creates an event on the basis of continuation.
- **Rule 4, the basis.** `fn_create_tournament` records commerce's reference
  on the event's acceptance record through the internal
  `fn_ca_commerce_record_event_basis`: `authorization_basis` becomes
  `{operator_access: 'commerce_shadow' | 'commerce', recorded_by:
'commerce_admission', scope_kind, scope_id, action, would_allow, reason,
entitlement_id, trial, policy_version, accepted_basis}`, where
  `accepted_basis` is the acceptance trigger's own basis, kept. It replaces
  only a basis the trigger wrote, and it never raises. Tournaments the
  scheduled spawner or the engine creates keep `legacy_free`.

## 6. Commerce's own event identity

A committed purchase is `ca_commerce_purchases.id`; its debit is
`diamond_tx_id` (the journal row, reference `ca-commerce:<id>`) and
`mint_op_id` (the Mint register retirement). A renewal is the purchase the
consumer commits for a mandate, request key `renewal:<mandate_id>:<due_at>`.
A refund is `ca_commerce_refunds.id`; a requested refund is
`ca_commerce_refund_requests.id`, which is the refund's request key. These ids
never change.

## Versioning

This file is version 3. A change to any function signature, action name,
capability key or mapping above is a new version of this file in the same pull
request as the change, and a change on Prompt 1's side is read from
`CAPABILITY-CONTRACT.md`, never assumed.
