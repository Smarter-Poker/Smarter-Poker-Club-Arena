# Mobile round 3 (Dan, 2026-08-27)

Nine reported items. Eight fixed, one half-fixed and escalated rather than
forced — the reasoning for that one is in `tableGeometry.ts` and repeated below.

## 1. Hold'em hole cards are the size of PLO cards

`--sp-card2-*` in `SeatSlot.css` now carries the PLO4 width/height at all four
breakpoints (60x84 / 57x80 / 51x71 / 45x63). Only the STEP still differs: it is
the stride between adjacent cards, and two cards keep the row's original 12px
overlap where four have to close up to fit the same felt. These tokens are
hero-only since 2026-08-26, so nothing else moved.

Test updated in the same commit: `HeroCardRowGeometry.test.tsx` hard-codes the
base-breakpoint sizes to check row widths.

## 2. The pot slid down, off the top row's chips

`TableVisualHotfix.css` section 6: `top: 19% -> 28%`.

19% was tuned on 2026-08-17 against the pot as it was then — the tall
glassmorphism box. It became a thin pill three days later and nobody re-derived
the override, so the pot was parked high against a constraint that no longer
existed, level with the top row's bet chips. At 390px the pill's top edge was
10px under those chips; it is now 64px clear, with 36px still between the pile
and the board. Ceiling documented at 30%.

## 3. The negative number is gone from the header

It was the multi-table session P&L chip (`-37` when the session was down). The
chip is deleted; the breakdown it opened is NOT — it moved to the tab quick menu
as "Session Totals", beside the other across-all-tables actions, because
deleting the trigger alone would have left `showSessionAgg` unreachable.

Its 52px went back to the tab strip: the 375px budget in `TableTabBar.css` is
re-derived, and the pill cap moves from 55.25px to 67.75px.

## 4. The 4-box button is pinned; the hamburger fills the bar

- `.tile-toggle-btn` gets `margin-left: auto`. It only _looked_ right-aligned
  below 480px, where the strip grows into the space; above that it sat after
  the last pill and moved every time a table opened or closed.
- The hamburger is the bar's inner height now: 36px base, 34px on a phone. It
  was 40px inside a 36px row — the item defining the bar's height, which made
  the published `--sp-tabbar-h: 49px` under-state the real 52px.

## 5. The action pill hangs under the hero's bet — and the bet did not move

Second half done: `.seat--hero .seat__action` is anchored to the chips' own
origin (`50% + var(--bet-offset-y) + half a tower + 4px`) instead of to the top
of the seat box, so it follows the bet at every size instead of floating above
it.

**First half deliberately not done.** The hero's chair is 10.8% of the table's
height below the felt, so its rail walk overshoots and `clampIntoFelt` pins the
bet to the felt's edge — the only way to raise it is to give the chips their own
felt margin. Tried at 6.5%: it fails "one rail, equal for every seat" 26 times,
because raising only the seats that clamp is exactly the per-seat term Dan's
round-2 item 13 forbids ("all chips must appear equally on that line for all
players"). Lengthening the rail for everybody moves every seat EXCEPT the hero,
which makes the ring less equal, not more.

The two requests are in direct conflict and it is Dan's call. Left on the oval,
because that is the rule he stated last. Full note at `CHIP_FELT_MARGIN` in
`tableGeometry.ts`.

## 6. No action inside the tab pill

`.table-tab-bar__action-chip` and everything behind it: the flash state, its
timers, `ACTION_LABEL`, the `lastAction` field on TableTabBar's TabInfo and
MultiTablePage's TableInfo, and `heroTabLastAction` in TablePage. A chip nothing
renders is not a hidden feature. What is left on the pill is the mini cards and
the timer bar, which is what was asked for.

## 7. A stale "Wins The Pot" cannot be drawn at all

`winnerInfo` carries the hand number it belongs to, and nothing on screen reads
it directly — everything reads `shownWinnerInfo`, which collapses to the empty
value the moment `tableState.handNumber` moves on.

This replaces "clear it in time" with "it cannot be shown". The band used to be
cleared by two EVENTS and nothing else, so every way of missing one left it up:
a dropped HAND_STARTED on reconnect or a multi-table switch; a background tab
throttling the hold `setTimeout` past the next deal; a late or duplicate POT_WIN
landing between the reset and React's commit, where `winnerInfoRef.current`
still held the old record and the merge revived it.

Also fixed alongside, same class:

- the POT_WIN merge is fenced by the award's own hand number, not by the resets
  having run;
- both reset paths clear the ref as well as the state;
- the four hand-written copies of the empty record became `EMPTY_WINNER_INFO`;
- `cachedHandStrength` is stamped, so the hero's "Three of a Kind" cannot sit
  under them through the gap between hands;
- the snapshot merge no longer lets an OLDER hand's `lastActions` repaint
  FOLD/CHECK badges over the new hand.

## 8. The three-way all-in that never ran out

`pacedAllInRunout` **awaited** the equity broadcast on every street, so dealing
was gated on a computation whose cost is not linear in the number of all-in
hands: the worker pool has a 15s per-job timeout, and its failure path is a
synchronous per-player board enumeration on the main event loop. Two players is
one job and, badly, two passes. Three is a heavier job and THREE passes, on the
flop, the turn and the river.

That is why it took a third player. The equity is now fired and left to land —
a percentage is commentary, the deal is the game — with a `.catch` so a rejected
job cannot become an unhandled rejection now that nothing awaits it. Same change
on the insurance per-street path, which has more at stake because the flow it
re-enters carries the hand's clock.

Also `advanceGame`'s `activePlayers.length === 1` -> `<= 1`, matching
`foldForMissedDiscard` twenty lines above: with zero active players a hand took
the run-the-board-out path instead of ending.

New coverage: three-handed preflop all-in on a plain table (there was none — the
existing 3-way coverage is all RunItTwice), including a 500ms-per-street equity
mock and a rejected equity job.

## 9. The puck is never on the bet

The separation rules modelled the bet as a DISC of `chipRadiusWidthPct`. What
renders is `.chip-physics`, a flex row of `[tower][6px][amount]` centred on the
chip position — at 375px about three times the tower's width. A puck could clear
`MARKER_MIN_GAP_WIDTH_PCT` by 6% of the table and still be printed across the
number, which is what Dan photographed.

The bet gets a rectangle (`isOnChipMarker`), like the board and the top seat
boxes already have, and the puck's placement search must clear it.

The label's width is bounded rather than measured — this module has no DOM, and
a keep-out that grew with the pot would move the puck mid-hand. Bounding it
meant bounding the CSS: `.cp-amount` on the felt goes 0.9rem -> 0.7rem, because
at 0.9rem the widest amount is 12.4% of a phone table and no position on the
puck's boundary clears that without walking it most of the way to the next
chair. `CHIP_AMOUNT_CHAR_PX` is derived from the font size; change one, change
both.

Depth was tried as a second search axis and reverted: "player, then button, then
chips" is measured as the fraction of its own boundary the puck reaches, with a
0.02 tolerance, and the shallowest useful step was 0.94.

## Database

`20260827g_ticker_toggles_player_and_club.sql` — `user_table_settings.show_ticker`
and `clubs.ticker_enabled`, both `NOT NULL DEFAULT true` (today's behaviour).
Applied to production and verified via `information_schema` before this was
written.

Item 6 (the ticker switches) is wired as: the player's half gates the render,
the club's half is applied in `loadScope`, because the starting-soon AND overlay
queries are both scoped by the ids it returns and `OverlayAnnouncement` carries
no club id to filter on later. That lookup fails OPEN — a transient RLS or
network error must not silently cost every table the five-minute call.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` (client) — 7534 passed, 477 files.
- `npx vitest run` (server) — 1994 passed.
- Six existing source-grep tests pinned shapes this commit deliberately
  replaced; all six were updated here rather than left for someone else, and
  two of them got stronger assertions in the process.

**Not verified on hardware.** Every layout item above is reasoned from the
stylesheets and the geometry module, and the geometry has unit coverage, but
nobody has looked at these on a phone yet. Items 2, 4 and 5 are the ones worth a
glance first.
