# A cohort satellite ticket is redeemable (2026-10-03)

**Alert:** financial_alerts `79cdb720` - `Tournament.satellite_qualifiers_outcome_unknown`,
satellite `00efaa48` "Sunday Funday Main Event Satellite", 2026-10-02 21:31:08 UTC.

## What actually happened to the eight qualifiers

Nothing was lost in the settlement. `fn_ca_settle_satellite_cohort` committed
at 21:30:44 and paid all eight award slots from the 810.00 pool
(18 entries x 45.00 prize share, 90.00 fee retired, ticket cost 100.00):

| slot | player | delivery |
| --- | --- | --- |
| 1 | northashcroft | 100.00 cash: already registered in the target via satellite 91ba0ccb (seat_or_cash) |
| 2, 6, 8 | irisdunmore, fableyarrow, jaspergalloway | seat in 57b8642a (pool transfer 100.00 each, registered 21:30:44) |
| 3, 4, 5, 7 | slatelockhart, marlowcromwell, zanedeveraux, kaneblackwood | four-table cap: noncash entry-only ticket for 57b8642a (100.00 each, escrowed) |
| 9 (bubble) | 3c6742e8 | 10.00 remainder cash |

The engine's request timed out (`supabase_timeout`) after the commit, so it
raised "outcome unknown" and fenced its dealers. The settlement receipt is
complete and exact. (`tournament_registrations`, which the alert triage read,
is an unused table with zero rows ever; the roster is `tournament_players`.)

## The real defect: the four tickets could never be spent

The ticket door and selector prove the ticket's award slot with the v2 receipt
shape (`chip_ledger.metadata->>'position'`, `tournament_payouts.position`).
The v3 cohort receipt books the slot as `metadata->>'award_slot'` and leaves
the payout position NULL. Every v3 ticket therefore read as
`matching_tournament_ticket_unavailable`, and the horse ticket rail
(prestart/late discovery) never admitted the holder. Since 2026-09-17:
0 v3 tickets redeemed; 60 pending on REGISTERING targets, 11 on RUNNING
targets, 322 (15,050.00) on targets that already completed.

## The fix

Migration `20261003051648_a_cohort_satellite_ticket_is_redeemable` redefines
both functions from their live definitions with two counted substitutions:
the slot is proved by `position` or `award_slot`, and the payout position is
required only for pre-v3 receipts. Nothing else in the proof changes and no
money moves; the existing prestart/late discovery admits holders through the
unchanged atomic door. The migration asserts the selector now returns ticket
`f8fc59b6` for slatelockhart in 57b8642a.

## Not settled here

Tickets whose target already completed (v3: 322 / 15,050.00; older v2: 562,
cause separate) hold their value in ticket escrow. All holders are horses; no
human holds one. Their seats cannot be restored and the platform has no
sanctioned holder-refund door for an entry-only ticket; that settlement is
left as a named follow-up rather than hand-written here.
