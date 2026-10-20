# 2026-10-19 - A ticker tap opens the tournament, and stays on it

Dan: "when you click on one of the tournaments inside the scroll at the top,
it should take you to the registration page for that tournament when clicked.
it currently silently fails."

## What happened

Reproduced live at smarter.poker on a Spin table with a second tab open. The
ticker's tap navigates to `/tournaments/:id`. With tables open, the route
backstop in `MultiTablePage.tsx` claims that route: `openTournamentTab` puts
the tournament's page (Register button included) into the Lobby tab and
focuses it, then the backstop navigates back to `/table/<returnTo>` so the
container stays visible.

That navigate is a borrowed URL. The route layout effect saw a table it
already holds and focused it, one commit later. The registration page was
sitting, fully loaded, in the Lobby tab with nothing pointing at it - on screen
nothing changed, which reads as a dead tap.

Every other borrowed-URL caller (`handleTabSelect`, `OPEN_LOBBY_TAB` via
`revealPageTabOffRoute`) hands the intended tab over through
`pendingTabIndexRef`. This backstop was the one that did not.

## The fix

The backstop records the tab `openTournamentTab` will focus (the parked lobby
tab, else the one it appends - read from the same snapshot) in
`pendingTabIndexRef` before it navigates, so the route effect keeps the
tournament page in front.

Pinned in `tests/action-bar-never-leaves.law.test.ts` ("the backstop focuses
the tournament it opened, not the table whose URL it borrows"); the pin fails
on the old code.
