# A field that cannot deal is not waiting behind one that can (2026-09-29)

## What was wrong

Production, engine c0c986ad, 2026-09-29 04:30-04:40 UTC (read from
`/metrics` and from `/internal/tournament-diagnostics/<id>` for every
RUNNING tournament):

- the process-wide elimination scheduler held 307-313 registered managers,
  250-271 of them queued, all four slots busy, oldest waiter 309-380 s;
- dispatch rate over 193 s: 84 admissions (0.43 per second); mean sweep
  5.0-7.0 s per interval (event loop p50 69 ms, every stage a chain of
  awaited round trips); 12.6% of all sweeps since boot ran past 5 s;
- 222 of 296 managers sat in the urgent lane and 0 in the routine lane, so
  "urgent" was plain FIFO over the platform and each manager was admitted
  about once every five minutes, whatever it needed. By class, the
  admissions in the window were live Sit and Gos and Spins (62 of 84),
  MTTs (14) and decided events whose finish is refused (8).

That cadence is survivable for a Sit and Go, whose table keeps dealing. It
freezes an MTT whose field is spread one player to a table: a table with one
player cannot deal, and only the balance stage can merge it, one break per
admission. Morning Free Buy `6a18ddaa` (12 players on 12 tables) and $100
Freeroll `c65c414d` (18 on 18) each re-armed the five-second balance redrive
(`BALANCE_REDRIVE_MS`) and were each admitted once per queue cycle
(`queueTicket` advanced 4 -> 5 in 193 s; the manager diagnostic showed one
sweep at 04:24:08 and the next at 04:27:55). `c65c414d` merged one table
between 04:22 and 04:34.

## What changed

`server/src/tournament/TournamentEliminationScheduler.ts` gains a third
lane, `consolidation`, ranked above urgent and routine, with its own
physical slot (`DEFAULT_CONSOLIDATION_SLOTS = 1`) beside the general cap.

- `setConsolidating(tournamentId, on)` marks a manager. While marked, every
  wake it receives (immediate, delayed, or a rerun owed by its live pass) is
  served from the consolidation lane. Marking promotes a place already
  waiting, under the same ticket, exactly as an urgent upgrade does.
- The general lanes keep all `maxConcurrent` slots and the urgent burst
  rule unchanged; a consolidating manager uses a general slot only when the
  urgent and routine lanes are empty.
- Stall compensation is per pool, with the same "replaced, never released"
  rule.
- New gauges: `..._consolidation_queue_depth`, `..._consolidating`,
  `..._consolidation_oldest_wait_ms`; the diagnostic rows carry
  `consolidating` and `runningLane`.

`TournamentManagerEliminations.ts` (balance stage) declares the lane: a
balance stage in which the balancer asked for a redrive (a break or seat
move that is not finished), or which the work budget cut short, marks the
manager; the first balance stage that finishes with none unmarks it.
`TournamentManagerBase.ts` counts `requestUrgentEliminationSweepAfter` calls
and forgets the mark with the registration it belonged to.

Nothing about what a sweep does changed: the stages, their order, the
budget and every money path are untouched. The extra concurrency is one
sweep, and exists only while some field is actually being merged.

## Not changed, and why

- The general throughput limit (four slots, ~5 s sweeps) is PR #5504's
  subject (adaptive cap). This change does not overlap it.
- Decided events whose finish is refused (custody unproven) still take
  general admissions; that refusal is owned by another stream.

## Pinned by

`server/src/tournament/aFieldThatCannotDealIsNotWaitingBehindOneThatCan.law.test.ts`
(`docs/laws.d/a-field-that-cannot-deal-is-not-waiting-behind-one-that-can.md`).
