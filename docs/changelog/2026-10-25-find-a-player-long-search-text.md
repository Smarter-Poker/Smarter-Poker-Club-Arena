# Find A Player: a long pasted search no longer breaks the search

**Reported (Dan, 2026-10-25):** "WHEN YOU GO TO FIND A PLAYER AND SEARCH, ITS NOT
FUNCTIONAL OR WORKING... I SEARCHED 333 AND IT GIVE ME AN ERROR". The locator
showed "Could Not Search Right Now. Please Try Again."

## What actually happened (read from production)

- Every failed `fn_search_players` call that day came from the reporting account
  at 23:51 UTC, three requests of ~1,010 bytes each, all refused by PostgREST
  with error `22023`.
- `22023` is the function's own guard: `Search must be between 2 and 64
characters`. The field held a pasted paragraph (visible in the screenshot,
  "VERIFY YOUR WORK AND CODE AND RU..."), roughly 880 characters.
- The locator printed that refusal as the generic "Could not search right now".
- Searching `333` as the same account, in a rolled-back probe, returns 6
  players with `333` first. The database search itself is healthy.

## Root fix

- `QUERY_MAX_CHARS = 64` in `PlayerSearchService.ts`, matching the server.
- The search field has `maxLength={64}`, so typing or pasting cannot exceed it.
- `handleInputChange`, `runSearch` and `PlayerSearchService.search` each clamp
  to 64, so no request can carry more than the server accepts.
- Regression: `tests/components/FindPlayerLocator.test.tsx`, "a pasted
  paragraph never breaks the search".
