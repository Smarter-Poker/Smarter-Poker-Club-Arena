# Club and union operating capacity is sold for diamonds through one proven boundary

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (Revision 2). Checkpoint and the
preserved specification: `docs/handoffs/club-arena-diamond-commerce/`.

## What changed

- Migration `20260922143541_club_and_union_diamond_commerce.sql`: fourteen
  `ca_commerce_*` tables and thirty-five `fn_ca_commerce_*` functions. Catalog
  version 1 publishes the R2 candidate schedule (six capacity tiers, union back
  office per covered club, club and union insurance software modules) with the
  authority named on every price and no comparison claim. Report and artwork
  products are installed but not for sale yet.
- Every eligible operator's first thirty days are a fee waiver: one trial per
  operator identity, 720 hours in UTC, later scopes inherit the common end. No
  operator-service debit happens inside the trial; the owner records a
  post-trial authorization that the renewal consumer executes at the trial end.
- One atomic purchase: request identity, quote consumption and period identity
  are three independent duplicate barriers. The purchase debits through
  `deduct_diamonds`, then proves the journal row, the exact linked Mint
  retirement and the persisted purchased-lot deltas before it commits. A
  swallowed helper failure rolls the whole purchase back instead of granting
  access with incomplete provenance (R2-A03, R2-A04).
- Refunds go through the exact-value `refund` door, prove their journal and
  register rows, restore operation-linked lot provenance, and report gross,
  debt settled and net separately. A multiplier never touches a refund.
- Renewals are diamond mandates with a ceiling; `CommerceRenewalConsumer` in the
  engine's leader-owned services claims due work under a lease and executes
  each once, silent during the maintenance freeze. A price above the ceiling or
  a lapse beyond 24 hours leaves a visible attention state, never historic debt.
- Union sponsorship is an explicit budget the union owner spends from their own
  session; affiliation alone never charges; two clubs cannot spend the same
  last diamond of budget.
- The orphaned `club_creation` row in `feature_pricing` is deleted: the
  personal feature door would have sold it for 100 diamonds and granted nothing.
- Client: `Club And Union Diamond Costs` at `/clubs/:clubId/diamond-costs` and
  `/unions/:unionId/diamond-costs`, in the operations registry (finance). One
  order key per quote; a replay reads "Original Charge: N; Charged On This
  Attempt: 0".

## Qualification

`tests/sql/run-diamond-club-commerce.py` builds a private PostgreSQL cluster,
loads the production-captured Diamond Games wallet fixture and runs 127 checks
including fault injection on the lot and register writes and two-connection
races on the sponsorship budget and on unrelated owners. Registered in the
accounting CI job through `scripts/ci/run-diamond-sql-acceptance.py`.
