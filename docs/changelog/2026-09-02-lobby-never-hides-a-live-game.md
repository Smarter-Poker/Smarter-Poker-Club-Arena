# The lobby was hiding 41 running games behind 1,003 empty tables

**2026-09-02** - `fix/lobby-never-truncates-away-a-live-game`

Dan: _"why do we only have a hand full of games running in the midway union and
zero cash games running in deep stack society?"_

## Deep Stack Society was never empty

It was dealing **676 cash hands a quarter-hour** when he asked, across **51
running tables with 203 players seated**. The lobby showed none of them.

Every cash-lobby read is `order('created_at', desc).limit(QUERY_LIMITS.LIST)`

- 200 rows. DSS carries **1,058 open cash tables**, so the lobby fetched the 200
  NEWEST and of its 51 running tables only **10** fell inside that cut. The page
  then runs every filter tab client-side over what it fetched, so PLO, NLH and the
  rest each read `0/x OPEN` down the page while the club was busy.

Midway Union has 73 open cash tables, comfortably inside the cap. That is
exactly why its lobby looked honest and DSS's did not - same code, different
table count.

## The fix

Order by occupancy first, `created_at` as the tiebreak, in all three cash-lobby
reads (`TableService.getClubTables`, `TableService.getUnionTables`,
`ClubHomePage`).

`tables.current_players` is maintained exactly - verified against `table_seats`
on 2026-09-02, **0 discrepancies across all 1,131 open tables** - so occupancy
first puts every occupied table above every empty one, and the 200-row cap can
then only ever trim empties.

The cap stays. Removing it trades a hidden game for a 1,058-row payload on every
lobby paint, and the cap is harmless once it cannot reach a live game.

Pinned by `tests/lobbyNeverHidesALiveGame.law.test.ts`, registered in
`docs/LAWS.md`.

## Also: main was red, and it was my doing

`tests/unit/noFixedSizeSourceWindows.test.ts` was failing on `origin/main`
against two offenders:

- `HorsesStayInTheirClub.test.ts:186` - `SRC.slice(at, at + 400)`, which I wrote
  in PR #2685 earlier today. Exactly the magic-window mistake that law exists to
  prevent, added by the same session that should have known better.
- `HorseFleetSeesEveryOpenTable.test.ts:78` - `guard.slice(0, 600)`.

Both now bound their window with `sliceStatement` from
`tests/helpers/sourceWindow`, so the window grows with the code it watches
instead of drifting off the end of it.

## What this does NOT fix

DSS holds **1,003 completely empty waiting cash tables**, bulk-created
2026-09-01 13:34-17:24. Each carries a unique name, so it is its own config
family and `retireSurplusTables` (which drains to `MAX_TABLES_PER_CONFIG` = 3
per family) never fires on any of them. `HorseFleetManager.clubIds` is
`[SHARK, JAQK]`, so nothing creates, retires or balances DSS tables either.

Whether that menu should be trimmed is Dan's call, not an agent's - the stakes
and options on offer are a product decision. The lobby is now honest about it
either way.

## Verification

- root `npx tsc --noEmit` clean; `npx vitest run tests/` - 838 files pass
- server `npx tsc --noEmit` clean; `npx vitest run` - 327 files, 3,631 tests pass
- `noFixedSizeSourceWindows` green, which it was not on main before this branch

## Addendum (same day): the lobby stops depending on realtime to be right

Dan: "FIX THE REAL TIME CONNECTION FOR THE MIDWAY UNION, CLUB JAQK AND SHARK
CLUB ... ANY AND ALL NEW CLUBS MUST HAVE ALL REAL TIME CHANNELS WIRED FROM
THE START."

Measured: Supabase Realtime's replication slot was 46 MB behind the WAL and
growing (124 MB four minutes later) against 2.1 MB/s of WAL (~180 GB/day at
220k hands). Every `postgres_changes` event - seat counts, statuses, the BBJ
tick - arrives a minute or more late, for every club alike; there is no
per-club channel to wire, the stream is one decoder for the whole database.

So the club page now polls occupancy itself: every 20 s while visible, the
four columns that change (`id, current_players, status, max_players`) for the
same scope the fetch uses (~100 ms, indexed), patched onto the rows on screen;
a full reload only when an occupied table it has never seen appears. The
realtime stream still delivers the instant case when healthy; this is the
floor under it, and because it is the page's own behaviour it exists for every
club the moment the club does.

Also: `refreshScopedPlaying` now calls `get_club_players_playing` (~50 ms,
migration `20260902203325`) with a 2 s debounce instead of the whole
`get_club_home` payload (1.8 s) at 250 ms - that call was 26% of all database
time.
