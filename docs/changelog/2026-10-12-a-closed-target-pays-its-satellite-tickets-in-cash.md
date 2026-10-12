# A Closed Target Pays Its Satellite Tickets In Cash

2026-10-12. Migrations `20261012054804` (the rule) and five settlement parts
`the_stranded_satellite_tickets_are_paid_part_1` to `_5`. Settled under
CLAUDE.md 10.9; root fix under 10.11 and 10.12.

## What Was Wrong

Every direct satellite award is a `seat_or_cash` entitlement.
`fn_ca_settle_satellite_cohort` decides the delivery at the satellite's
finish: a seat while the target still takes entries, cash when the target is
closed, full or already held, and for a winner who is already in four games
(the four-table cap) while the target is open, a noncash entry-only ticket
for that one target.

Nothing decided what happens to that ticket when the target closes before
the holder uses it. The entry door refuses a finalized pool, the cash door
refuses every entry-only ticket, and the ticket guard refuses every other
status change. So the winner's value sat in ticket escrow for ever.

Measured at 05:40 UTC: 928 issued direct tickets worth 55,120.00 whose target
had closed, held by 460 players, from 718 satellites into 56 targets. Every
holder is a horse and an active member of the ticket's club. Nobody paid
twice, nobody lost a chip: the value was escrowed and simply never delivered.

## The Three Cases Asked About

1. **Sunday Funday Six-Card Closer Satellite (61961519).** Frozen from 23:52
   to 05:00 (another lane owns why), it finished at 05:02:12 with 21 players
   and a 378.00 pool: seven awards of 50.00 and a 28.00 bubble remainder,
   paid to place 8. The target (7e9996f6, 71 entries at its peak) was still
   in late registration at 05:02, so the rule said seat, but all seven
   winners were at the four-table cap, so all seven were held tickets. The
   target's entry closed at level 9 before any could be used. Those seven
   tickets (350.00) are paid in cash to their holders.
2. **Sunday 200 Deep Stack Satellite (e6321c15).** It did not start after its
   target. It was opened at 17:01 on 10-11 by the heads-up feeder for the
   NEXT Sunday 200 Deep Stack (e69857d3, 10-18 17:00), which is the feeder's
   rule (targets 3 hours to 7 days ahead). Its seven qualifiers hold 200.00
   tickets for that event, which is still registering, and the 152.50 bubble
   remainder was paid. No scheduling defect; nothing owed.
3. **Sunday 200 Deep Stack (6561f9f4).** Five holders (1,000.00) whose late
   entries were refused by the defect fixed in 20261012031813 never sat. The
   event completed. They are paid in cash.

## The Rule Now

`fn_ca_satellite_ticket_target_is_closed` says a target can no longer admit a
ticket once its pool is finalized or it is finishing, finished or cancelled.
Both facts only move one way.

`zz_closed_target_pays_its_satellite_tickets` (AFTER UPDATE on tournaments,
declared in `ca_declared_money_triggers`) runs in the same transaction that
finalizes, finishes or cancels a target, and pays each still-issued direct
ticket for it through `fn_ca_pay_closed_target_ticket_in_cash`:

- the ticket's escrow moves to the holder's wallet in the ticket's own club,
  as one named leg (escrow to player wallet, category ticket_redeem, keyed
  `ticket:<id>:closed-target-cash`, naming no tournament);
- the ticket becomes redeemed, with the cash door's receipt
  (`tournament_ticket_redeem`) and a wallet credit;
- a second call answers with the first receipt and pays nothing.

The ticket guard accepts exactly one new transition for this, and only when
that exact leg already exists in the transaction. A ticket the door cannot
pay never stops the target from closing; it is named on a critical alert in
the same transaction. Horses are paid exactly as humans.

## The Stranded Tickets

Paid once, through the same door, in five parts of at most 190 tickets so no
part holds a horse's wallet for more than a few seconds. Each part asserts the
exact count and sum written here, that every ticket is redeemed with its leg,
and that nothing in its window is left.

| Part | Issued From         | Issued Before       | Tickets | Chips     |
| ---- | ------------------- | ------------------- | ------- | --------- |
| 1    | 2026-09-01          | 2026-09-12 19:00    | 190     | 14,660.00 |
| 2    | 2026-09-12 19:00    | 2026-09-17 21:45    | 190     | 7,730.00  |
| 3    | 2026-09-17 21:45    | 2026-09-22 08:00    | 190     | 14,070.00 |
| 4    | 2026-09-22 08:00    | 2026-09-24 17:45:30 | 190     | 7,500.00  |
| 5    | 2026-09-24 17:45:30 | 2026-10-13 00:00    | 168     | 11,160.00 |

Part 5 may pay fewer: a ticket whose target finishes after the rule is live is
paid by that target's own close.

## Proof

Before writing, a rolled-back trial on production moved 40 real tickets
(2,960.00) escrow to wallet: every money trigger accepted the leg, each
wallet credit matched to the cent, and the only open check was the ticket
float, which closes when the ticket is marked redeemed (the guard change). The
rule migration proves itself again inside its own transaction on a real
stranded ticket and rolls that proof back before it creates the trigger.

Pinned by `tests/a-closed-target-pays-its-satellite-tickets-in-cash.law.test.ts`.
