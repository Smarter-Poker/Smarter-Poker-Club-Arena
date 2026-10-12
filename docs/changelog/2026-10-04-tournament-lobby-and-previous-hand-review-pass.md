# 2026-10-04 - Tournament lobby and Previous Hand popups: the line-by-line pass

Dan asked for a line-by-line pass over the full-screen tournament lobby and
Previous Hand popups shipped in #6072, #6090 and #6091: bugs, stubs, gaps,
wiring, then improvements. Every file in the two surfaces was read in full and
the popup was rendered headless at 375x812 and 1280x800 in the registering,
running and completed states, before and after.

## Defects found and fixed

**Escape on the Sign Up card closed the whole lobby.** The card cancels itself
from a capture-phase listener and calls preventDefault; the popup's own
listener then ran for the same key press. The popup now ignores a key another
dialog has answered, and any key pressed while focus is inside a dialog
stacked above it (`TournamentLobbyModal.tsx`).

**The popup claimed to be modal and was not.** `aria-modal="true"` with no
focus moved in, no Tab trap and no focus restored: Tab walked the live table's
controls behind a full-screen page. It now takes focus on open, keeps Tab
inside, and gives focus back on close. Its keyboard listener is bound once per
open rather than once per TablePage render (`onClose` is read through a ref).

**A watch made inside the popup did nothing, or left the popup covering the
table.** WATCH, a Ranking row, a Tables row and an Entries row all opened a
table and left the full-screen lobby where it was. When the table asked for
was the one underneath (the featured table of a small event, "Your Table",
your own row) MultiTablePage focused the tab already on screen and nothing
visible happened. `watchTable` in `TournamentDetails.tsx` now closes the popup,
and closes without navigating when the table is the current one.

**Ranking and Tables navigated by themselves**, so the page could not apply
that rule to them. Both now open through `onWatchPlayer`, which carries the
tab label as a second argument. `TournamentPage.tsx`, the other consumer of
RankingTab, passes the label through.

**A finished event's Tables tab read "No Tables Yet - Tables Are Created When
The Event Starts".** A regression from #6072, which stopped handing a finished
event its dead table rows. Completed, cancelled, between-days, seating and
pre-start each have their own sentence now.

**Rewards printed more than 100% of the field paid.** Paid places over
entries, on an event still filling: nine places against two entries read "450%
Of The Field Paid". The line is printed only once the field is at least as big
as the ladder.

**Detail counted down "Starts In" on a cancelled event**, ticking once a
second over Remaining / Blinds Up / Late Reg tiles. Cancelled has its own hero
line and three tiles (Entries, Buy-In, Status), and Rewards no longer calls a
cancelled pool "Still Growing".

**Detail advertised a rebuy window nobody configured.** `late_reg_levels ??
rebuy_levels ?? 8` printed "Rebuy thru Lv 8" and "Add-On Lv 8-9" for an event
with neither column set, beside a Late Reg tile reading Closed, and read the
columns in the opposite order from `TournamentService.canRebuy`. It reads
`rebuy_levels ?? late_reg_levels` and prints no level when there is none.

**The Ranking realtime channel was shared by every mount of one event**
(`ranking-<id>`). The popup stays mounted after closing and a lobby tab can be
open beside it; the second mount's bindings land after the join and receive
nothing. Keyed per mount, as TournamentDetails' own channel has been since
2026-08-30.

**Every tab opened at the previous tab's scroll offset.** The panel is the one
scroller for all tabs; it now returns to the top when the tab changes.

**Previous Hand's empty panel held no focus and trapped no Tab.** Only the
hand panel carried `panelRef`, so opening before the history loaded focused
nothing, and when the hands arrived focus was never moved in. Both panels
carry the ref and whichever mounts takes focus. Arrow keys on its two tabs now
move focus with the selection.

**Previous Hand's foot sat under the home indicator.** Full screen, the Close
and Replay plates are the last thing on a phone; the sheet now pays
`env(safe-area-inset-bottom)`.

**Touch targets under 44px:** the hand sheet's copy controls and the Hand
History search field and clear control (40px), the Unions retry button
(about 32px) and the lobby tab strip on a short screen (40px).

## Improvements, from data already on the page

- Table names print without the event name in front ("Table 2", not "Sunday
  Funday Main Event Satellite - ..." truncated before the number) in Ranking
  and Tables.
- The Entries register lights and badges the signed-in player's row, and reads
  the satellite-seat flag from props as well as its own query.
- The Tables row for the player's own table says "Tap To Go To Your Table".
- The bounty ledger on Rewards is read again when a player busts, instead of
  once when the tab opens; a failed refresh keeps the last figures.
- The loading state announces itself; rank and hand-position figures are
  grouped with `toLocaleString`.

## Left alone, and why

- **Blinds tab has no full level ladder.** Dan's 2026-08-25 ruling in that
  file's header limits the tab to current level, next level and next break.
- **`LATE_REG` in the Detail tab.** Detail tests `status === 'RUNNING'` where
  the shell uses `isLateStatus`. The engine does not write `LATE_REG` (it is
  read in filters only), so no player can reach the difference today.
- **Hand History (the list drawer) keeps its three-quarter sheet.** #6091
  recorded that as deliberate.
- **The popup stays mounted after closing** and keeps its realtime channel and
  watchdog poll. That is Dan's 2026-08-30 "open instantly" ruling.
- **Pre-start "Remaining N of N entries"** on Detail reads oddly before an
  event starts; it is accurate and pinned by existing tests, so it was not
  renamed in a defect pass.

## Tests

- `tests/unit/tournamentLobbyReviewPass.test.tsx` (new): one block per defect.
- `tests/unit/tourneyUxSweep20260825.test.tsx`: two pins on the watch call and
  the `onWatchPlayer` signature updated for the label argument.
