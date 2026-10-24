# A chosen Sort By is obeyed on the ALL tab

Found live while verifying #7907. On Kings Club's ALL tab with Sort By set to **Stakes: High To Low**, a featured 50 buy-in ("Sunday Funday Prime Time") sat above the 100 buy-ins.

Cause: ALL has no default heading sort, so the board is the page's Sort By order. `LobbyTable`'s featured pin stood down only for a chosen heading (`sortChosen`, Dan 2026-10-23: "A HEADING THE PLAYER CHOSE IS OBEYED"). The page's own chosen order was invisible to it.

Fix: `LobbyTable` takes `orderChosen`. `ClubHomePage` passes it when the player has a saved Sort By for the tab. With no heading sort active, a chosen page order now decides the whole list and the pin stands down. The default order still floats featured games. A heading sort, once chosen, still decides as before. Dead seat-first games and empty cash tables still sink.

Test: `tests/unit/lobbyAllTabSortChoiceIsObeyed.test.tsx` (default pins; chosen order unpins; heading still decides). It fails without the fix.

## A fixed-limit row sorts by the stakes it prints

Found in the same live check. A fixed-limit row prints its bet sizes: blinds 0.50/1 read "1/2", per `stakesLabel` since 2026-08-24. But it sorted by its raw big blind. On ALL under High To Low, the FLH and FLO8 "1/2" rows therefore came after the whole no-limit 0.50/1 group, so "1/2" appeared again below "0.50/1". Dan ruled that out on 2026-10-23.

`stakesSortValue` (src/lib/bettingStructure.ts) is now the larger printed figure: the big bet for fixed limit, the big blind otherwise. It drives `cashEntry().stakesValue` and the page comparator. Within the LIMIT tab the order is unchanged, because every row scales by the same factor. The 2026-08-24 pin in `tests/unit/limitStakesReadAsBetSizes.test.ts` that kept the raw big blind was an implementation choice, not an owner ruling, and is updated in this commit with the reason.

Tests: mixed-structure cases in `tests/unit/cashBoardOrder.test.ts` and the rendered ALL board in `tests/unit/lobbyStakesFirst.law.test.tsx`.
