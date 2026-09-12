# A ticket is a seat, and the conservation delta could not see it

2026-09-12

## What was reported

120 open `financial_alerts` from `fn_tournament_money_conservation`, 117 of them
"Tournament retained money it never paid out", accumulating at roughly eight an
hour across distinct recurring SNG satellites.

## What was actually true

**No money was missing.** Every flagged chip was sitting in an issued, backed
`tournament_tickets` row held by the player who had won it. The sum of the open
"retained" alerts was **9,100.00**, which is to the penny the value of the 118
`tournament_payouts` rows delivered as a ticket. The detector was wrong, not the
ledger.

## Root cause

On 2026-09-09 satellite seat delivery gained a second path: instead of taking a
seat directly in the target event, a winner can be paid a **ticket** - a
`tournament_tickets` row, written as a `tournament_payouts` row with
`source = 'satellite_ticket'`.

Two functions have to recognise a delivered seat, because a seat leaves no
wallet credit to find:

| function                           | taught about tickets?                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| `fn_satellite_conservation_audit`  | yes - `20260909235715`, `20260909235935`, refined `20260910064305` |
| `fn_tournament_conservation_delta` | **no** - last changed 2026-09-06                                   |

Both of the delta's seat terms read `sp.source = 'satellite_seat'`, so a
ticket-delivered seat was invisible on the seat-leaving term (the satellite) and
on the seat-arriving term (the target). The satellite therefore looked as though
it had collected the money and kept it.

## The two traps in the obvious fix

Adding the source string alone breaks two other things, both measured on
production before anything was written.

**1. A cash delivery is not a seat.** 48 `satellite_ticket` payouts totalling
4,095.00 carry `delivery_kind = 'cash'`: a capped winner paid in chips writes the
same payout row as a held ticket. All 48 of 48 already hold a matching wallet
`prize` credit, so counting them as seats would double-subtract and mint 48 new
false alerts pointing the other way. `tournament_satellite_awards.delivery_kind`
is what tells them apart - the rule `fn_satellite_conservation_audit` already
carries as "A CASH DELIVERY IS NOT A SEAT (2026-09-10)".

**2. The two sides are not symmetric.** A ticket _leaves_ the satellite when it
is **issued**; it _arrives_ in the target only when it is **redeemed**. Gating
both sides identically on `delivery_kind` credits a target for an entry that has
not happened - measured, that moved "Wednesday Feature" from a clean 0.00 to
+40.00 and "DSS Wednesday $22 NLH Deepstack" from 0.00 to +20.00. So:

- `seat_paid_out` (satellite) counts an **issued or redeemed** ticket;
- `seat_income` (target) counts a **redeemed** ticket only.

A cancelled ticket is neither - its value returns as cash and the `prize` credit
already carries it.

**And a third, which decided the join.** 1,319 of 1,511 `satellite_seat` payouts
predate `tournament_satellite_awards` and have no award row at all. An inner
`JOIN` onto the award table - safe inside the audit, where it is one branch of a
three-way `UNION` - would silently drop all 1,319 here, where these terms are the
only ones there are. The fix uses `LEFT JOIN` with `COALESCE` defaults: no award
row means the legacy direct-seat path, no ticket row means it was never a ticket.
Both joins are on unique keys (`tournament_satellite_awards` PK
`(tournament_id, place)`, tickets by `id`), so neither can fan out a `sum()`.

## Result, measured in a rolled-back probe against production

    scope=165  healed=118  regressed=0

- **118** tournaments return to a delta of 0.00 - the 117 satellites, plus the
  target "DSS Thursday $22 NLH Deepstack", which sat at -20.00 because a
  redeemed ticket arrived that nothing credited.
- **0** tournaments that were inside tolerance move outside it.
- 2 remain outside tolerance and are `REGISTERING`, so no scan sees them:
  in-flight targets holding buy-ins they have not paid out yet.

Nothing is paid, moved, refunded or clawed back. The 118 alerts close themselves
on the next hourly sweep - Pass 1 of `fn_tournament_money_conservation`
recomputes this delta for every open alert and resolves the ones inside
tolerance (`tourney_money_conservation_hourly`, jobid 144, `12 * * * *`,
tolerance 1.0).

## Deliberately not fixed

`a449e853` and `f7412940`, both "Sunday $200 Deep Stack", ended 2026-09-06 -
before tickets existed - each at -180.00. Measured: no satellite seat or ticket
payout changes their arithmetic by a single chip (income change 0.00, paid change
0.00), and the migration asserts they do not move. They stay open for whoever
picks up their actual cause; the 180.00 is bubble protection, and
`tests/a-bank-that-is-short-pays-what-it-holds.law.test.ts` already documents
that shape.

## The deeper cause: schema drift

`20260909235715` and `20260909235935` were applied to production and **never
committed**. `tournament_satellite_awards`, `fn_deliver_satellite_ticket_exact`
and the string `satellite_ticket` appeared in no repo migration at all. That is
why one function was updated and its twin was not: there was nothing in the
repository to read. Both are backfilled here byte-exact from
`supabase_migrations.schema_migrations.statements` (md5 verified against
production: `0a66a3e6855c7465a44e93c44fbbfe3f` and
`baccccfba6ca76ca5b412b7469f68c41`), marked do-not-re-apply, following the
convention `scripts/ci/backfill-unrecorded-migrations.mjs` established.

**Four more applied migrations in this area are still unrecorded** and are left
for their owners rather than backfilled blind by this branch:
`20260908125910`, `20260908145909`, `20260909215636`, `20260911161027`.

## What stops it happening again

`tests/the-two-conservation-checks-agree-on-a-seat.law.test.ts` pins that the two
functions name the same set of seat-delivery sources, in both directions, and
that the delta decides seat-or-cash from the award row rather than the source
alone. It reads every migration that restates _or programmatically patches_
either function - `20260910064305` does not restate the audit, it rewrites
`pg_get_functiondef` and `EXECUTE`s the result, so a test reading only the newest
`CREATE OR REPLACE` would be blind exactly where the last change was made.
