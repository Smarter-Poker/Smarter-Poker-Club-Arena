# A ticket entry is an entry

2026-09-10. Two drift incidents, one ticket, and no chips out of place.

Ticket `0eca5537` (20.00, "Four-Table Cap Satellite Award: Tournament Entry
Only", club `2a1132b9`) was redeemed at 05:15 into DSS Thursday $22 NLH
Deepstack (`d04da598`) through
`fn_ca_register_for_tournament_with_ticket_for`. That door wrote exactly what
an entry should write:

- a `chip_ledger` leg escrow -> prize_liability, category `ticket_redeem`, 20.00;
- a `rake_records` row for the 2.00 entry fee;
- a `chip_transactions` receipt of type `tournament_ticket_entry`;
- and the escrow triggers booked gross 340.00 / fee 34.00 / prize 306.00 —
  seventeen entries of 20.00, which is what the event holds.

Two readers disagreed with it, and both were wrong.

## 1. The escrow shadow could not see a ticket

`fn_ca_tournament_escrow` is the SHADOW: it recomputes the escrow from source
rows so `fn_ca_escrow_balance_drift` can compare it against the maintained
balance. It built `gross_in` from wallet debits and satellite pool transfers
only. A ticket entry is neither — it debits no wallet and moves no pool — so
the shadow read gross 320.00 / prize 286.00 and the detector filed the 20.00
gap as "a path wrote an operational row the escrow triggers do not read"
(incident `1dee2671`).

It was the shadow that did not read it. It now counts
escrow -> prize_liability `ticket_redeem` legs as entries.

## 2. An entry-only ticket has the entry door's receipt

`fn_ca_settlement_correctness_check` section F required every ticket in state
`redeemed` to have exactly one `chip_transactions` receipt of type
`tournament_ticket_redeem`. That is the CASH redemption door's receipt
(`fn_redeem_tournament_ticket`). A ticket redeemed by entering an event carries
`tournament_ticket_entry`, so every entry-only ticket read as "0 receipt(s)"
and was filed as a ticket-value drift (incident `60d2d03e`, the first card on
the board this morning). The check now accepts either redemption receipt; the
cancel branch is untouched.

## The migration

`20260910070417_a_ticket_entry_is_an_entry` patches both live definitions by
asserted text substitution — each anchor must appear exactly once (twice for
the correctness check, which uses the clause in both its count and its sum) or
the migration aborts rather than editing a clause it did not mean to. Before
committing it proves, against the event and ticket that were flagged, that the
shadow now agrees with the maintained escrow to the cent and that ticket
`0eca5537` holds exactly one receipt totalling 20.00, and it resolves both
incidents with the cause written into `root_cause`.

**No money moved and none was owed.** Both incidents were detector defects on a
correct settlement; the escrow's own figures were right throughout.
