# One variant order for every stakes sort

Follow-up to `2026-10-23-stakes-first-variant-order.md` (Dan 2026-10-23: "ALL THE 1/2 GAMES FIRST. PLO, THEN PLO5, THEN PLO6 AND THEN PLO8 AND THEN DO THE .50/1.00 GAME SAME WAY"; 2026-09-03: "game variations are never to be mixed together").

The heading sort on the Hold'em, Omaha and Limit tabs already obeyed it. A line-by-line review found three places that did not:

1. **ALL tab, Sort By "Stakes: High To Low / Low To High".** ALL renders the page's own order, and that comparator broke a stakes tie by variant on the Omaha tab only. On ALL, a 1/2 NLH, a 1/2 PLO and a 1/2 Short Deck were interleaved by player count. The page order is now one pure comparator, `src/components/lobby/cashBoardOrder.ts`. Its stakes sorts break every tie in canonical variant order on every tab. Recommended, Most Players and Starting Time are unchanged.
2. **ALL tab Stakes heading.** Two cash games at one price kept arrival order. They now meet in canonical variant order. Tournament buy-ins are not reordered against cash.
3. **Sort By Variant.** Inside a variant every row ranked equal, so stakes kept arrival order and the second tap flipped a direction nothing read. Variants stay canonical. Stakes inside each variant follow the chosen direction, Low To High first.

4. **LIMIT tab Variant heading.** The LIMIT spec has carried FLH and FLO8 chips since the limit games shipped. Its heading was still the only cash Variant heading that could not open the variant menu. It now opens the same menu as Hold'em and Omaha (All, FLH, FLO8, Sort By Variant), reading and writing the same saved `games` filter as Advanced Filters.

The canonical rank (NLH, Pineapple, Short Deck, PLO, PLO5, PLO6, PLO8, FLH, FLO, FLO8, then unlisted by name) moved to `src/components/lobby/variantRank.ts`, so the board and the page read one table. `LobbyTable` re-exports `VARIANT_RANK` and `variantRank`. The page's separate `VARIANT_GROUP_ORDER` copy is gone. Legacy spellings (`plo`, `hilo`, `limit_holdem`) fold through `variantKey` before ranking.

Tests: `tests/unit/lobbyStakesFirst.law.test.tsx` (rendered ALL heading in both directions; Sort By Variant both taps), `tests/unit/cashBoardOrder.test.ts` (ALL stakes sorts, Omaha legacy spellings, unchanged other sorts), `tests/unit/lobbyVariantMenuWorks.test.tsx` (LIMIT menu items and page wiring).
