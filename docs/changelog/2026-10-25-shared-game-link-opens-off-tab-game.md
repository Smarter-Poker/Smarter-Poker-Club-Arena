# A shared game link opens its game, whatever tab you saved (2026-10-25)

## What was wrong

A link to a game in a club lobby (`/clubs/<club>?game=<id>`) only opened
that game if it was already on the list on screen. That list is filtered by
the player's saved tab, its Advanced Filters, Favorites, and the ALL tab's
rules (no Spins or Heads Up on ALL, MTTs capped). On a returning visit the
first list is also the cached tables alone, before any tournament has
loaded. So a player whose saved tab was NLH opened a shared PLO table, Spin
or running MTT and got the lobby with no card, and `?game` removed from the
address.

## What it does now

- If the game is on the visible list, its card opens, as before.
- If the game is in the club's tables or tournaments but not on the visible
  list, the lobby moves to the game's own tab for this visit only, and the
  card opens. This works the same way as the "open the lobby on the
  tournaments list" request: nothing is saved, and the next visit opens on
  the player's own tab.
- If the player's saved Advanced Filters or Favorites would still hide the
  game on its own tab, that one game is let through while the link is
  waiting and while its card is open. Closing the card (or opening another
  game) puts the saved filters back in charge. No filter or tab is saved.
- A link is only given up on once the club's tables and tournaments have
  both loaded and the game is in neither (or cannot be shown on any tab).
  A dead link is still dropped and removed from the address.
- Choosing a different tab still filters the linked game out and closes its
  card, as it does for any game.

## Where

- `src/pages/ClubHomePage.tsx`: the effect that reopens a `?game=<id>` link,
  `linkedGameTypeRef` / `linkedGameId`, and `gameListsLoaded`.
- `tests/unit/clubHomeLightningJoinRoute.test.tsx`: four regressions (PLO
  link from a saved NLH tab; a link hidden by saved filters and Favorites; a
  dead link; a tournament not in the boot cache).
