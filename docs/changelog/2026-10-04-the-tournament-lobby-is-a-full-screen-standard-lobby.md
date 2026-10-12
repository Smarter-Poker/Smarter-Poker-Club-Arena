# 2026-10-04 - The tournament lobby is a full-screen, standard lobby

## What Dan said

> when you click on the tournament lobby card, nothing work or is functional,
> its all just no functional buttons, and it should be "full screen pop up" ...
> you need to make all the tournament lobby buttons and stats fully
> functional. 2, remove all these large frames, and make it like a normal,
> "industry standard" tournament lobby card.

and, with seven screenshots of FE93D011 (Sunday Funday Main Event Satellite):

> (as a note, things seem to "appear" on desk top, but zero functionality on
> mobile). also this whole display REALLY SUCKS and is trash, it needs a 100%
> redesign.

## What was wrong, measured

Rendered headless with that event's real rows.

**"Zero functionality on mobile" was geometry, not dead handlers.** The popup
was a 75dvh sheet (`TournamentLobbyModal`) holding a painted console - head, a
Close row, foot - around the lobby page (`TournamentDetails`), which under
`PremiumTournamentConsole.css` drew a chassis PNG and then its own framed
"Game Details" plate, a framed two-row tab rail, a framed title strip, a framed
content well and framed footer buttons. At 375x667 the tab panel that was left
measured **308x52px** and the footer was off the sheet. Every tab switched when
tapped; nothing a player could see changed. On a desktop there was room for a
sliver of each tab, which is "things seem to appear".

**The stats disagreed because three tabs each answered "who is still playing"
about an event that had ended.** FE93D011: 18 entries, pool 810, seven players
recorded as `winner` with no finishing position (a satellite's seat winners
tie), 8th and 9th paid.

| tab     | said                                                | cause                                                                                                                                                   |
| ------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables  | Players Left 7, Average Stack 25.7K                 | the shell read tables only while the event was dealing and never cleared them when it stopped; the popup stays mounted, so it kept the last rows it saw |
| Ranking | Remaining 0, Average Stack 0, Total Chips 0         | live-event tiles on a finished event; seat winners are (correctly) not "remaining"                                                                      |
| Detail  | Results Are Being Finalised. Check Back In A Moment | the results panel was built from positions 1 to 3, and seat winners have none                                                                           |

Detail also counted the seven seat winners as "Remaining 7", contradicting
Ranking, and listed 10th to 12th (who won nothing) under "In The Money Behind
Them".

## What changed

**The popup** (`TournamentLobbyModal`) is the whole viewport and draws nothing
of its own: no console, no backdrop, no second header. It hands `onClose` and
the table it is open over to the page. Touch events stop at the popup so a
sideways drag on the tab strip is not read by MultiTablePage as "switch
table". The 3/4 sheet rules stay in the stylesheet for MustMoveLobbyModal,
which borrows them.

**The shell** (`TournamentDetails`) has one header - status, id, Close, event
name, buy-in, blurb - then a one-row tab strip that scrolls sideways instead
of wrapping, the one scroller, and the footer. `PremiumTournamentConsole.css`
is deleted; `TournamentDetails.css` is the only shell skin and paints no
artwork. The same shell serves the `/tournaments/:id` route and the lobby tab,
so all three mounts changed together. At 375x667 the tab panel is now
**375x397**.

Close is drawn in every state the shell can be in (loading, failed, not
found): a full-screen popup with no visible way out is a trap on a phone.

In the popup, the footer's TAKE SEAT linked to the table the player was
already sitting at: a full-width button that did nothing. It is now
"Back To Table" there, and closes the popup. Moved to another table, it still
links, and closes the popup behind it.

**The popup chassis sheet** (`metallic-popups.css`) restyles every button,
heading and paragraph inside any `role="dialog"` with `!important`. A dialog
that holds a whole page opts its content out with
`data-popup-chassis="none"`; the `:not()` sits inside `:where()`, so no
rule's specificity moved.

**A finished event says what happened.** `finishedFieldSummary` (details/
types.ts) is the one reading of a finished field - entries, recorded seat
winners, recorded prizes - and Detail and Ranking both print from it:
Entries / Prize Pool / Qualified (or Places Paid). Detail lists a satellite's
seat winners in name order instead of reporting results as pending, and lists
under "In The Money" only players with a recorded prize. The shell hands the
tabs a table list only while the event is dealing.

**The Details clock band** stacks the blinds under the clock below 520px. Side
by side, the current blinds printed as "200 / ..." on a phone.

## Tests

- `tests/unit/tournamentLobbyPopupIsFullScreen.test.tsx` (new)
- `tests/unit/finishedTournamentSaysWhatHappened.test.tsx` (new, FE93D011 as
  the fixture)
- `tests/unit/premiumTournamentConsoleContract.test.ts`: the two cases that
  REQUIRED the frames (wrapping tab rail, chassis artwork) are replaced by
  their opposites, in this commit.
- `tests/unit/noReentryFieldAndPremiumScroll.law.test.ts`: the scroll contract
  is read from the one remaining stylesheet.
- `tests/components/consoleHeadReadsAsWords.test.tsx`,
  `tests/unit/tournamentLobbyModalIsAskedByName.test.ts`,
  `tests/unit/mttOverviewStructureFacts.test.tsx`: updated for the popup
  having no console and a finished event having no live tiles.
- `tests/e2e/tournament-watch.spec.ts`: asserts the popup covers the
  viewport, the tab panel has at least 200px, a tab tap changes the panel,
  and Close closes it. It used to click the backdrop, which no longer exists.

## Not changed, and why

**The Rewards tab on a satellite still prints the percentage ladder** ("1st
63.52% 515, 2nd 295") for an event that actually awarded seats (FE93D011
recorded eight 100 prizes and one of 10). The client has no model of a
satellite's seat award - how many seats a pool buys, or whether a recorded
`prize` is a ticket or cash - and inventing one in the browser is how two
screens start disagreeing about money. It needs the settlement's own rule
read from the server.

**The Previous Hand popup** keeps its 3/4 geometry, which Dan specified and
`tests/unit/handHistorySheets.test.tsx` pins.
