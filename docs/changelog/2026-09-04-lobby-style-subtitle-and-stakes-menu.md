# 2026-09-04 — The lobby says Classic / Action / Madness, and the Stakes heading is a menu

Dan, from a desktop screenshot of the NLH tab: "UNDER ALL THE GAMES TITLES
INSTEAD OF REPEATING THE STAKES AGAIN, SHOULD JUST SAY 'CLASSIC' 'ACTION' OR
'MADNESS' ON THE DESK TOP DISPLAY. 2, YOU NEED TO ADD AN 'ACTION SELECTOR' IN
THE STAKES DROP DOWN WHERE USERS CAN SELECT 'CLASSIC' 'ACTION' OR 'MADNESS' AS
AN OPTION. AND THE BAR POP UP SHOULD HAVE A 'SORT' HIGH TO LOW, OR LOW TO HIGH
INSIDE OF IT."

## 1. The second line

What the board showed: `NLH 0.10/0.25` over `.10/.25 Classic`, `NLH 0.05/0.10`
over `.05/.10`. The name reaches `cashTitleLines` after `formatGameTitle`,
which rewrites every sub-dollar blind without its leading zero, and
`STAKES_HEAD` demanded that zero (`\d+`). So on every micro table the stripper
missed the stakes and line two began with the stakes line one had just given.
The 2026-09-04 hardening note (H6) had reordered the game names to
`NLH 1/2 Classic` precisely so this stripper would leave `Classic` behind; it
worked for `1/2` and failed for every stake under a dollar.

Two changes, both in `src/components/lobby/lobbyEntries.ts`:

- A templated game (a `cash_games` row; `entry.game.template` from
  `get_club_home`'s `cluster_template`) takes its second line straight from the
  template - `Classic`, `Action` or `Madness`, the labels in
  `src/config/cashGames.ts` - and never from the table name.
- `STAKES_HEAD` accepts a leading-dot decimal (`.10/.25`) on both sides, so an
  untemplated table named `NLH 0.05/0.10` has no second line and one named
  `NLH 0.25/0.50 Late Night` says `Late Night`.

The mobile card (`cashCardTitle`) is unchanged: its title is the table name
and its second line the club or the long variant name, which is what Dan
approved for phones.

## 2 and 3. The Stakes heading opens a menu

On the phone sort bar and the desktop column heading alike, the way the
Variant heading does (2026-09-03), the Stakes heading now opens one menu with
two groups:

- **Game Style** - All, Classic, Action, Madness. Multi-select; All clears
  and closes. The selection is the saved Advanced Filters value for the tab
  (`styles`, a new field beside `games`), so the sheet - which gained a
  "Game Style" chip row on the three cash tabs - and the menu can never
  disagree, and it syncs across devices with the rest of the store.
- **Sort** - High To Low, Low To High. Names its direction outright
  (`applySort(COL_STAKES, dir)`) rather than flipping whatever the last click
  did, writes the same remembered sort as a heading click, and closes.

A chosen style hides tables of other styles AND tables of no style. That is
a deliberate exception to the spec's "a filter that cannot be evaluated
passes" rule, and the reason is written beside `FilterableRow.style`: null
here is not an unknown, `get_club_home` reports it for every row, and a
player who asked for Action games did not ask for the fleet's untemplated
ones.

Without style choices (a tab whose spec has none) the Stakes chip is the
plain asc/desc toggle it was. The two heading menus share one open state, so
opening Stakes closes Variant and vice versa.

Files: `LobbyTable.tsx` (StakesMenu, props, both triggers), `LobbySortBar.css`
(the group eyebrows), `advancedFilterSpec.ts` (`styles` on the spec, the
value, the row, the decision, the active dot), `AdvancedFilters.tsx`
(sanitise, count, chip row), `ClubHomePage.tsx` (the row's template, the
props on HOLDEM / OMAHA / LIMIT).

Tests: `tests/unit/lobbyStakesMenuAndStyleSubtitle.test.tsx` - 13, rendered
like the Variant menu's test: the subtitle for each template and for the
dot-decimal names, the filter's three answers, the sanitiser on legacy and
junk values, the menu's items in order, toggle / All / close, both sorts
applied to the board and announced, Escape and outside tap, the plain chip
without choices, and the desktop heading's wiring. The existing
`lobbyMobileControls` proximity pin (`role="status"` near `lobby-sortbar`) is
kept by moving the sr-only live region above the chips, where order does not
matter to it.
