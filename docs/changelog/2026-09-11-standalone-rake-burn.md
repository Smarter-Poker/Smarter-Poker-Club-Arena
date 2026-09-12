# Standalone club rake burns chips

Requested by Dan on 2026-09-11: rake from a standalone club is burned; union rake may remain in the union wallet.

The guarded migration replaces cash and tournament standalone destinations with chip_retirement, which the native deferred journal trigger registers in ca_mint_ledger. No club treasury or wallet receives or loses another copy of the rake. Tournament fee escrow still leaves through its original receipt trigger. Existing union routing and the separate BBJ drop remain intact.

Historical destination claims are retained, so a previously credited hand or event is not retroactively burned. Cash receipt identity also survives hand-history ID arrival and club membership changes. The unkeyed legacy treasury-credit function refuses use. Both terminal validation consumers accept chip_retirement in the same migration transaction while preserving their other guards.

Validation: 34 isolated PG17 scenarios/check groups passed, including the reproduced previous credits, three actual terminal destination predicates, native register and escrow bodies, five journal failure types, deferred register rollback, short escrow, and two concurrent sessions. These use synthetic schema and isolated attribution and do not certify a full native terminal lifecycle. The changed helper and adjacent insurance tests passed 18 checks; server TypeScript passed using existing shared packages. No package installation or copying occurred.

Release status: candidate only. CI, full terminal integration, live definition readback and production behavior proof remain required. No historical financial rewrite or production application is claimed.
