# 2026-09-05: the act-to-broadcast clock measured the wrong thing

Phase 1 shipped a metric named `poker_act_to_broadcast_ms`, deployed it,
alerted on it, and reported a headline number from it: **"median 808 ms from
a player acting to every seat seeing it, while the event loop is healthy -
structural pacing in the broadcast path."**

That number was not act-to-broadcast latency. It was the interval between
two consecutive actions at a table.

## The defect

`HandController.performAction` emits `PLAYER_ACTION` synchronously, and that
handler calls `broadcastCurrentState()`. So the broadcast for an action
happens **inside** the `performAction` call.

The clock was armed on the line **after** that call returned. So every
broadcast observed the clock left armed by the _previous_ action, and the
histogram recorded the gap between two actions - which is turn pacing, horse
action delay and think time. It is a perfectly stable number, which is
exactly why it looked like a real measurement: p50 808 ms, p95 1843 ms, p99
3755 ms, no format an outlier, and an event loop at p99 54 ms that made the
"latency" look mysterious rather than wrong.

Both paths had it: the human path in `_handlePlayerActionInner`, and the
horse path in `scheduleHorseAction` (where I had moved the instrumentation
below the check/fold degrade only hours earlier - correct for counting, and
still wrong for the clock).

## The fix

The clock is armed **immediately before** `performAction` on both paths, so
the observation that happens inside it measures accepted -> every seat has
it. Three cases had to be handled or the fix would leak:

- **A rejected human action** restores the previous clock, so a refused
  action cannot become the next sample.
- **A rejected horse action** re-arms before the check/fold degrade, because
  the failed attempt produced no broadcast.
- **A horse where nothing lands at all** restores the previous clock.

The counter blocks that sit after the broadcast no longer arm anything.

## What this invalidates

Every act-to-broadcast figure published before this fix, including the
headline in `2026-09-05-action-latency-thresholds-from-measurement.md`. The
thresholds derived from it (3000 ms / 6000 ms) are now deliberately generous
placeholders, flagged as such in `alert-rules.yml`. They must be re-derived
from a day of true latency data - the real numbers will be far smaller, and
thresholds this loose would miss a genuine regression.

`poker_actions_fleet_total` is unaffected: counting an action never depended
on the clock.

## Law

`theTableFeelIsMeasured` LAW 7: the human path arms before `performAction`, a
rejected action restores the clock, the horse path arms before its action and
restores when nothing lands, and neither counter block re-arms after the
broadcast. All four pins verified red against the shipped ordering.
