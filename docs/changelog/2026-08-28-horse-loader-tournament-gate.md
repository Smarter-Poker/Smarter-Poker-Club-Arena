# 2026-08-28 — The client horse loader is banned from tournament tables

Follow-up to `2026-08-28-spin-prestart-live-roster-and-fast-start.md`. After
that fix deployed, Dan's exact symptom (inert EMPTY plates, plain
"Spectating") was still reproducible on the current bundle. A 25ms state
sampler against production caught the cause in the act.

## What was found

TablePage's legacy HORSE LOADING effect (pre-migration client-horse era) runs
on every table once the blinds resolve. On a REGISTERING spin it:

1. Painted the seated horses with an invented `bigBlind * 100` stack (2,000
   on a 10/20 spin) for about one second until the real seat rows (stack 0)
   overwrote it. The playHasBegun latch treats "a seat bought at zero chips
   now holds a stack" as the Spin's start signal, latches permanently, and D8
   tears down seatFirstBuyIn — every open seat renders as an inert EMPTY
   plate and the footer reads plain "Spectating". Observed sequence on table
   466f2681: seats null -> stacks 2000/2000 (begun latches true) -> stacks
   0/0, begun stuck true.

2. When it found no horses at all, it called HydraService.seedTable, which
   INSERTS table_seats rows directly from the browser (and deletes departed
   seat rows first). A spin's paid-seat count IS its live seat-row count, so
   client-seeded unpaid seats are indistinguishable from bought ones to the
   engine's start gate. Horses enter tournament tables through the same paid
   server RPCs as humans (section 10.5), never through a spectator's browser.

## What changed

The effect now refuses any table with `isTournament` or a `tournamentId`,
before latching its loaded-ref, so the refusal re-evaluates if a table's
tournament identity resolves late. Cash tables keep the legacy path
unchanged. Pinned by `tests/unit/horseLoaderNeverTouchesTournaments.test.ts`.

## Left open, deliberately

The whole client-side Hydra seat path (direct table_seats INSERT/DELETE from
the browser, fabricated 100bb stacks) is pre-migration legacy that arguably
should not survive on CASH tables either — the server fleet owns horses
everywhere now. That is a larger removal with its own blast radius; flagged
for Dan rather than done unasked.
