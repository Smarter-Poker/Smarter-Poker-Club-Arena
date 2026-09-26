# A Never-Seated Satellite Entry Is Refunded, Not Seated

2026-09-26

## The Decision

Dan, 2026-09-26: "Refund the 50.00 ticket." JulesSA is not to be seated.

## What Happened

JulesSA won place 1 of satellite `95b5fd70` and at 2026-09-22 14:08:23 UTC was
delivered into the RUNNING target `c7f21a83` "Sunday Funday Six-Card Closer"
(PLO6 freezeout, 30,000 starting stacks). The delivery funded the entry
(`chip_ledger 8e974480`: 50.00 = 45.00 prize + 5.00 fee, rake row `1ad31e6e`,
refund entitlement `ea0ff181`, recorded refund wallet Club JAQK) and inserted
registration `d5f1a621` with status `registered` and 0 chips. A RUNNING target
has no launch left to seat a new row, so she was never dealt in and never held
a `table_seats` row in the event. That defect is fixed at the root by #5253.

The four seated entrants hold exactly 120,000 chips. The supply reader counts
every roster row, so the event expected 150,000 and every sample read -30,000.
No chip was missing; her 30,000 were never issued. #5275 stopped the checker
calling that missing chips. This change settles the entry itself.

## What She Held, And What She Gets Back

She held a funded satellite seat worth 50.00, not a `tournament_tickets` row
(award `delivery_kind = 'seat'`, `ticket_id` NULL, entitlement
`award_kind = 'seat_or_cash'`). The approved rule for a funded satellite entry
that leaves (`20260909222303`) returns it as cash to the entitlement's
recorded wallet. She receives 50.00 in her Club JAQK wallet, once.

## Why A Migration

`fn_ca_unregister_tournament_player_exact` refuses once an event is RUNNING or
has dealt a hand, which is correct for a player choosing to leave, and it is
pinned by definition in the MTT admission contract fixtures. Migration
`20260926054204` performs the same steps in the same order for exactly this
registration, with every number asserted before and after:

1. 50.00 through `fn_settle_tournament_refund_exact` (source
   `fn_unregister_from_tournament`): one chip_ledger leg, one
   `wallet_transactions` refund row, one tranche, the refund obligation, keyed
   `tourney:<event>:refund-entitlement:<entitlement>` so it cannot pay twice.
2. The 5.00 fee reversed by one negative rake row that
   `fn_accounting_tournament_fee_net_plan` proves (gross 25, refunded 5, net 20).
3. The event's books compare-and-set: players 5 to 4, prize pool 1,245.00 to
   1,200.00, fees 25.00 to 20.00. The 1,020.00 guarantee overlay is untouched.
4. The registration row removed under the `unregister` seat-exit authority.
5. An immutable unregistration receipt with start authority
   `owner_never_seated_release`. The receipt check constraint gains exactly
   that one value.

Nothing seated, unseated, parked or restarted. Every live seat of the event,
every other member wallet and every club and union pool are fingerprinted
before and after and must match, or the transaction aborts.

## Proof

The exact block ran on production at 05:41 UTC as one call ending in
`RAISE EXCEPTION` (CLAUDE.md 11.5), with a stand-in start authority because a
probe carries no DDL. It returned PROBE_OK: wallet 82,551.96 to 82,601.96, fee
net plan proven, felt 120,000 equal to supply 120,000, conservation delta
1,200.00 equal to the prize pool. A read-back showed nothing committed.

Regression: `tests/a-never-seated-satellite-entry-is-refunded-not-seated.law.test.ts`.
