# Lane G - the client lobby for must-move cash games

Scope: the board a player reads before they sit down. `lobbyEntries.ts` (the
cash / cluster branches), `cashGameLobby.ts`, `CashGameCard.tsx` + `.css`,
`ArenaLobbyGameCard.tsx` + `arenaGameCardAdapter.ts`, `LobbyTable.tsx` +
`.css`, the sort bar inside `LobbyTable.tsx`, `advancedFilterSpec.ts`,
`GameLobbyPanel.tsx`, `CasinoPlaque.tsx`, `lobbyCardContext.ts`, and the cash
half of `ClubHomePage.tsx`.

**The brief named the wrong database.** It gave `ydsaqnnuwyvtyxgvrnys`
(pepnationlab-prod), which holds no `cash_*` object at all - `get_club_home`
came back `42883: function does not exist`. Every reading below was re-taken
from **`kuklfnapbkmacvwxktbh`** (PokerIQ-Production, the id in CLAUDE.md
section 2) between 21:40 and 22:50 UTC on 2026-09-09. An empty answer from the
wrong database is not evidence that nothing is wrong (CLAUDE.md 10.86).

Nothing was committed, pushed or applied.

---

## 0. WHAT WAS READ LINE BY LINE

Client:

| file | what was read |
| --- | --- |
| `src/components/lobby/lobbyEntries.ts` | `LobbyTableRow` (all cluster fields), `LobbyEntry.game`, `cashStatus`, `isClusterFront`, `isHiddenClusterMember`, `cashEntry` in full, `seatsTakenLabel`, `cashTemplateLabel`, `countStylesOnBoard`, `styleCountsLine`, `cashTitleLines`, `VARIANT_HEAD` / `STAKES_HEAD`, `classifyTournament` |
| `src/services/cashGameLobby.ts` | all 346 lines: every interface, `lobbyTableLabel`, `isMainOne`, `pendingMoveDestination`, `pendingMoveNotice`, `mustMoveListRows`, `fetchCashGameLobby`, `SEAT_CHANGE_REFUSALS`, `seatChangeRefusalText`, `requestSeatChange`, `cancelSeatChange`, `seatChangeOutcomeText`, `joinCashGame`, `JOIN_GAME_REFUSALS`, `joinGameRefusalText`, `waitlistedText` |
| `src/components/cash/CashGameCard.tsx` + `.css` | all 288 lines: the three `ZONES` maps, `zoneStyle`, `shrink`, the render, `rulesLineFor` |
| `src/components/lobby/game-cards/arenaGameCardAdapter.ts` | all 186 lines: `compactCashBuyInLabel`, `stripTableIndex`, `repeatsTitle`, `cashCardTitle` (both branches), `familyOf`, `statusOf`, `arenaGameCardDataFromEntry` |
| `src/components/lobby/game-cards/ArenaLobbyGameCard.tsx` | all 236 lines: `arenaGameCardActionsForEntry` (cash branch line by line), the figure cache, the wrapper |
| `src/components/lobby/game-cards/ArenaGameCard.tsx` / `.css` | `LiveValue`, `NlhMachine`, `PloMachine`, `zoneText`, the `--agc-players-*` zone variables and the `Players` label rule |
| `src/components/lobby/LobbyTable.tsx` | `GameCounter`, `SeatsMeter`, `StartsCell`, `COL_NAME` cash branch, `COL_ACTIONS` cash branch, the Stakes menu / style counts wiring |
| `src/components/lobby/advancedFilterSpec.ts` | `CASH_STYLES`, `CASH_STATUSES`, the three cash `FILTER_SPECS`, `FilterableRow`, `variantKey`, `rowPassesFilter` (games / styles / range / seats / statuses) |
| `src/components/lobby/GameLobbyPanel.tsx` | the cash CTA `useMemo`, the seat-map effect, the staff tick effect, the Game Information list, `cashMachineData` |
| `src/components/lobby/CasinoPlaque.tsx` | `PlaqueSeats` |
| `src/components/lobby/lobbyCardContext.ts` | all 30 lines |
| `src/pages/ClubHomePage.tsx` | the club-home cache helpers, `TableData`, `mergeFastRows`, the realtime admission rules and `handleTableChange`, the `get_club_home` fast path, the chain `tableQuery` and its merge, `styleCounts`, `filteredTables`, `lobbyEntries`, `handleJoinTable`, `loadMyGameStates`, the waitlist effects |

Database (live bodies, `pg_get_functiondef`): `get_club_home(text)`,
`fn_cash_game_lobby(uuid)`, `fn_cash_game_join(uuid)`,
`fn_cash_cluster_census(uuid, timestamptz)`; plus the `cash_games_read` RLS
policy and the `tables_cluster_id_fkey` constraint.

Tests read: `tests/a-game-counts-its-players-like-a-tournament.law.test.ts`,
`tests/must-move-lobby.test.tsx`,
`tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx`,
`tests/unit/lobbyStakesMenuAndStyleSubtitle.test.tsx`,
`tests/unit/cashGameCard.test.tsx`,
`tests/cash-games-are-created-from-a-template.law.test.tsx`,
`tests/club-home-cache-version.test.ts`.

---

## 1. THE HEADLINE: HANDOFF ITEM 5.2, THE THREE DERIVATIONS - **DONE**

### What the three were

| | tables | players |
| --- | --- | --- |
| `fn_cash_cluster_census` (the authority the controller runs on) | census predicate | seats on census tables |
| `get_club_home` (fast path) | census predicate | census predicate |
| `fn_cash_game_lobby` | census predicate | per-table `seated` |
| **the client** | `Number(t.cluster_tables ?? 1) \|\| 1` | `Number(t.cluster_players ?? t.current_players ?? 0)` |

`20260906163151` had already made the three SQL readers agree verbatim on

```sql
coalesce(is_deleted, false) = false
AND status IN ('waiting', 'running', 'active')
AND lifecycle <> 'closed'
```

The client was the fourth answer, and it was not merely a fallback.

### P1 - the game's PLAYERS figure was frozen at first paint (fixed)

`cluster_players` and `cluster_tables` are computed inside `get_club_home`.
They are not columns. Nothing else on the client ever writes them:

* the fast path runs **once** - `if (listsPaintedRef.current) return;` skips it
  on every warm reload (the 90 s timer, `visibilitychange`, every bus event);
* the authoritative chain `tableQuery` never selected them, and
  `mergeFastRows` deliberately keeps a value the incoming row does not carry;
* realtime `handleTableChange` merges `{...t, ...updated}` where `updated` is a
  raw `public.tables` row, which has no such columns.

So on a board left open, a must-move game's PLAYERS number never moved again
while the feeder filled and emptied underneath it. The `1 Table` / `10 Tables`
line beside it was frozen the same way, so a feeder opening or breaking was
invisible until a full reload.

### P1 - the boot cache painted a game as one table with Main 1's seats (fixed)

`setClubHomeCache` stored **the chain's** rows, which carry no cluster figures.
On the next visit `getClubHomeCache` hydrates `tables` from that entry and the
board paints from it immediately - so the fallback fired for real, on the
instant-paint path every returning player sees:

* `cluster_tables ?? 1` printed **"1 Table"** for a three-table game;
* `cluster_players ?? current_players` printed **Main 1's own seat count** as
  the whole game's count - a 30-player game reading "6", which is the same
  class of lie as the "0/6" R10 was written to kill, in the other direction.

### The one definition, and why it is derived on the client rather than read

`tables.current_players` is `count(table_seats where left_at is null)`
denormalised. Read on production 2026-09-09 over every live cluster table:

```
live_tables 137 | live_mismatch 0
shapes {"running/live/false":69,"waiting/live/false":68,
        "waiting/closed/false":2,"closed/closed/false":4374,"closed/closed/true":1}
```

Zero drift, which is what lane A measured independently. So summing
`current_players` over a cluster's census rows **is** the census count.

`src/components/lobby/lobbyEntries.ts` now exports one predicate and one
derivation, and they are the same rule the SQL runs:

```ts
export function isCensusTable(t): boolean       // the three SQL clauses, verbatim
export function clusterFigures(rows): Map<string, {players, tables}>
export function withClusterFigures(rows): rows  // stamps every cluster row
```

`ClubHomePage.boardTables` drops any cluster row that is not a census table
(so what is COUNTED and what is RENDERED are the same set) and stamps the
figures over whatever a read painted. `cashEntry` reads the stamp; the
`?? 1` / `?? current_players` arithmetic is deleted.

**Why not the other direction** (keep the SQL value, delete the fallback, prove
SQL always supplies it): it cannot fix either defect above. The value would
still be written once per cold load and never again, because PostgREST cannot
recompute it and realtime does not carry it. Deleting the fallback alone would
turn the frozen number into an absent one. Deriving it is what makes the
client's answer track the database's between reads, and it is the SAME
definition rather than a second one - the predicate is the census predicate,
and the input is the census input.

**Where it can still disagree, stated honestly:** both reads cap at 200 rows
and both order by `current_players DESC` first, so the cap can only ever trim
the EMPTIEST tables. A trimmed empty feeder would leave its game one table
short. Measured 2026-09-09, the two scopes that exist hold **69** and **67**
tables, and `fronts_past_200 = 0`. This is a real bound, not a theoretical one,
and it is the reason the cap orders by occupancy.

**A game with zero seats** is the case the coordinator asked about: a dormant
game (62 of them right now, `state='dormant'`, `enabled=true`, one table, zero
players). Its Main 1 is a census table, so it derives `tables 1, players 0` and
the card reads PLAYERS 0 / TABLES 1 - exactly what OPORD 1.4 s2.8 requires
("the card still renders with PLAYERS 0 and TABLES 1"). The old fallback got
this right by accident; the derivation gets it right by construction.

---

## 2. FINDINGS

### P1 (latent today, and it has happened) - a disabled game offered JOIN GAME that could only fail (fixed)

`fn_cash_game_join` opens with

```sql
IF NOT g.enabled THEN
  RAISE EXCEPTION 'GAME_CLOSED: this game is not taking players'
```

and `JOIN_GAME_REFUSALS.GAME_CLOSED` has existed to translate it since the door
was written. **No board state could ever reach it.** `cashEntry`'s cluster
branch derived status from the player count ALONE - `players > 0 ? Running :
Open` - and `cash_games.enabled` was selected by neither read, so a disabled
game holding a live table rendered as a joinable "Open" game whose Join throws.

**Graded honestly against the board as it stands.** Of the 144 tables a lobby
can currently show, **zero** belong to a disabled game:

```
with_game 144 | on_disabled_game 0 | null_template 0 | private_games 0 | total 144
```

So nothing exhibits it at this instant. It is not theoretical either: 41 games
are `enabled=false` right now, `fn_cash_cluster_tick` only closes an **empty**
table of a disabled game, and the twelve games retired by `20260906004318`
were retired with horses seated - "anybody seated finishes their hand, stands
up through the ordinary door". Every minute of that window is a board offering
Join Game on a game whose door refuses. That is a P1 the population happens not
to be showing today, not a P3.

Fixed at the source: the chain read now embeds the game row
(`cluster:cash_games!tables_cluster_id_fkey(template_name, must_move, state,
enabled)`), and `cashEntry` returns `closed` / `Closed` for
`cluster_enabled === false`. The three surfaces that offer the action say so
instead of offering it: `LobbyTable`'s action column, the mobile card's
`arenaGameCardActionsForEntry`, and `GameLobbyPanel`'s CTA. A player already
seated still gets Return To Game, because a closed game still owes them their
chair. An embed RLS withholds leaves `cluster_enabled` undefined rather than
false, so the failure direction is "keep offering a live game", never "hide
one".

The embed is a second win: `cluster_template` - the Classic / Action / Madness
subtitle, the style filter and the Stakes-menu counts - came from
`get_club_home` alone, so on a warm reload the style could go missing while the
chain rows won the race. It now arrives on every load from the authority.
Measured: `null_template 0` and `private_games 0`, so the embed is populated
for every row and its RLS predicate short-circuits on the cheap arm.

### P1 - a player seated on the feeder was offered JOIN GAME (fixed)

R10 makes the game's row its Main 1. `lobbyPlayerStateOf` asks
`ctx.seatedIds.has(entry.id)` - Main 1's **table** id. A player sitting on
Main 2 or the feeder is not in that set under the row's id, so the board
offered them "Join Game" for a game they are already playing in, and pressing
it calls `fn_cash_game_join`, which answers `action: 'seated'` and navigates
them back - a dead-looking tap with a detour through the door.

`loadMyGameStates` builds `seatedIds` from `table_id, tables(tournament_id)`,
so it holds table ids and tournament ids and **no cluster id**. The fix is
therefore in two halves and only one of them is mine: `lobbyPlayerStateOf` now
also tests `entry.game.id`, and `LobbyTable`'s cash action column routes
through `playerStateOf` instead of re-spelling `seatedIds.has(e.id)` by hand.
**The other half - putting the cluster id into the set - is one line in
`loadMyGameStates` and I did NOT make it**; see section 5.

### P1 - a table the controller closed stayed on the board (fixed)

The realtime UPDATE branch drops a row on `is_deleted`, `status='closed'` and
`status='deleted'`. The cluster controller closes a table by flipping
**`lifecycle`** to `'closed'`, and it does not always move `status`: read on
production, two rows sit at `status='waiting', lifecycle='closed'` right now.
`get_club_home` excludes them, so a reload made them vanish - but until the
reload the board kept a card for a table that no longer exists, and (before
this lane) counted its seats into its game. Added `updated.lifecycle ===
'closed'` to the drop rule.

### P1 - the status chips called a must-move game Full (fixed)

`rowPassesFilter`'s cash status chips read `seatsTaken >= cap`. On a game row
`cap` is `max_players` of Main 1 and `seatsTaken` was `current_players` of Main
1, so a busy game answered the **Full** chip and failed the **Open Seats**
chip - the exact thing R10 forbids ("no FULL: a full Main opens a feeder"). A
player filtering for Open Seats had every busy game hidden.

`FilterableRow` gains `game?: boolean`. On a game row: never Full, always Open
Seats (the door seats you or holds your place), Empty when the whole game is
empty - and `seatsTaken` is now the game-wide count, so Empty means empty.

### P2 - the panel printed a table's shape on a game (fixed)

`GameLobbyPanel`'s Game Information list printed `{entry.players} / {entry.capacity || '-'}`, which on a cluster row is `57 / -` because R10 sets
capacity to 0. `PlaqueSeats` did the same on the plaque, with twelve seat pips
under it. Both now take the game shape: `57 Players / 3 Tables`, no
denominator, no pips - the same two figures the board row and the Gate 4 card
show.

### P2 - `cashGameLobby.ts`: read in full, one gap found, not fixable here

Every string is Title Case with no em dash and every refusal code in
`SEAT_CHANGE_REFUSALS` matches a code the live functions raise. `LobbyMe.waitlist` is typed `{ waiting; position; on_list }` but
`fn_cash_game_lobby` returns whatever `fn_cash_game_waitlist_position(g.id)`
returns, and that function is **not in the database** - it does not appear in
`pg_proc`. The lobby read therefore raises `42883` for any signed-in caller...
except it does not, because the call is inside `CASE WHEN me.table_id IS NULL`,
so it only fires for a viewer who is **not seated**. That is the waitlist
holder - the one person the branch exists for. **This is lane H's surface**
(`CashClusterHUD` / `MustMoveLobbyModal` are the only readers) and the fix is a
SQL function, so it is reported, not touched. See section 5.

### P2 - `CashGameCard.tsx` has no caller in the lobby (reported, not changed)

The three pieces of Dan's approved artwork are wired into
`CashGameCreateFlow` only - the create flow's preview. The LOBBY renders
`ArenaGameCard` instead. That is not a defect on its face (the Arena machine
is also painted art, not a flat panel, so #ClubArenaConsole holds), but OPORD
1.4 s2.9 item 15 says "every cash lobby card is a game card" and the Gate 4
card was specified as this component. `CashGameCreateFlow` is lane I's file
and the decision is a design one, so it is raised rather than resolved.

### P3 - `#ClubArenaConsole` compliance of what this lane touched

Nothing flat was introduced. The two new pieces of copy print inside existing
painted chassis: the disabled action reuses `lt-act--done` (the same machined
pill "Leave Waitlist" uses), and the new plaque line reuses
`cplaque__seats-num`. The separator is a middle dot (`·`), written as an
escape so `check-ui-text` cannot mistake a matcher for a message, and there is
no em dash anywhere in the diff.

---

## 3. CHECKED AND FOUND CORRECT (no change)

* **JOIN GAME calls the door, never Main 1.** `handleJoinTable` tests
  `row.cluster_id && row.cluster_must_move !== false`, calls `joinCashGame`,
  and navigates to `r.table_id` - the shortest live Main with an unreserved
  chair, then the feeder (read off the live `fn_cash_game_join` body). The
  waitlist branch navigates to Main 1 to WATCH while the place is held, which
  is deliberate and commented.
* **The waitlist copy.** `waitlistedText` prints the opening-hold sentence
  ("The Next Table Opens When One More Player Sits") only when the door
  returned `opening_hold_since`, and the numbered form otherwise.
* **The refusal vocabulary.** Every code in `SEAT_CHANGE_REFUSALS` and
  `JOIN_GAME_REFUSALS` matches a string the live functions raise, and
  `GAME_BARRED` is deliberately delegated to `cashBuyInRefusalText` so the two
  doors cannot quote different bars. Title Case, no em dash, all branches.
* **The style subtitle.** `cashTitleLines` reads the template off the game row
  rather than parsing it back out of a table name; `cashCardTitle` leads the
  phone card's second line with the style unless the title already says the
  word; `countStylesOnBoard` counts one per cluster front, so a three-table
  game counts once, and `styleCountsLine` prints zeros rather than gaps.
* **One row per GAME.** `isHiddenClusterMember` removes every non-front cluster
  row before entries are built, and the chain select has carried the identity
  columns since 2026-09-05, so the ~300 ms overlay leak stays fixed. The v3
  boot cache could still reintroduce it for entries written before that date
  (TTL is seven days, so up to 2026-09-12); the v4 bump closes that window.
* **An old bookmark to a feeder table id.** `?game=<id>` is resolved against
  the built entries and dropped on the first loaded list if it matches none, so
  a bookmarked feeder - which is never an entry under R10 - closes cleanly
  instead of lying in wait. A selected row that leaves the list closes the
  panel. Both were already correct.
* **`pendingMoveNotice`** matches the engine's wording for all four reasons and
  carries no "in N hands"; `cash_seat_moves` has no hands-until column, which
  `movingAfterThisHandAndTheLobbySaysTheStyle` already pins.
* **Realtime lag.** With the derivation in place the figures now move on every
  `tables` UPDATE (a seat transition writes `current_players`), and the 90 s
  reload plus `visibilitychange` re-derive from a fresh chain read. If realtime
  drops entirely the numbers are stale until the next reload - which is
  strictly better than before, where they were stale until the tab was closed.
* **No `.single()`, no emoji, no `.limit()` on an array, no em dash** anywhere
  in this lane's diff.

---

## 4. THE HUNKS I OWN

Shared files - the integrator should reconcile these against lanes H and I:

| file | hunks |
| --- | --- |
| `src/components/lobby/lobbyEntries.ts` (+145) | `LobbyTableRow` gains `cluster_enabled`, `is_deleted`. New block immediately before `cashEntry`: `isCensusTable`, `ClusterFigures`, `ClusterFigureSource`, `clusterFigures`, `withClusterFigures`, `clusterFiguresOf`. `cashEntry`: the `cluster` / `gamePlayers` / `st` derivation only. Nothing else in the file is touched. |
| `src/pages/ClubHomePage.tsx` (+99) | imports (`isCensusTable`, `isClusterFront`, `withClusterFigures`); `CLUB_HOME_CACHE_VER` v3 -> v4; `TableData` gains six cluster fields; `handleTableChange` UPDATE adds `lifecycle === 'closed'`; the chain `.select(...)` adds the `cluster:cash_games!tables_cluster_id_fkey(...)` embed; the merge flattens the embed into `flattenedTables`; `setClubHomeCache` stores the flattened rows; new `boardTables` memo; `styleCounts` and `filteredTables` read `boardTables`; the `rowPassesFilter` call gains `game` and a game-aware `seatsTaken`. |
| `src/components/lobby/LobbyTable.tsx` (+18) | cash action column only: `seated` via `playerStateOf`, the `closed` branch, `!closed &&` on the waitlist and join buttons. |
| `src/components/lobby/GameLobbyPanel.tsx` (+45) | the cash CTA's closed branch; `PlaqueSeats` gains `gameTables`; the Players row becomes Players + Tables on a game. |
| `src/components/lobby/advancedFilterSpec.ts` (+12) | `FilterableRow.game`; the `full` and `open` status arms. |
| `src/components/lobby/game-cards/ArenaLobbyGameCard.tsx` (+13) | the `entry.status === 'closed'` branch in the cash arm of `arenaGameCardActionsForEntry`. |
| `src/components/lobby/lobbyCardContext.ts` (+8) | `lobbyPlayerStateOf` cash branch: also match `entry.game.id`. |
| `src/components/lobby/CasinoPlaque.tsx` (+21) | `PlaqueSeats` gains the `gameTables` shape. |
| `tests/one-definition-of-a-games-players.law.test.ts` | the client half of the law appended (19 new assertions in 6 describes). The existing SQL half is untouched. No new law file, so no `docs/laws.d/` entry is owed - it is the same law. |

I did not touch `CashClusterHUD`, `MustMoveLobbyModal`, `TablePage`,
`MultiTablePage` or `CashGameCreateFlow`. No migration was written by this
lane; every fix is client-side.

---

## 5. THE GATE

Run on the host, on the full worktree (so these numbers include every other
lane's edits sitting beside mine):

```
npx tsc --noEmit
  -> EXIT:0, no diagnostics
```

```
npx vitest run \
  tests/one-definition-of-a-games-players.law.test.ts \
  tests/a-game-counts-its-players-like-a-tournament.law.test.ts \
  tests/unit/cashGameCard.test.tsx \
  tests/unit/lobbyStakesMenuAndStyleSubtitle.test.tsx \
  tests/must-move-lobby.test.tsx \
  tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx \
  tests/club-home-cache-version.test.ts \
  tests/cash-games-are-created-from-a-template.law.test.tsx \
  tests/unit/lobbyCardsDoNotFlicker.test.ts \
  tests/unit/lobbySortIsNotAFilter.test.ts \
  tests/lobbyNeverHidesALiveGame.law.test.ts \
  tests/unit/lobbyFiltersCrossDevice.test.ts \
  tests/unit/lobbyMobileCards.test.ts \
  tests/unit/deadLobbyIsGone.test.ts \
  tests/unit/seatFirstLobbyRouting.test.ts \
  tests/law-registry.law.test.ts

   Test Files  16 passed (16)
        Tests  537 passed (537)
   EXIT:0
```

`tests/one-definition-of-a-games-players.law.test.ts` went from 8 tests to
**27**. Lane C's `cash-games-are-created-from-a-template.law.test.tsx` (15) is
green against my edits; nothing in this lane touches the create flow.

Every new assertion can FAIL on the old code, which is the point of writing it
(10.86): `cashEntry(closedGame()).status` was `'open'`, `clusterFigures` did
not exist, `lobbyPlayerStateOf` on a game id returned `null`, and
`rowPassesFilter(full)` on a busy game returned `true`.

---

## 6. WHAT I COULD NOT FIX, AND WHY

1. **`seatedIds` still does not contain the cluster id.** `lobbyPlayerStateOf`
   now asks for it, so the P1 above is only half closed: it completes the
   moment `loadMyGameStates` selects `tables(tournament_id, cluster_id)` and
   pushes the cluster id into the set -
   `return [r.table_id, tournamentId, clusterId].filter(Boolean)`. I left that
   `flatMap` alone because lane H is editing the same function for the
   seated-elsewhere case, and two lanes editing one `flatMap` is how a merge
   silently loses a branch. **Integrator: this is one line and it is the other
   half of a player-visible defect.**
2. **`fn_cash_game_waitlist_position` is not in the database.**
   `fn_cash_game_lobby` calls it for the `me.waitlist` field, inside
   `CASE WHEN me.table_id IS NULL` - so it can only fire for a viewer who is
   NOT seated, which is precisely the waitlist holder the branch exists for.
   `pg_proc` has no such function (checked on `kuklfnapbkmacvwxktbh`). Fixing
   it is a migration and its only readers are lane H's `CashClusterHUD` and
   `MustMoveLobbyModal`, so it is reported rather than touched. **This should
   be confirmed by whoever owns that surface before the branch is trusted.**
3. **`CashGameCard` is not the lobby's card.** Dan's three approved pieces of
   artwork are wired into `CashGameCreateFlow`'s preview only; the lobby paints
   `ArenaGameCard`. Both are painted chassis, so `#ClubArenaConsole` holds
   either way, but OPORD 1.4 s2.9 item 15 says "every cash lobby card is a game
   card" and named this component for Gate 4. It is a design call on lane I's
   file, so it is raised, not resolved.
4. **The 200-row cap** can still leave a game one empty table short in a scope
   holding more than 200 tables. Both reads order by `current_players DESC`
   first, so the trim can only ever fall on empty tables, and the two scopes
   that exist hold 69 and 67 tables with `fronts_past_200 = 0`. Recorded as a
   bound rather than engineered around.
5. **Nothing was committed, pushed or applied**, per the brief. The PostgREST
   embed is the one change I could not exercise against a live authenticated
   session from here: the FK (`tables_cluster_id_fkey`), the table's API
   exposure (`GameLobbyPanel` already reads `cash_games` over PostgREST) and
   the RLS predicate were all verified from the database, and a failed embed
   fails safe (the chain error path keeps the last good list and reports), but
   **one authenticated smoke request against a club lobby is worth making
   before this merges** - the blast radius is every club board.
