# Horses are not playing: the poll that starved the sweeps

Club Arena engine, 2026-09-16. Dan's report: horses are not playing, only a
handful, almost none on more than one table.

## What was measured before anything was changed

- 2,529 horses seated, but 2,069 of 2,162 occupied tables had exactly one
  live seat, every one of them a RUNNING or REGISTERING tournament table.
- 1,638 RUNNING tournaments older than thirty minutes; 804 of them (554
  Spins, 238 SNGs, 12 Satellites) had one player left with every elimination
  already recorded, waiting only for `finishTournament`; another 556 Spins
  had one or two busts still unrecorded.
- The one process-wide elimination scheduler had 1,612 managers registered,
  1,609 queued, four slots in flight and THREE of them stalled (promises
  unresolved since 05:30, 07:33 and 15:17 UTC). The remaining slot completed
  242 sweeps an hour at a mean of 12 seconds each, so the oldest queued
  tournament had waited 3.4 hours and the recovery pass that asks decided
  events to finish fired 6,061 times an hour for about ten finishes.
- In one 45-second sample the engine made 22,018 PostgREST requests; 18,205
  of them were the wait-for-players loop reading `table_seats` for those
  2,069 idle tables, every five seconds each. The process's HTTPS pool
  (128 connections per origin) was fully busy with 250 to 720 requests
  queued behind it; a one-row read timed from inside the process cost 350 to
  1,400 ms; event-loop delay was 274 ms at p50. Database time for the same
  read: 0.2 ms.
- The main thread's CPU profile was flat: 15% idle, 10.6% garbage collector,
  the rest fetch, streams, headers, async_hooks propagation, JSON and
  console writes, i.e. the cost of the request volume, not of any one
  function. The wait loop itself was 11% inclusive.
- Table 170e6a2a's settlement had been in flight for 3 hours 40 minutes at
  `hand_history_write` / `rpc_request:1`, for a hand the database had
  committed at 14:43:58Z. The fetch wrapper's 15-second abort had fired and
  the promise had not settled. That barrier held the table, its manager's
  `stop()`, and a scheduler slot that joined that stop.

The chain: hung tournaments keep single-seat tables alive; those tables poll
the database until the pool is full; every sweep's reads wait in that queue;
the sweeps that would finish the tournaments run one at a time on the one
slot the stalls left, twelve seconds each; nothing finishes; horses stay
booked into events that will never end, so the cash fleet has nobody to seat.

## What changed

1. **The quiet tournament table backs off** (`ServerTableEngineBase`). A
   tournament table below its deal minimum doubles its roster poll while
   nothing changes, 5, 10, 20, 40, then 60 seconds; any change resets it; a
   cash table keeps its five seconds; the manager wakes the destination
   table the moment a seat move is certified; a stop or kill ends the pause
   at once. Progress is still marked every pass and the cap sits well under
   the 180-second zombie rebuild. Law:
   `server/src/engine/theQuietTournamentTableBacksOff.law.test.ts`.
   `poker_fleet_tables_stalled` and the per-table stall samples now count
   only tables that could deal, which is the definition the liveness verdict
   and the alerts already used.

2. **The deadline is the deadline** (`services/supabase/client.ts`). The
   build production ran (57653ba0, 2026-09-14 to 16) had replaced the
   wrapper's independent deadline boundary with a cooperative abort plus a
   body drain, and that is the build on which the 3 h 40 min hang happened.
   #4711 restored the 2026-09-13 baseline, whose wrapper races every
   attempt against a boundary promise that rejects at the deadline whatever
   the transport does. This change adds the regression test that pins that
   behaviour (`clientDeadline.test.ts`: a transport that never settles still
   ends at the deadline), so it cannot be lost again without a red test.

3. **A stalled scheduler slot is replaced, not released**
   (`TournamentEliminationScheduler`). A promise unresolved past the warning
   budget keeps its slot and its tournament stays excluded, but one
   compensating slot opens beside it, never more than the cap: real
   concurrency is bounded at twice `maxConcurrent` and can never again fall
   to one because three promises hung. A wake no longer rescans every
   registered entry, and the gauges refresh at most four times a second from
   event paths (the one-second timer is unchanged).

4. **The seating budget starts when seating starts** (`HorseFleetManager`).
   The cash fleet's 18-second seating budget was measured from the start of
   the cycle, load phase included, on the strength of a 5.3-second load
   phase. With the pool full the load phase took 34 to 75 seconds, the
   budget was spent before the first table, the one-table fallback tried the
   same first table every cycle (every one of its thousand horse/table pairs
   excluded on membership or tags), and the floor seated nobody for hours:
   90 of 110 cash tables empty, "0 sit(s)" on every beat, 1,000 horses in
   the pool. The budget now runs from the end of the load phase; a slow load
   phase is reported on its own line and no longer cancels seating.

## What was not changed

- No repair job finishes the 804 decided tournaments by hand; the sweeps
  finish them once they can run, which is the point of 1 to 3.
- The elimination RPC's database-side mean (3.4 s, capped by the 8 s
  statement timeout on `service_role`) and the lock scope of
  `fn_sync_seat_first_player_count` are unchanged and remain on Dan's list.
- Why the one production fetch promise stayed open past its abort is not
  known; the wrapper no longer needs to know.
