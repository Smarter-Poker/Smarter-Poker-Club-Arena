# Financial observer counterparts and pending top-up verification

The fixed financial reader now includes the bound table's club/union/private
scope, actual insurance wallet row identity and balance, and the selected hand's
pot, rake and BBJ amounts. Missing bank rows remain explicit absences. A private
game cannot acquire its club's union bank through the reader.

A separate observer checks four ordered pending top-up database snapshots. It
binds the two canonically funded actors, table, club, hand and operation; requires
one 10-chip debit, pending entitlement, completed request/response receipt,
matching ledger counterpart and wallet transaction; and rejects any mutation
after malformed refusal or exact replay. Numeric comparisons retain integer
cents. Its receipt explicitly covers database observations only.

Validation: 22 protocol/native-reader checks and 26 adversarial verifier checks
passed. A disposable PostgreSQL 17 probe using canonical funding and the actual
add-on authority confirmed the reader/verifier accept the real debit, receipt,
pending row and exact replay. A separate direct insurance authority call checked
the actual bank counterpart after six service-role relation grants were aligned
to read-only current catalogue evidence. Both are SQL boundary evidence with
synthetic Auth rows; neither proves an authenticated engine/HTTP route or
insurance eligibility. Each owned database cluster was stopped and removed.

The full schema/role closure, trusted route coordinator, actual engine mirror,
normal hand settlement and deployed product certification remain outstanding.
