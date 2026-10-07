# The board card names its face deck, and the runtime certificate projects a real board

Date: 2026-10-07
Scope: client (`src/components/table/CardImage.tsx`, `src/components/table/faceDeckContext.ts`,
`src/pages/TablePage.tsx`), `tests/e2e/gameplay-customization-runtime.spec.ts`,
`tests/unit/faceDeck.test.tsx`. No engine change, no migration.

## What failed

Post-Deploy E2E run 37539487040 (live `b09b09e74b`), and every run since the
`:645` timeout was cleared by #6296, stopped at
`gameplay-customization-runtime.spec.ts` line 928 (test declared at 615):

    Locator:  .multi-table-page__table-slot--active .table-page .community-cards .card-image (first)
    Expected: data-face-deck = "broadcast-pro"
    Received: ""   (attribute absent; 9 x resolved to
              <div role="img" aria-label="Card Could Not Be Read"
                   class="card-image card-image--lg card-image--unreadable">)

The same run reported `Phase 1 customization coverage was missing or
incomplete.` from `post-deploy-e2e.yml` step `phase1_verdict`.

## Two causes, both read from the evidence

1. **The fixture sent a board the engine never sends.** The spec projects the
   engine snapshot in-browser and sent `community_cards: ['As', 'Kd', '7h']`.
   The live hub payload (`server/src/engine/presentation/projectHandState.ts`,
   `community_cards: state.communityCards`) is server `Card` objects,
   `{ rank: 'A', suit: 'spades' }`, and `mapEngineSnapshot` passes them through
   untouched. A string has no `.rank`/`.suit`, so `getCardImagePath` returned
   `null` and the felt drew its deliberate "Card Could Not Be Read" tile (the
   2026-08-26 rule: never guess a card). That tile also suppresses the
   face-deck `::before`/`::after` finish, so no deck could ever have been
   observed on it. The fixture now sends the engine's wire shape. The
   assertion is unchanged.

2. **A felt card did not say which deck it was drawn with.** Even on a
   readable card, `CardImage` stamped `data-face-deck` only when a caller
   passed `faceDeckId` (the Table Studio preview). On the table, the card
   relied on CSS inheritance from the nearest `[data-face-deck]` ancestor. A
   face deck is chosen per game type, so the table root and the document root
   can carry different decks; a card that cannot name its own deck is one
   ancestor away from wearing the wrong one. `LiveTablePage` now provides its
   own deck through `FaceDeckContext`, and every `CardImage` under it stamps
   that deck; an explicit `faceDeckId` still wins; a card outside any table
   inherits exactly as before. The paint is identical (the card becomes an
   owner of the same tokens `CardImage.css` resets at each owner), so nothing
   a player sees changes except that the card and its markup now agree.
   `TablePage.tsx` keeps its JSX indentation: the root is assigned to
   `tablePage` and returned inside the provider.

No animation was touched. The deal and flip paths render the same
`CardImage`.

## The coverage verdict

`scripts/ci/phase1-customization-certificate-coverage.mjs` requires exactly
one first-attempt pass in each of `customization-realtime.json`,
`gameplay-customization-runtime.json` and `customization-commerce.json`.
In run 37539487040 two were missing:

- `gameplay-customization-runtime.json`: downstream of line 928 above.
- `customization-realtime.json`: NOT downstream. Its Playwright global setup
  never reached a test. `ensureAcceptedTerms` waited 60 s for
  `[data-tos-gate-status]` to leave `checking`; the setup observation shows the
  Terms read (`GET /rest/v1/profiles?select=club_arena_tos_accepted_at`) never
  answered. PostgREST logs answer why: that read returned **504 every ~10 s
  from 22:46:14 to 22:47:13**, inside a fleet-wide PostgREST pool stall
  (PGRST003). 504s per minute climbed 237 -> 674 -> 1,177 -> 2,307 -> 4,038 ->
  8,209 from 22:41 to 22:46 and cleared after 22:47. The same shape occurred at
  19:51-19:55, 20:40-20:46, 21:45-21:51 and 23:35-23:41 UTC on 2026-10-06; the
  first 504s each time are the engine's own service-role calls
  (`fn_cash_cluster_tick`, `fn_ca_tournament_admission_snapshot`,
  `fn_f06_begin_hand`, `table_seats` reads). Runs 37519466691 and 37517617198
  lost a different suite to the identical global-setup timeout. This is a
  production capacity defect outside this change; it is recorded here and in
  the PR so it has a reader. A Post-Deploy E2E run whose browser suites do not
  overlap that stall is the one that can certify Phase 1.
