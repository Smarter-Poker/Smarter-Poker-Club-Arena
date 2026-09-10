# A sweep that cannot afford its first mutation never makes one

2026-09-10. Fifteen tournaments recorded no elimination for up to a hundred
minutes while their managers were alive, their leases three seconds fresh,
their blind clocks advancing and their logs completely silent.

This is the second half of
`2026-09-10-the-knockout-door-owns-every-bust.md`. That one removed a pg_cron
sweep that was stealing busts and blocking the reprice proof. With the proof
passing, forty-two events resumed recording finishes within two minutes — and
the biggest ones did not. `7f521f47` held 249 busted players across 34 tables
of one seat each. `2dbc9bb6` held 310. `33883f12` held 163.

## What was actually happening

`runEliminationSweep` is admitted by a process-wide scheduler with four slots
and a five-second work budget per admission (`SWEEP_WORK_BUDGET_MS`). The bust
stage begins with reads: the zero-stack roster list, two field counts, the
knockout-order lookup chunked forty ids at a time, the taken-places list, the
unplaced count. Only then does it assign places and call the knockout door.

Every mutation asks `eliminationMutationAllowed()`, which is false once the
budget is spent. So on a large backlog the sweep spent its whole budget on the
preparation, and then:

- `eliminatePlayer` returned false immediately, without a word;
- the assignment pass read that as a refusal, incremented the player's refusal
  streak and aborted the batch;
- `completedStage(1)` was never reached, so the sweep never completed;
- the durable manager wake was therefore never acknowledged;
- and the next sweep did the same reads on the same backlog.

**The livelock scales the wrong way.** The bigger the backlog, the longer the
preparation, the more certain the starvation — so it hits exactly the events
that most need the sweep, and never the ones that do not.

Measured on the live engine, up two hours: **1,973 of 16,781 sweeps (11.8%) ran
past the five-second budget, about 16.4 every minute** — one per stalled event
per minute, which is the whole population of the stall. The knockout door was
never the obstacle: probed directly and rolled back at 07:38, three players in
`7f521f47` returned `ok / claimed` at places 401-403. Nothing was asking it.

## The fix

`SWEEP_MUTATION_GRACE_MS` (5s, one batch's worth of the same budget). A sweep
that reaches its mutation phase **having committed nothing** may extend its
deadline once, and only in the bust assignment pass. If it has already
committed something, or has already had its grace, it yields and requeues
exactly as before.

So the yield rule is unchanged and the sweep still cannot monopolise a slot;
what changes is that a yield is now guaranteed to be a yield after progress,
never a stall instead of progress. The grant is reported
(`Tournament.bust_mutation_grace_granted`) with the backlog size, because a
budget that has to be extended is a measurement about the shape of the work,
not something to swallow (10.86: a signal that answers when it does not know).

Two smaller things went with it:

- **A manager sweeps itself once when it adopts the event.** Registering the
  elimination scheduler makes a manager wakeable; the routine wake is a hand
  completing with a zero stack. An event whose tables cannot deal — 34 tables
  holding one player each, which is what a stalled consolidation looks like —
  therefore has no way to ask for the sweep that would consolidate them, since
  table balancing is stage 5 of that same sweep. `start` and `resume` now
  request one sweep after registering.
- **The one-time correction** that woke the fifteen stalled managers through
  the platform's own durable wake emitter is migration
  `20260910074416_a_manager_sweeps_itself_once_when_it_adopts_the_event`. It
  repairs no row and moves no chip: the engine records every finish through its
  own door, as it would have at 06:48.

## Why those events were stalled in the first place

They lost and retook their leases between 06:05 and 06:48, while the FOR SHARE
/ heartbeat conflict was being fixed (`20260910063559`, `20260910064701`). Each
resumed correctly — `Resumed - 34 tables, level 11` — and then never swept
again. Two independent defects had to line up: no sweep at adoption, and a
sweep that could not afford its first mutation once the backlog had grown.
