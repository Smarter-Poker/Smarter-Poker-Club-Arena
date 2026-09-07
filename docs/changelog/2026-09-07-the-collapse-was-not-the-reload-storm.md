# The collapse was not the reload storm

**2026-09-07** — correction to
`2026-09-06-a-delete-that-works-everywhere-except-where-it-is-called.md`

That changelog said the 16:04–16:08 hand-rate collapse was caused by a
PostgREST schema-reload storm — 133 reload-triggering DDL statements in the
minute 16:14. **The same collapse happened again at 04:05 today with no storm
anywhere near it**, and this time I caught it live and measured the cause. The
earlier attribution was wrong, and this file says so rather than leaving the
next agent with a story that will not reproduce.

## What happened again

| minute (UTC) | hands                      |
| ------------ | -------------------------- |
| 04:01–04:04  | 458, 513, 481, 466         |
| 04:05        | 236                        |
| 04:07        | 40                         |
| 04:08        | **6**                      |
| 04:09–04:15  | 12, 42, 31, 27, 13, 12, 22 |

Every hour for the previous ten ran ~2,000 hands in :01–:04 and ~2,400 in
:05–:09. This hour: 1,918 then **408**. Same shape as yesterday, same
`deal_step_timeout: load_seats exceeded 20s` — **10,688 of them in twelve
minutes**.

## What it was not

- **Not a reload storm.** `check-ddl-reload-storms` — written yesterday for
  exactly this — stayed silent, correctly. The minutes before the collapse held
  5 reload-triggering statements each, from **1 distinct query text**: one
  migration, one transaction, about one reload.
- **Not the database.** Postgres: 6 active backends, **0 waiting on a lock**,
  100 of 240 connections. `table_seats` had 7,192 dead rows against 406,038
  live, autovacuumed 19 minutes earlier, 122 MB. No bloat, no contention.
- **Not PostgREST.** From the engine box itself, three timed reads of the very
  query that was "exceeding 20s":

  ```
  postgrest table_seats read: 200 in 0.175s
  postgrest table_seats read: 200 in 0.144s
  postgrest table_seats read: 200 in 0.133s
  ```

- **Not tournament volume.** The obvious suspect was a start cohort. It is not:
  hour 04 started **71** tournaments, against 436–515 in each of the previous
  nine hours, all of which were healthy.

## What it is

```
box:     3 cores, load average 1.25
engine:  100.8% CPU        <- exactly one core, pegged
```

**The engine's single JavaScript thread is saturated while two of the box's
three cores sit idle.** The 140 ms response to `load_seats` arrives and then
waits behind a pegged event loop until the engine's own 20-second timer gives
up. Postgres was never slow; the engine could not listen.

What is on that thread:

```
780    "elimination sweep still running after Ns"   (15 minutes)
556    "TournamentBrainContext.refresh timed out"   (12 minutes)
1,561  tournament log lines                          (5 minutes)
```

and tournaments are not finishing: **120 RUNNING, only 40 completed in the last
half hour**, against 400–500 started and completed per hour all night. A sweep
that overruns stops tournaments completing, the RUNNING set accumulates, each
one costs sweep work every tick, and the thread goes further behind. Cash
tables are collateral: they starve on an ordinary read.

CLAUDE.md section 2 already says where to look — _"The engine is ONE core...
If a timer, refresh or sweep 'times out' while Postgres is fast, look at the
loop first."_ That sentence is exactly right and it took a second incident to
follow it.

## The guard for this was on, and blind

`EquityLoadGovernor` exists to notice precisely this, and
`/health.equityGovernor.scale < 1` is documented as "the core is hot". During
the collapse, with one core pegged at 100.8%:

```json
"equityGovernor": { "enabled": true, "scale": 1, "p50Ms": 0.000511, "throttledForS": 0 }
```

`scale: 1` and a p50 event-loop lag of half a microsecond. It measures lag
around the equity sampler, so work that does not go through the sampler —
tournament sweeps — is invisible to it. `/health` also reported
`stalledTableCount: 0`, `wholeFleetStalled: false` and `liveness: "ok"` while
the fleet dealt 20 hands a minute instead of 480.

That is 10.86 in its most expensive form: three guards answering confidently
about a platform that had stopped.

## Not caused by this programme's changes, and here is the evidence

Fair question, since both collapses came after the Realtime work went live. The
changes were fewer database writes, fewer Realtime channels, one Postgres
function, and one table removed from a publication. None can pin a JS thread —
and the platform ran **ten consecutive healthy hours** (09-06 18:00 → 09-07
03:00, 2,000–2,500 hands per five minutes) with every one of them live.

## What this needs next, and why not from here

This is the engine-restart programme's territory —
`TournamentManagerEliminations`, `TournamentBrainContext`,
`EquityLoadGovernor` — and CLAUDE.md requires reading
`docs/HANDOFF_CURRENT_STATE.md` before touching it. Starting a fix there at the
end of another programme's session, on a guess, is how the estate gets a fourth
guard that reads as armed.

The three things a fix has to answer, in order:

1. **What in the elimination sweep costs so much?** 780 overruns in 15 minutes
   is a measurement, not a mystery — profile it against a live 120-tournament
   set.
2. **Why does the governor not see it?** A load governor that only watches its
   own sampler is not a load governor. Whatever it measures must include the
   thread the sweeps run on, or `scale` will keep reading 1 during an outage.
3. **Two cores are idle.** The engine is single-threaded by design and the box
   is not. Tournament sweeps are the obvious candidate to move off the hot
   path.

## Files

- This file. The 2026-09-06 changelog's "the other thing the log showed" section
  is superseded by it: the DDL-storm measurements there are accurate, but the
  causal claim about the hand-rate collapse is not.
