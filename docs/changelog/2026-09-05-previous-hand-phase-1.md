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
