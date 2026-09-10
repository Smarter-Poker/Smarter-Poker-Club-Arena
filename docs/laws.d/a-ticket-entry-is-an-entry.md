# tests/a-ticket-entry-is-an-entry.law.test.ts

A tournament-entry ticket redeemed into an event is an entry: it moves its
value escrow -> prize_liability as a `ticket_redeem` leg with no wallet debit,
and its receipt is `tournament_ticket_entry`, not the cash door's
`tournament_ticket_redeem`. The escrow shadow `fn_ca_tournament_escrow` counts
that leg in `gross_in`, and `fn_ca_settlement_correctness_check` section F
accepts either redemption receipt for a redeemed ticket while leaving the
cancel branch alone. Both substitutions are asserted against a unique anchor,
and the migration proves the shadow agrees with the maintained escrow and that
the flagged ticket holds exactly one receipt of its value before it commits.
