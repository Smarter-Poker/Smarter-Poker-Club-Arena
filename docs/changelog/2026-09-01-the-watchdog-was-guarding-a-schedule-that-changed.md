# The watchdog was guarding a schedule that changed (2026-09-01)

## What was wrong

Dan: _"WE DO DEPLOYMENTS EVERY HOUR ON THE :55 NOW."_ #2527 landed that in
`auto-deploy-hetzner.yml` at 13:00 UTC. It did not touch
`.github/scripts/engine-watchdog.sh`, which still carried

    RESTART_HOURS="${RESTART_HOURS:-04 10 14 18 22}"  # America/Chicago; matches auto-deploy-hetzner.yml

under a comment asserting a match that no longer held.

## What it cost, measured

At 18:32 UTC the engine was serving the **03:54 image** with five merged pull
requests unshipped for **fourteen and a half hours**, and the watchdog job
reported `The engine is running main = success` on every run.

The arithmetic behind that silence: the newest server-touching commit was
rounded up by `window_at_or_after` to the next FIVE-HOUR window (14:00
Chicago, 19:00 UTC), the deadline became 19:25 UTC, and every run before then
was legitimately "behind by design". The watchdog was waiting patiently for a
window the deploy workflow had already stopped having.

Two failures compounded: the hourly schedule itself did not fire (one
scheduled run between 13:00 and 18:36, where sixteen were due), and the one
instrument whose job is to notice that had been silently desynchronised from
it.

## The fix

The window is a **minute** now, not an hour in a list. Every hour has one, the
restart happens inside the announced break at `:55`, and the deadline is
measured from that boundary:

    RESTART_MINUTE="${RESTART_MINUTE:-55}"   # matches auto-deploy-hetzner.yml
    window_at_or_after()  -> the next :55 at or after the commit

`is_restart_hour()` is now unconditionally true, which is what makes the
dispatch branch reachable at any hour rather than at five of them.

Verified against today's real timeline:

| Commit                           | Break | Deadline | At 18:32         |
| -------------------------------- | ----- | -------- | ---------------- |
| 13:00 (the hourly change itself) | 13:55 | 14:20    | **ALARM**        |
| 15:00                            | 15:55 | 16:20    | **ALARM**        |
| 17:50                            | 17:55 | 18:35    | quiet, correctly |

Blindness drops from about five hours to about forty-five minutes.

## Collateral

`tests/engine-watchdog-asks-production.test.ts` asserted the old literal, so
the pin was holding the desynchronised value in place. Updated in this commit
with the reason written beside it. The shape it pins is unchanged -- a deadline
built from the next restart boundary plus deploy time, floored by the grace
period -- only the boundary's definition moved.

Four new pins assert the **agreement itself** rather than the current number:
every cron tick must fall in the same hour as, and before, the break minute.
That is what stops the next schedule change from desynchronising them again.
Reverting the constant turns three of them red; that was run, not assumed.

## The pattern, for the record

This is the third instrument found this way in one day. The league runner
claimed three days in four and produced nothing. The layer watchlist stopped
at V19 and left forty of sixty features unwatched. This watchdog guarded a
schedule that had moved. All three looked identical whether or not they were
working, and all three were found by asking what each one had actually done
rather than whether it was green.

## The fix repairs the schedule, it does not merely report it

This turned out to matter more than the alarm.

Section 5 of the watchdog dispatches `auto-deploy-hetzner.yml` itself when the
engine is late, but it was gated on `is_restart_hour "$NOW_HOUR"` -- and
outside the five Chicago hours that branch took the other path:

    not dispatching: $NOW_HOUR:00 Chicago is not a restart hour.

With every hour a restart window, that gate is now unconditionally true, so a
late engine is **dispatched automatically** rather than waiting for a human or
for GitHub's next scheduled tick.

That is the part that closes today's actual failure. GitHub fired **one**
scheduled tick for this workflow between 13:00 and 18:52 UTC where nineteen
were due, and other repo schedules were sparse and hours late in the same
window, so the cron is not something to rely on. The watchdog, by contrast,
runs on `workflow_run` -- it fired eight or more times today, because
something is always completing -- which makes it a far steadier trigger than
the schedule it was written to supervise.

So after this change the hourly deploy has two independent triggers: the cron
when GitHub honours it, and the watchdog within about forty-five minutes when
it does not. Today it had one, and that one did not fire.

**Not fixed here, and worth knowing:** _why_ GitHub is dropping these
schedules. `cron-health.yml` does not cover it -- it asks the DATABASE which
scheduled work is failing, so it watches the horse jobs and not GitHub Actions
cron. That gap is now survivable rather than closed.
