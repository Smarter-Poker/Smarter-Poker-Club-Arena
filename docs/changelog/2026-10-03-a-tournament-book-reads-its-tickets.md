# A tournament book reads its tickets and its house funding (2026-10-03)

Phase 4 of 9 (books close), part two. Migration `20261003034305_a_tournament_book_reads_its_tickets_and_its_house_funding`.

## What was wrong

On 2026-10-03, `fn_tournament_money_conservation` had 22 open alerts. None of them was about the money; every one came from `fn_tournament_conservation_delta`.

- **20 alerts said "retained money it never paid out"** (+20.00 to +2,850.00).
  - When `fn_settle_satellite_tournament` delivers a seat as a ticket, it puts the ticket on the payout row (`metadata.ticket_id`) and writes no `tournament_satellite_awards` row (the position is NULL).
  - The delta only looked for the ticket through the award row. So it counted every such payout as a seat that had arrived in the target event, whether or not the ticket was ever redeemed there.
  - Example: Sunday Funday Main Event (`3b8eec8e`) seated 15 qualifiers but was credited with 40 arrivals, which is the +2,500.00.
- **2 alerts said "paid out money it never collected"** (-180.00 each).
  - Both Sunday $200 Deep Stack events (`a449e853`, `f7412940`) paid a 180.00 bubble-protection place.
  - The house funded it with a leg into prize liability labelled `correction` (club treasury or union bank, 2026-09-09).
  - The delta only counted `overlay` legs as house funding.

`fn_pay_backed_payout_shortfalls` repeats the same calculation inline and treats the delta as what the pool holds. A phantom +2,500.00 was therefore money it believed it could pay out from. It runs in report mode only and paid nothing in the last 30 days. Had it been applying, it would have paid a reported shortfall from money the event never held. The native fixture reproduces exactly that payment.

## What changed

- **Tickets.** A seat's ticket is read from its award row or, when there is no award row, from the payout row's `ticket_id`. A ticket id that is not a well-formed uuid is treated as no ticket, never cast, so one malformed row cannot break the read for every event. Production has 1,102 such rows today and none is malformed.
- **House corrections.** A house `correction` leg into the event's prize liability (club treasury or union bank) now counts as funding. It is a separate term added alongside the overlay, so an event with both an overlay and a correction counts both. A player's leg or a settlement-suspense leg never counts as house funding.
- **Both paths.** `fn_pay_backed_payout_shortfalls` reads tickets and house corrections the same way, through a `house_corrections` CTE. The batch path and the per-event path still compute the same figure.

No chip moves, nothing is backfilled, and no job is added (CLAUDE.md 10.12). The hourly conservation job's first pass closes the 22 alerts once their delta reads zero.

## Proof

- **Native PG17.** `scripts/ci/fixtures/backed-payout-scan/ticket-funding-native.py` runs inside `scripts/ci/test-backed-payout-scan-postgres.py`, after every earlier qualification. The cases in `ticket-funding-cases.sql` cover:
  - a ticket on the payout row that was redeemed, one still issued, and one cancelled and paid in cash;
  - a legacy direct seat;
  - a ticket on an award row;
  - a malformed ticket id;
  - a house correction, a suspense correction and a player correction;
  - an overlay plus a correction on the same event;
  - a phantom backing.

  Each expected delta is worked out by hand from the rows. The run shows:
  - the original formula reads +200.00, -180.00, -50.00 and +100.00, and the original batch pays the phantom backing;
  - the successor reads 0.00 on every event;
  - the whole caller under the successor scalar is the oracle for the new batch, and they agree on every apply and limit pair;
  - the migration refuses a changed preimage and changed authority, rolls back whole, and refuses to run twice;
  - function identity and grants are unchanged;
  - batch and scalar agree across the whole fixture population;
  - anon and authenticated are still refused.

- **Production probe.** A single MCP call ending in `RAISE`, so nothing committed. It built the fixture scalar and the replaced batch in `pg_temp` and checked 923 events from 45 days that carry a payout ticket or a correction leg: 22 corrected, 0 moved the wrong way, 0 left off. The batch report is identical to the live one.
- **Regression test.** `tests/backedPayoutScanRegression.test.ts` now treats `ticket-funding-scalar.sql` as the maintained scalar and pins the migration, its replacements and the native proofs.
