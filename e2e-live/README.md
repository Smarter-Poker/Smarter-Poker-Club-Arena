# e2e-live — real-browser walkthroughs against PRODUCTION

Plain `playwright` scripts (NOT `@playwright/test`) that drive the deployed
site at https://smarter.poker with a real logged-in account. They are the
final verification gate for UI work: run one of these and read the PASS/FAIL
lines + screenshots BEFORE claiming any user-facing flow works.

## Why plain scripts

- They run standalone from the repo root (`node e2e-live/<script>.mjs`) with
  no test-runner config, no webServer, no fixture graph.
- They manage their own auth state: Supabase refresh tokens are SINGLE-USE,
  so `auth.json` is re-saved at the end of every run and an anonymous arena
  triggers a fresh credential login automatically.

## Running (from the host with network access)

    SP_EMAIL="<owner test account>" SP_PASS="<password>" \
    node e2e-live/multitable-walk.mjs

Or use the wrapper: `bash scripts/e2e-host.sh multitable-walk`

Env knobs: `E2E_AUTH` (storageState path, default /tmp/e2e-work/auth.json),
`E2E_SHOTS` (screenshot dir, default /tmp/e2e-shots).

## Scripts

- `trainer-walkthrough.mjs` — hub → trainer game → question panel on the
  table, solver actions, answer classification, EV in bb, no score artifacts,
  zero arena page errors. 10/10 PASS on 2026-08-20.
- `multitable-walk.mjs` — arena → club → cheapest open cash table → SIT +
  min buy-in → upper-left "+" (aria-label "Open another table") → embedded
  lobby tab with table 1 still mounted → join table 2 → leave table 2 via
  table menu → LiveTablesBar dock on the lobby route → "Return to game" →
  leave table 1 (stack refund). Exact production selectors are documented
  inline; they come from the component source, not guesswork.

## Hard-won rules (cost hours; do not relearn)

1. A backgrounded Chrome tab stops rAF entirely — run headless, never rely
   on animation completion in a hidden tab.
2. Club home can sit on its loading skeleton when the Supabase API degrades
   (platform incident 2026-08-20). The walk reloads once after ~32s and
   presses the Retry panel that ClubHomePage's 15s watchdog now renders.
3. The "+" add-table control is icon-only: locate it by
   `button[aria-label="Open another table"]`, never by text.
4. Empty seats are `div[role="button"][aria-label="Seat N: open - click to
sit"]`; the buy-in confirm is `button.buy-in-modal__confirm` ("BUY CHIPS").
5. Always leave tables at the end of a run — a stranded seat blocks the
   4-cap for the test account and skews later runs. If a run dies mid-walk,
   `node e2e-live/cleanup-seats.mjs` sweeps every live seat by following the
   dock from the arena route until it stops appearing (DB-verify with:
   table_seats where user_id=<hero> and left_at is null).
6. The dock's idle CTA is "Return to game →" but the urgent variant says
   "Action needed … Act now →" — match /Return to game|Act now/i.
7. The hamburger nav drawer sometimes restores open over the arena and hides
   the club list — dismiss with the Close control + Escape before asserting.
8. Never assert on a fixed sleep after an action the SERVER completes.
   atomic_table_buyin returns 204 well before the felt repaints, so a flat 6s
   wait declared "not seated" on a seat we had already bought — and the
   teardown then skipped a table we were really sitting at. Poll for the
   state you want.
9. Bound EVERY click. An unbounded `.click()` on a locator that never appears
   burns Playwright's 30s default and throws, failing a run at teardown after
   every real assertion had passed.
10. 40 horses play these tables continuously, so a seat that was open when the
    lobby was listed is often gone by the time you arrive. Walk the candidates
    cheapest-first rather than failing on the race.
11. Teardown lives in `lib/leave-all.mjs` and follows the DOCK, not the tab
    bar: the dock is rebuilt from server truth (table_seats where left_at IS
    NULL) on every arrival, so it is the honest list of what you are still
    sitting at. Both the walk and the sweeper call it — one implementation.
