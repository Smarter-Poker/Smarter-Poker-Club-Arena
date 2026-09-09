# 2026-09-09 — tournament wallet debit context

## Fixed

- The shared wallet debit function previously trusted a historical fallback
  that could turn a non-positive debit into a credit and could choose a
  player's oldest club for a tournament purchase with no table identifier.
- Debits now reject null, non-finite, non-positive, and sub-cent amounts before
  any lookup or write. Explicit ledger, table, and tournament club facts must
  agree, and tournament buy-ins, rebuys, re-entries, and add-ons resolve the
  hosting tournament's club before the home-club fallback.
- The debit and its club chip transaction stay in one transaction. The function
  remains service-only and does not create a second wallet receipt.

## Verification

- A disposable PostgreSQL 17 rehearsal proved negative amounts and conflicting
  declared clubs fail without movement, while tournament and cash-table debits
  each reduce only the hosting club wallet and write one chip transaction.
- Source guards cover validation order, context precedence, receipt ownership,
  and anonymous/authenticated/service-role privileges.

## Release boundary

This records implementation evidence. Production application and live catalog
verification remain separate release gates.
