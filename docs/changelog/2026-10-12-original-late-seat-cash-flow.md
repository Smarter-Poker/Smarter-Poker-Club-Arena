# Original departed-seat adjustments belong in cash P&L

The original flow reader had no branch for `late_seat_settle` ledger entries.
Thirty-one retained Oct 6/7 flows therefore blocked the closed week despite
their canonical hands, original funding owners and wallet receipts being present.

New migration `20261012201712` adds a separate cash_late_settlement proof and
flow kind. It binds the exact posted ledger and transaction frame to the final
legacy settlement, succeeded canonical claim, signed complete hand, original
funding lineage and signed wallet adjustment. It preserves every ordinary cash,
tournament, satellite, moved-seat and pending-refund branch. Debit and credit
amounts remain real: 125.70 and 339.89, net +214.19.

The report adds only this kind to cash reconciliation. Existing realized/player
P&L already reads flow quantities; the hand delta remains its independent
reconciliation witness and is not added twice. No financial original is changed.
Installation refuses a frozen platform, an active original scheduler, different
source/owner/ACL preimages or replay, and verifies exact postimages/access.

Read and verified: exact captured predecessors and connected monetary CTEs.
Native qualification: fail-before/pass-after on all actual 31 flows; 23 negative
cases, original restoration, ownership/ACL, rollback/replay, freeze/active-owner
admission, current retained-request/key reader compatibility and independent wallet/felt arithmetic. The maintained Accounting 3
step retains its transcript on either outcome. Compiler/hooks/hosted/merge and
production installation are pending; this source is not a whole-week verdict.

The normal submission guard identified missing literal access declarations for
the two recreated readers. Explicit revocations preserve their guarded
postgres-only ACLs, matching the existing native authority proof; no role gains
access and no function body or financial equation changes.
