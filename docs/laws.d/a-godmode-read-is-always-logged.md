# tests/a-godmode-read-is-always-logged.law.test.ts

An operator reading every seat's hole cards for a hand cannot do it unlogged:
`fn_ca_operator_read_hand` writes the `audit_trail` row in the same
transaction that returns the cards, `audit_trail` REVOKEs INSERT from
`authenticated`, no other path reaches another player's cards, and the reason
is required and recorded verbatim.
