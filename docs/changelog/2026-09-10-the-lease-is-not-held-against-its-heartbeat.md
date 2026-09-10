# The lease is not held against its heartbeat; a union ticket is issued at the club the winner plays from

**Date:** 2026-09-10
**Migrations:** `20260910064305_a_union_ticket_is_issued_at_the_club_the_winner_plays_from`,
`20260910064701_a_hand_commit_does_not_hold_the_lease_against_its_own_heartb`
**Law:** `tests/the-lease-is-not-held-against-its-heartbeat.law.test.ts`
**Follows:** `2026-09-10-a-busy-manager-keeps-its-lease.md`

## Lease expiries, second half

Seven minutes after the PostgREST hook moved to FOR KEY SHARE, two managers
(`2dbc9bb6`, `7f521f47`) still expired their own leases. Two more readers
held FOR SHARE on the lease row for the life of their transaction, both on
the hot path: `fn_ca_commit_hand_settlement_exact_before_obligations` (every
tournament hand commit) and `fn_close_empty_tournament_table` (every table
break). Both now take FOR KEY SHARE. The migration proves, by regex over
`pg_proc`, that no protocol-2 reader of `engine_tournament_leases` takes
FOR SHARE any more, and that the takeover still locks FOR UPDATE.

A reading that was NOT a defect: 43 of the 45 "Lost the tournament lease ...
to another engine instance" lines in a six-minute sample were COMPLETED
spins and SNGs - a manager that has finished its event and is waiting for the
next discovery pass to clean it up is logged as a lease loss. That log line
answers wrongly (10.86); it is noted here, not changed in this branch.

## Three satellites refused, five incidents closed

`c327bb92`, `34434fe4`, `d25904af` (union-hosted) were refused with
"ticket place 1 has no exact target club". A winner at the four-table cap is
delivered a target-scoped ticket, and the gate demanded the ticket's club be
exactly the target's club - the union's house club - while
`fn_tournament_club_for_user` rightly resolves a member to the club they play
from. Redemption already accepted any member club of the target's union.
Issuance now does too. All three had settled on the platform's own retry once
a game freed up (seat delivered, remainder paid, escrow closed at 0.00) -
asserted in the migration before their incidents were resolved.

`db2110a2` and `93a959cd` read "seats 1/1, cash 38, excess 30" because
`fn_satellite_conservation_audit` counted every `satellite_ticket` payout row
as a funded seat, and a cash delivery writes that row and the wallet credit.
The payout branch now counts only awards whose row says seat or ticket. The
audit returns no findings over 24h, asserted.
