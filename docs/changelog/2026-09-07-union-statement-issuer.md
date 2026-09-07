# Statements Stay With Their Issuing Union

Migration 20260907211431 uses the stored invoice breakdown.union_id for period selection, invoice history and payment authorization. Current members still show a missing statement; former members remain visible for their issued period. Another union cannot inherit old invoice visibility or payment authority merely because the club joins it. Explicit historical periods retain their start date even outside the history limit.

Both existing weekly invoices were checked for a stored issuer; both have it. Unknown issuer records are not attributed by guessing from current membership. No historical invoices were rewritten and no chips moved.

Actual-function rollback tests reproduced the original disappearance after a club move, then verified issuer visibility, denied new-union payment, no old history exposed to the new union, and old selected-period start. Installed functions passed. The exact-cent payment probe was rerun successfully with an issuer-bearing fixture. Identity/authorization helpers were stubbed and production triggers/concurrent sessions were not exercised.

The statement board's historical financial calculations and duplicate/cancellation treatment remain separate audit work; this closes identity and period-selection defects.
