# A seat-offer link waits for the table

2026-10-05. Launch audit, table client. Client only.

## What was wrong

A waitlist seat offer holds the seat for 60 seconds and sends the player to the
table with `?buyin=1`, which is meant to open the buy-in on the first open seat.
The deep-link effect in `src/pages/TablePage.tsx` waited only for the seat array
to paint, then latched `autoBuyInFiredRef` and called `handleSeatClick`. The
seat array paints before the table's asset is read, and `handleSeatClick`
answers a tap in that gap with "Verifying Table Funding" and returns. The latch
was already set, so the tap was never repeated and the player landed on the
table with no buy-in sheet while the hold ran out.

## What changed

The effect returns, without latching, until `tableState.arenaAsset` is known,
and `tableState.arenaAsset` is in its dependency list so it runs again when the
asset arrives.

## Proof

`tests/unit/seatOfferLinkWaitsForTheTable.test.ts` pins the order (painted,
asset known, latch, tap) and the dependency. It fails on the previous source
and passes on this one. TablePage cannot be mounted in a unit test, so the
behaviour itself was not exercised in a browser here.
