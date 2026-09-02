# 2026-09-02 - The engine stops hammering a saturated database

**Dan:** "ANYTIME YOU GO TO A TABLE IT NEVER LOADS RIGHT AWAY ... 100% OF THE
TIME SAYS RECONNECTING TO THE TABLE." "HANDS KEEP STALLING AND DELAYING, THE
COUNTDOWN TIMER MOVES IN CHUNKS. SOMETHING HAPPENED OVER THE LAST 2 DAYS THAT
DESTROYED THE REAL TIME CONNECTION AND GAME PLAY."

## The root cause, measured

The production database (Supabase, 2 cores) is saturated. From the engine host
a point read of one `tables` row takes 0.4-2.5 s; 1,110 `supabase_timeout`
errors in two hours; `atomic_table_buyin` cancelled by the 8 s statement
timeout. Every hand's writes, every buy-in and every socket handshake queue
behind that, and the engine's state broadcasts arrive late and bunched - that
is the stalled hand and the chunky timer.

What has been eating the two cores, from `pg_stat_statements` and a live
40-second sample:

| Consumer                                                               | Share / rate                               | Since                               |
| ---------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| `get_club_home` (club lobby)                                           | 26% of ALL db time, 127k calls, 1.8 s mean | lobby refresh on every table event  |
| Realtime WAL poller                                                    | ~35 s per 40 s (a whole core)              | tables/seats/hole cards published   |
| `fn_sync_seat_first_player_count` + `fn_seat_horse_in_seat_first_game` | 7 calls/s, 160 ms + 849 ms mean            | 96 unfillable DSS seat-first boards |
| hand_history / hole cards / seat writes (the actual game)              | the rest                                   | 2x hands since the DSS build 09-01  |

The last two days added: 1,058 Deep Stack Society tables and 416 horses (twice
the hands, twice the WAL), 96 seat-first boards nothing can fill, and a lobby
that re-fetched the whole club payload on every seat transition.

## Fixed in this change

1. **`get_club_home` (migration `20260902203325`, applied to production).**
   Profiled as an authenticated user: 5,797 ms, of which 2,026 ms was the
   member COUNT under `club_members` RLS (four policy functions per row, 417
   rows). The count now goes through `fn_club_member_count` (SECURITY DEFINER,
   returns one integer, authenticated + service_role only). Same function
   after: 1.5 s (the rest is the invoker-mode tables list; still to do). Also
   tables are ordered occupancy-first so the 200-row cap never hides a live
   game - the same rule as #2696, which had fixed TableService but not this
   RPC, which is what the club page actually paints from. Plus
   `get_club_players_playing`, a ~50 ms RPC for the one number the realtime
   refresh wants.
2. **Seat-first retry backoff (`GameServer.fillPartialSeatFirstGame`).** A
   board whose human window closed and that keeps coming back "top-up added 0
   of 1" is retried at 12 s, 24 s, 48 s ... capped at ten minutes, reset the
   moment a top-up fills it. A board with a human in it keeps the 12 s
   cadence. 7 RPC/s becomes ~0.1/s for the 96 stuck boards.
3. **Websocket upgrade gates in parallel (`EngineWebSocketServer.attach`).**
   authorizeViewer, blacklist, restrict-observers and the IP rule were awaited
   in sequence. Measured from a browser: 7.4 s, 10.7 s, 10.7 s to `open`
   against a 15 s client handshake timeout. They now run in one `Promise.all`
   and are judged in the original order with the original fail-open rules.
4. **Deep Stack Society pruned (Dan: "PRUNE THE EXTRA TABLES").** 1,058 open
   cash tables to 223: every table with a live seat, plus the oldest table of
   every (variant, stake) family that had no game, so every stake and variant
   is still offered. Closed (status only, not deleted; a host can reopen).

## Still to do, in order of effect

- **Compute.** Two cores cannot carry 220k hands/day plus Realtime decoding
  every published hot table. The Realtime poller alone is ~1 core. Either
  upgrade the Supabase compute (Dan's call, it is a cost) or take
  `table_hole_cards` / `table_seats` / `tables` out of the realtime
  publication and deliver those through the engine socket only (client work).
- `ClubHomePage.refreshScopedPlaying` should call `get_club_players_playing`
  with a 2 s debounce instead of `get_club_home` at 250 ms.
- The 96 stuck Deep Stack seat-first boards cannot fill because the
  horse pool rule excludes them (#2548 open); they should be cancelled with
  their buy-ins returned through the sanctioned path.
- `get_club_home` tables list under RLS is still ~1 s for a 1,058-table club;
  the prune helps, a definer read of public columns would finish it.

## Verification

- `tsc --noEmit` exit 0 (server). Server suite green (see PR). Seven new pins
  in `tests/unit/theEngineStopsHammeringTheDatabase.test.ts` fail on the
  previous source and pass on this one (verified by checkout).
- Migration timed as authenticated: `get_club_home('DSS')` 5,797 ms -> 1,508
  ms; occupied tables in the 200-row page 10 -> 155.
