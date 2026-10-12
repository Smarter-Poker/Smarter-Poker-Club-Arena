# Ten mobile live-table bugs from Dan's pre-launch test (2026-10-04)

Dan tested Club Arena live games on his phone and listed ten defects to fix
before launch. Each is fixed at its cause and pinned; this file is the map.

## 1. Club lobby cards blew up for a moment after navigation

`CarouselSection` loaded `ClubCardPanel` and `DiamondArenaCard` as two lazy
chunks that share one stylesheet, and started both imports in the same render.
Vite's preload helper waits for a stylesheet only in the import that creates
its `<link>`; the second card mounted before `ClubCardPanel.css` had applied,
so its cover `<img>` printed at natural size (896x1200) until the sheet landed.
Both cards are static imports now, so the sheet ships with the page, and the
art well paints the card's own dark glass before the image loads.
Pin: `tests/components/clubCardGeometryFromFirstPaint.test.tsx`.

## 2. A tournament tab said "MTT 200/400"

The pill's sub-line was cash logic (pot, else stakes) and a tournament reports
its current blind level as stakes. A tournament tab now prints its code over
its buy-in total ("Free Buy" for a freeroll), never blinds or a pot; live hole
cards still replace the label. Law: `tests/a-tournament-tab-says-its-buy-in.law.test.tsx`.

## 3. The tournament info box sat over the top of the table

It was a bar in the felt's upper-right HUD corner, across the top seats on a
phone. It is now a collapsible dock fixed under the action bar
(`TournamentHUD.css`), and the corner holds Dan's LOBBY plate, which opens the
tournament lobby. The felt reserves the open dock's height as a constant on
every tournament table, so collapsing the dock moves only the bars. Cost,
stated plainly: a tournament felt is one dock (50px) shorter than a cash felt.
Law: `tests/the-tournament-box-is-under-the-action-bar.law.test.ts`.

## 4. The neon-blue turn ring emptied in about half its fifteen seconds

The acting seat re-renders once a second, and every render rewrote the ring's
negative `animation-delay` to the new elapsed time. A browser re-times a
running animation when its delay changes, so the ring advanced by real time
AND by the rewritten delay: twice real speed, empty at about 7.5s. The seed is
now frozen once per turn. The front-loaded easing is gone, the sweep is linear
along the plate's border rather than in angle, and the last-five-seconds flash
no longer dims the arc to 20%. Pin: `tests/seatslot-countdown-duration.test.tsx`.

## 5. "x3" multipliers on pot and bet chips

Removed everywhere (Dan: the chips are an animation, the number is the truth).
Pin: `tests/chips-on-the-felt.test.tsx`.

## 6. ALL IN was silently refused where only a call was legal (ENGINE)

`HandController.performAction` returned false for an `all_in` that would raise
when the player may not reopen betting (or when a pot-limit / capped-table
rewrite made the raise illegal). The press is now executed as a plain call (or
a check when nothing is owed): the player commits exactly the call, keeps the
rest, and history says `call`. The menu horses choose from is unchanged.
Law: `server/src/engine/AnAllInPressCountsAsACall.law.test.ts`.
This is an engine change and activates at a maintenance cutover.

## 7. Hole cards stayed up through the maintenance break

The post-hand reset cleared the board, pot and winner but never the hole
cards; only the next deal replaced them. The reset now records which hand
finished and a finished hand (or any hand while the tables are parked for the
break) is not drawn on a seat or on the tab pill. State is untouched.
Law: `tests/a-finished-hands-cards-leave-the-felt.law.test.ts`.

The second break Dan saw at :11 is NOT a second schedule. It is the "Deployment
Recovery" window from the 2026-09-17 owner update: after a failed :55 engine
release, the release transaction may request one extra certified break. It
fired on 2026-10-03 at 14:11 UTC after release run 37128652461 failed at 14:09.
It is left in place pending Dan's decision; see the hand-off note.

## 8. Quick Join from a tournament listed cash games

The only tournament branch was for Spins; an MTT or SNG fell through to the
cash query. From a tournament it now lists joinable tournaments (same variant
first, nearest buy-in), JOIN opens that tournament's own lobby page, and Browse
Full Lobby lands on the tournament list.
Law: `tests/a-tournament-offers-more-tournaments.law.test.ts`.

## 9. Win percentages drawn behind a neighbouring player

Each badge was a child of its own seat wrapper, so its z-index counted only
inside that seat; two seats in one runout were lifted to the same level and
the later one painted over the earlier one's badge. The badges are one layer
above every seat now (`EquityBadgeLayer`), placed from measured boxes by
`lib/equityBadgePlacement.ts`, which refuses any spot touching a displayed
card. Law: `tests/win-percentages-are-the-top-layer.law.test.ts`.

## 10. "Reconnecting Your Seat" after a table move, and cut off

The move was announced by only one of the two paths that hear it; when the
engine socket won the race the tab was re-pointed in silence. Both paths share
one once-per-destination announcer now, and for the hand-over the felt line
reads "You've Been Moved To <table>". The reconnect line itself was hung from
the felt's centre (`left: 50%`), which caps an absolute box at half the table,
and ellipsized; it is pinned at both edges and wraps.
Law: `tests/a-moved-seat-is-not-a-reconnecting-seat.law.test.tsx`.

Not changed: the engine can still read a just-moved player as MISSING at the
destination until their browser's first heartbeat there. The felt no longer
calls that "reconnecting", and falls back to the real line after ten seconds.
