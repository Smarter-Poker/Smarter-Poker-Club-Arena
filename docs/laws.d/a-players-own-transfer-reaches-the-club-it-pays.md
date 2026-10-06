# tests/a-players-own-transfer-reaches-the-club-it-pays.law.test.ts

Found 2026-10-06. No member holding chips could leave any club: the leave moves
the wallet to the club treasury, and `fn_deliver_accounting_invoice` addressed
that transfer through `fn_accounting_party_users`, which answers only to the
engine or to a member of the party asked about. The leaving player is never one
of the club's officers, so the recipient came back empty and delivery raised
`accounting_invoice_recipient_missing`, rolling the leave back. Migration
20261006044028 gives delivery its own resolver of the parties of record, not
executable by a browser role, and leaves the browser-facing function as it was.
The law pins the two re-pointed lookups, the resolver's rule and grants, and
that no later migration puts the caller-filtered lookup back into delivery.
