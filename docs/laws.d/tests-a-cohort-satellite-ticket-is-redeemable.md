# tests/a-cohort-satellite-ticket-is-redeemable.law.test.ts

A satellite winner's entry-only ticket from a v3 cohort settlement can be spent:
the ticket door `fn_ca_register_for_tournament_with_ticket_for` and its selector
`fn_ca_find_tournament_entry_ticket_for` prove the award slot by the issue
ledger's `position` or `award_slot`, and require the payout's `position` only
for pre-v3 receipts. Both substitutions are counted against the live
definitions and must match exactly once, and the migration moves no money.
