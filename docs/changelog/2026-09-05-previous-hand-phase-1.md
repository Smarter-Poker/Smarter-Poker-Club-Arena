# 2026-09-05 - Previous Hand build plan, Phase 1 of 7: live, instant and honest

Plan: `docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md`. Builds on #3089 (one model,
`HandRecord.replay`).

## Live refresh

The engine has emitted `hand_history_saved` with the row id since 2026-08-15;
the table's Previous Hand list never listened. It refetched on every open and
refreshed at no other time, so a hand that finished while the panel was open
did not appear until it was closed and reopened. `TablePage.takeSavedHand`
now reads that one row (`getHand`, so it carries the viewer's own cards and
discards like the fetched ones) and prepends it in play order, de-duplicated,
capped at the page. Only into a list already fetched for THIS table; an
observer's read returns null under RLS and nothing changes.

## Instant reopen

`lib/handHistoryLive.shouldRefetchHandHistory`: fetch on the first open for a
table, after a failure, or when the list is older than five minutes (a
reconnect can miss an event). Otherwise the list on screen is the record plus
everything the engine has announced since, and a reopen costs nothing - four
queries fewer and no blink of the stats strip.

## Honest empty states

A spectator opening Previous Hand was told "No Hands Recorded At This Table
Yet", which was false: hands are readable by the players dealt into them. Both
surfaces take `viewerSeated`; a railbird reads "You Are Watching ...", a seated
player with no hands yet reads "No Completed Hands For You At This Table Yet".

## Copy hand number, copy link, deep link

The modal's subheader carries two controls: the hand number (copies `#N`) and a
link (`/hand-history?hand=<id>`), with a transient "Copied" on the button. The
archive reads `?hand=`: if the hand is on the loaded page it is expanded and
scrolled to; if not, it is fetched by id and led into the list regardless of
the filter; if the viewer cannot read it, the page says so instead of failing.

## Pins

`tests/unit/previousHandPhase1.test.tsx`: the refetch rules, prepend ordering
and cap, the deep link shape, the TablePage wiring, the observer copy in both
surfaces, and the two copy controls writing the clipboard.

## Deep-dive review before Phase 2 (same day)

Four defects found in the phase's own code and fixed before publish:

- A hand announced while the page fetch was in flight was dropped (the fetch
  may have queried before the row landed). Such ids are queued and applied
  after the fetch.
- With live refresh, the modal opened "on the newest" resolved newest on every
  render, so a landing hand moved the reader off the hand they were reading.
  The newest is pinned by id at open; the navigator grows instead.
- Switching table left the previous table's list under the new table's name
  while the new list loaded. It is cleared first.
- The archive refetched a linked hand by id every time `rows` changed (each
  Load More). It fetches once.
- The deep link's base path is pinned to the router's own `basename`.

## P0 found by the deep dive: every table on the published build crashed

Opening any table on `ca_sha 63baa151` (which carries #3089) threw
"Cannot access 'parseTimed' before initialization" into the error boundary.
The second sweep made `anyTurnLive` in MultiTablePage read `parseTimed(...)`
during render, and `parseTimed` was a `const` declared further down the
component body. tsc does not flag a use-before-declare inside a nested
callback and nothing renders the container under test, so it reached players.
`parseTimed` is a pure function at module scope now. Reproduced on an
unminified local build of `main` (browser at `/table/<id>` went to the error
boundary) and confirmed fixed the same way; the tab-strip Leave Table then took
55 ms to the lobby. New law `tests/no-tdz-in-table-route.law.test.ts` runs
`no-use-before-define` on the three table-route files as a ratchet.
