# The kill-storm page names its tournament, and an empty event cancels on time (2026-10-26)

Lease follow-ups, phase 3 of 5. Phases 0-1 fixed the lease loss at its root;
phase 2 kept the engine log long enough to read. This phase polishes the two
alerts that opened the incident so the next reader is told what happened.

## 1. The kill-storm page

`ClubArenaEngineKillStorm` paged on 2026-10-25:

> 41 engine kills in 15min on 41 tables, most at tournament_lease_lost -
> tables are being destroyed and rebuilt in a loop

Read from `engine_recovery_events` joined to `tables`: the 41 kills fell inside
138 ms (13:27:10.749 to 13:27:10.887 UTC), every one `tournament_lease_lost`,
every one a table of the same tournament (56b17547). There was no loop and no
event named. The verifier now also reads each killed table's tournament and
the kills' first and last timestamps, so the same storm reads:

> 41 engine kills in 15min on 41 tables of tournament "<name>" (56b17547),
> all tournament_lease_lost - one burst at 13:27:10Z, not a loop

- "all <cause>" when every kill has the same cause, "most at" otherwise.
- "one burst at HH:MM:SSZ, not a loop" when first and last kill are within 60
  s (`KILL_BURST_SPAN_MS`); "spread over N min, tables are being destroyed
  and rebuilt in a loop" otherwise.
- One tournament is named (name and short id; the id alone when the name read
  fails); several are counted in the summary and listed with their kill
  counts in the description. Cash tables name nothing.
- Labels gain `shape` (`burst` | `spread`) and, for a single event,
  `tournament_id`.
- Every extra read is best effort: a failure leaves the page exactly as the
  2026-10-17 version produced it.

`killStormSummary` is a pure function in `DealRateVerifier.ts`;
`server/src/services/aKillStormNamesItsCause.test.ts` pins the 2026-10-25
storm's wording, the spread case, the multi-tournament case, and the
failed-lookup fallbacks.

## 2. An empty event cancels on time, restart or not

`TournamentNeverStarted` paged at 19:46:36 UTC on 2026-10-25 for "Daily 25
Chip Freezeout" 501008e1: start 19:00, zero entrants, cancelled at 19:52:12.
The day before, the same daily event (d58c2a8d, no restart) was cancelled at
19:30:09, exactly when `emptyPastStartEvent.ts` says: 30 minutes past start,
after one past-start horse top-up came back empty. `fn_tournament_metrics`
counts an empty event as overdue at 40 minutes, so a cancel that is 22 minutes
late is a page.

Two things conspired, both engine-memory:

1. The "top-up came back empty" count lived in `pastStartTopUpClock`, which
   dies with the process. The engine restarted at 19:30 (replacement
   container 19:30:11), so the new process had to ask the horse pool again
   before it was allowed to cancel.
2. That ask, and the cancel itself, rode `launchDiscoveryTopUp`, which admits
   at most `PAST_START_TOP_UP_CONCURRENCY` (4) horse top-ups at once. A
   restart also forgets every top-up backoff clock, so all 70 past-start
   seat-first boards and every pre-start MTT ramp ask at once, and an event
   with nobody in it waits its turn behind them. (The engine log of that
   window had already rotated out: 250 MB held 20 minutes that afternoon,
   which is phase 2's subject.)

Fixed at both points:

- `public.tournament_past_start_top_ups` (migration
  `20261026051041_an_empty_event_remembers_its_empty_top_ups_across_a_restart`):
  one row per registration-first event with no entrant whose past-start top-up
  added nobody, `empty_top_ups` consecutive, written when the top-up settles,
  deleted when a top-up adds anyone or the event is cancelled. No foreign key
  to `tournaments` (production DDL policy 7). RLS on, every privilege revoked,
  `service_role` granted SELECT/INSERT/UPDATE/DELETE. The discovery pass reads
  it beside its roster read for the events whose cancel could depend on it
  (usually none) and the predicate takes the larger of this process's count
  and the durable one.
- `launchEmptyEventCancel`: the cancel has its own single-flight lane (one
  per event, no shared cap). It still refuses to run under the maintenance
  freeze, while a top-up for the same event is in flight, or while a manager
  owns the event, and the walk skips an event whose cancel is in flight
  exactly as it skips one whose top-up is.

Pins: `server/src/tournament/anEmptyPastStartEventIsCancelled.test.ts`
(the predicate reads `Math.max(memory, durable)`, the durable read sits
beside the roster read, the write happens only for an empty roster and is
cleared on add or cancel, and the cancel never touches
`launchDiscoveryTopUp`).

## What goes live when

The migration installs through the merge's own dispatch. The engine changes
ride the next engine release (04:00 America/Chicago unless an emergency
restart comes first). No player-facing, money, seat or timing behaviour
changes; the only new write is one engine-owned counter row per empty event.

## Not in this phase

- The 21:41:18 UTC lease loss (tournament 5469ba74) with no `busy` heartbeat
  answer, still filed under the `unproven` verdict. Later phase.
- Back-office jobs during play and the one-core saturation (phase 4); the
  failed 18:15 UTC deploy attempt (phase 5).
