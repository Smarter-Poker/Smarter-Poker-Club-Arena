# 2026-09-05 - The felt says a move is coming, the list has names, the mobile card says the style, the Stakes menu counts styles, and staff see the tick

Operation Table Stakes, after `2026-09-05-the-must-move-lobby.md` ("Still
owed": a "moving in N hands" countdown, the placard squash). Client only; no
migration, no engine change, no new RPC.

## 1. "Seat Open On Main 2. Moving After This Hand." stays on the felt

The engine's `SEAT_MOVE_PENDING` was a toast: shown once, gone in seconds, and
the hero then played a whole hand not knowing whether they were still leaving.
`CashClusterHUD` (the Must Move box in the upper-right corner) now renders the
sentence under the bar for as long as `fn_cash_game_lobby` returns a
`me.pending_move` for the viewer - the same read it already polls every 10 s
and re-reads at once on `SEAT_MOVE_PENDING` / `SEAT_MOVED` / `SEAT_MOVE_HELD`.
It leaves when the move has executed (the read no longer returns it) and the
tab follows the chair.

**There is no N.** `cash_seat_moves` carries no hands-until; a move executes at
the player's NEXT hand boundary, always. So the copy is "After This Hand" and
never "In N Hands", and the test pins that the table has no such column. The
sentences, by reason, from one helper (`pendingMoveNotice` in
`src/services/cashGameLobby.ts`) that the Must Move Lobby now uses too so the
felt and the lobby cannot disagree:

- must move: `Seat Open On Main 2. Moving After This Hand.`
- break: `This Table Is Closing. Moving To Main 2 After This Hand.`
- seat change: `Seat Change Granted. Moving To Main 2 After This Hand.` /
  `... Swapping To ...` / held: `Seat Change: Waiting For The Other Table To
Finish Its Hand.`

Placement: the `hud-ur-column`, above the seats and at the opposite end of the
screen from the action buttons. 240 px wide at most, 200 px at the phone
breakpoint (the bar above it is 236 px on a 390 px phone), `pointer-events:
none`, `role="status"`. Solid Facebook blue, white, bold - the one message in a
corner of controls. The toast still fires once; the notice is what remains.

## 2. The must-move list has names, numbers and You

`fn_cash_game_must_move_list` already posts `pos`, `alias`
(`fn_player_display_name`) and the table; the lobby already rendered them.
What changed: `mustMoveListRows` (pure) orders by position regardless of JSON
order, reads a blank alias as "Player" (never blank, never a uuid), labels the
table Main 1 / Main 2 / Feeder, and flags the viewer's own row, which is now
highlighted AND tagged **You** with `aria-current`. Avatars were not added:
the lobby read carries none and a per-row profile fetch for a 5 s-polled
list is not cheap; the name and the number are the point.

## 3. The mobile card says the style

The desktop board has said Classic / Action / Madness on line two since
2026-09-04; the phone card (`cashCardTitle`, non-PLO branch) said the club or
the long variant name. A templated game now leads its second line with the
style ("Action", or "Madness, Deep Stack Society" on a union board), the
variant giving way to it as on the desktop - unless the title already carries
the word (the default game name is "NLH 1/2 Classic"), in which case the line
Dan approved for phones is kept. The stakes and the player count are separate
zones of the card and are not touched; an untemplated table is exactly as it
was. The PLO branch already said the style through `cashTitleLines`.

## 4. The Stakes menu counts styles

`countStylesOnBoard` (pure, `lobbyEntries.ts`) counts GAMES per style - one
per cluster front, so a three-table game counts once; tables of no style are
not counted. `ClubHomePage` derives it from `tables` (already loaded) for the
current tab and BEFORE the style filter, so a player narrowed to Action still
reads how many Classic and Madness games they are not looking at. No network
call. The menu prints "Classic 12 / Action 4 / Madness 2" under the Game Style
eyebrow and the figure on the right of each item (`aria-label` "Classic, 12
Games"). Without counts the menu is byte-for-byte as it was.

## 5. Staff see the tick

`GameLobbyPanel` gains `staff` (ClubHomePage passes `isOwner ||
isClubStaff(userRole)`, the notice board's own test). On a must-move game, for
staff only, it reads `cash_games.last_tick_at, last_tick_actions` straight off
the row (the `cash_games_read` policy already grants `authenticated` the row;
no RPC was widened) on open and every 10 s, and prints one monospace line
under Game Information:

    Tick 4s Ago: Moves Planned 2, Feeder Opened, Buyers 3

`last_tick_actions` is a jsonb array of one-key objects appended as the tick
acts; `tickActionsCopy` turns keys into Title Case words, prints counts, words
and the first 8 characters of a uuid, and says "Quiet" for an empty pass.
"No Tick Yet" when never ticked; amber after two minutes of silence
(`TICK_STALE_MS`). Pure helpers in `src/components/lobby/cashGameTick.ts`.

## Also: main was red on `tsc`

`MultiTablePage.tsx` declared `parseTimed` twice - #3104 and #3106 fixed the
same outage in the same hour and both merged (TS2393 on every branch). The
exported declaration stays; both pinning tests still pass.

## Tests

`tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx` - 27: the
sentence per reason and its destination, Title Case / no em dash, the
no-hands-until pin, the corner notice present / absent / gone after the move
and not for an unseated viewer, the CSS cap, list ordering / names / You, the
mobile card's five cases, the counts and the line, the menu with and without
counts, the page deriving them without a fetch, the tick copy, the stale flag,
and the staff-only wiring. `tests/must-move-lobby.test.tsx` and
`tests/unit/lobbyStakesMenuAndStyleSubtitle.test.tsx` unchanged and green.
Client suite: 996 files green, 13,707 tests; the one red file is the
pre-existing `sharp` import in
`the-media-optimizer-remembers-and-is-idempotent.law.test.ts`.
