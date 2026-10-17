# A returned Club Data sort may show its own expanded window

**2026-10-17.** Post-Deploy E2E run 39024600776 (client 2c62f885, runtime
038f4c5a) passed 490 of 493 sweep cases and failed one:
`club-data-deep.spec.ts` "operates sorting, pagination, players, and a verified
manual refresh" expected `Load More Players - 100 Of` after returning from
Biggest Winners to Biggest Losers, and read `- 200 Of 571`.

## What the page did, and why it is correct

`ClubDataPage` keeps an operator's expanded ledger across background
revalidation (`preserveExpandedClubDataRows`) and caches the player ledger per
sort. When a revalidation lands while Biggest Losers is expanded to 200, that
200-row window is what the sort's cache holds, so returning to the sort paints
it and the fresh first-page read keeps it. Whether the cache holds 100 or 200
depends on whether a revalidation fired during the expansion, which is why the
earlier sweeps passed and this one did not. The games ledger behaves the same
way.

## Change (test only)

The second round now reads the rendered window: either the fresh first page
(continued from that page's observed cursor, as before) or a retained window
that contains it, which must grow when Load More continues from its own cursor.
Anything smaller than the first page still fails. `loadMorePlayerCount` parses
the label and is unit-tested in `productionPlayerPageObservation.test.ts`.
