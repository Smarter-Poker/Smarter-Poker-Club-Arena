# 2026-10-02 - A chip shop refund names where its chips come from

Chip-drift launch plan, phase 1 (no silent money failures). Migration
`20261002165749_a_chip_shop_refund_names_where_its_chips_come_from.sql`, law
`tests/a-chip-shop-refund-names-where-its-chips-come-from.law.test.ts`.

## The gap

`20261002140203` (every money path declares its counterparty) guarded
`fn_credit_chips`: an undeclared caller is refused by name instead of being
journalled against `settlement_suspense`. Its changelog listed
`fn_refund_shop_purchase` as an undeclared caller that "will refuse by name".
That is the chip branch of the owner/admin refund door (World Hub
`pages/api/club-arena/refund-purchase.js`), so a chip refund reaching the credit
answers 500 "Refund failed".

Nothing reaches it today: all 14 unrefunded chip purchases (2026-03-21 to
2026-08-20) were redeemed, so the door answers `already_redeemed` first, and no
door sells for chips any more. The branch is fixed rather than left to refuse
the first undelivered item.

## Where the chips come from

Each chip purchase wrote `chip_transactions` `chip_debit` with no recipient:
the price left circulation, and no club, union or house balance received it
(none of the 15 purchases has a `chip_ledger` leg; they predate the journal). A
refund puts those chips back, so it declares `issuance_reserve`, category
`refund`, under the operation key `ca-shop-refund-<purchase>` (the key the
Diamond branch of the same door already uses; issuance requires one). The
caller's declaration is saved and restored around the credit.
`fn_credit_chips` keeps a category its caller declared and falls back to
`player_funding` as before; its other caller, `fn_purchase_club_chips`
(EXECUTE: postgres only), declares nothing and is unchanged.

## Probe (production, rolled back)

Purchase `128f44bc` (20.00) with its inventory set back to undelivered. Before:
`fn_credit_chips_requires_a_declared_counterparty`. After: success, wallet
6,140.02 -> 6,160.02, one leg `issuance_reserve -> player_wallet` 20.00
`refund` keyed `ca-shop-refund-128f44bc-...`, 0 suspense legs, the commit-time
ledger check passed (`SET CONSTRAINTS ALL IMMEDIATE`), and the outer caller's
declaration was restored.

## Settlement

None owed: no chip refund has been refused (the door has not been called since
the guard landed; every unrefunded purchase was redeemed).
