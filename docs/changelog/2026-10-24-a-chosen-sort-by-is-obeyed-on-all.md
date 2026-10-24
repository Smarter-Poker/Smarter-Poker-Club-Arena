# A chosen Sort By is obeyed on the ALL tab

Found live while verifying #7907. On Kings Club's ALL tab with Sort By set to **Stakes: High To Low**, a featured 50 buy-in ("Sunday Funday Prime Time") sat above the 100 buy-ins.

Cause: ALL has no default heading sort, so the board is the page's Sort By order. `LobbyTable`'s featured pin stood down only for a chosen heading (`sortChosen`, Dan 2026-10-23: "A HEADING THE PLAYER CHOSE IS OBEYED"). The page's own chosen order was invisible to it.

Fix: `LobbyTable` takes `orderChosen`. `ClubHomePage` passes it when the player has a saved Sort By for the tab. With no heading sort active, a chosen page order now decides the whole list and the pin stands down. The default order still floats featured games. A heading sort, once chosen, still decides as before. Dead seat-first games and empty cash tables still sink.

Test: `tests/unit/lobbyAllTabSortChoiceIsObeyed.test.tsx` (default pins; chosen order unpins; heading still decides). It fails without the fix.
