# A Heal That Did Not Work Is Not A Heal

2026-09-02. The self-healer for the schedule-registration wedge cycled four
workflow registrations at 14:56, the cycle did not work, and the healer then
went quiet for six hours by design. The estate ran five and a half hours
without a single scheduled tick.

## What was lost while it slept

Every scheduled safety net, measured at 16:29 UTC:

| Workflow                  | Expected every | Last scheduled tick |
| ------------------------- | -------------- | ------------------- |
| `build-for-world-hub.yml` | 30 min         | 323 min ago         |
| `agent-autopilot.yml`     | 10 min         | 350 min ago         |
| `publish-watchdog.yml`    | 60 min         | 312 min ago         |
| `estate-integrity.yml`    | -              | 462 min ago         |

Twelve workflows in total. `build-for-world-hub`'s every-30-minute tick is the
retry that exists precisely so a publish which failed is not left sitting, and
it was dead for the entire window in which two commits sat merged and
unpublished behind a red test. `push` and `pull_request` triggers kept working
throughout, which is why this was survivable and also why it was quiet.

## The bug

`selfHeal` refused to run again within `REHEAL_COOLDOWN_H` (6) hours, using the
audit issue as its memory:

    const recent = issues.find((i) => Date.now() - Date.parse(i.created_at) < COOLDOWN);
    if (recent) { say('inside the cooldown, not cycling again'); return; }

The cooldown's shape is right. Cycling registrations every few minutes would be
flapping, and the guard was added for that reason. The QUESTION it asks is
wrong: it keys on a heal having **run**, not on a heal having **worked**.

`selfHeal` is only ever reached when schedules are still overdue. So "we healed
recently" and "schedules are still dead" are true at the same moment only when
the heal failed. That is an argument for trying again, not for going silent.
The healer had put itself to sleep until 20:56 with twelve workflows down.

Two smaller faults in the same function:

- The cooldown marker issue was filed **unconditionally**, even when
  `cycled.length === 0`. A cycle that cycled nothing is not a heal, and it
  bought six hours of silence for work that never happened.
- It cycled only the workflows it had measured as late. The wedge is
  repo-level: four were cycled at 14:56 while twelve were dead. The remedy that
  worked by hand on 2026-09-01 was applied to every scheduled workflow.

## The fix

`healDecision` is a pure exported function, so the decision can be tested
without a live wedge:

| State                                         | Decision                        |
| --------------------------------------------- | ------------------------------- |
| No prior wedge issue                          | `heal`, attempt 1               |
| Prior issue past the cooldown                 | `heal`, attempt 1 (new episode) |
| Inside cooldown, still overdue, attempts left | `retry`, attempt n+1            |
| Inside cooldown, attempts spent               | `escalate`, stop cycling        |

Retries record themselves as marked comments on the SAME issue, so the count
survives between runs and the issue reads as one episode rather than a pile of
duplicates. After `MAX_HEAL_ATTEMPTS` (3) the healer stops cycling and says so
as a `::error`, with the three things a human should actually check: GitHub
status, whether Actions is restricted or out of included minutes (a billing
stop silences schedules while `push` keeps working, which is this exact
shape), and the per-workflow inactivity banner. A fourth identical attempt is
not persistence, it is noise.

Scope widened to every active scheduled workflow. A workflow that is
deliberately disabled is still left alone, and enable is still never left
undone.

## Verified

- `tests/schedule-liveness.test.ts`: 22 of 22 passing, up from 12.
- Replayed today's real state (issue #2638 at 14:56, one attempt, checked at
  16:30): the old code returns `skip`; the new code returns
  `retry`, attempt 2.
- Three mutations, each restored afterwards, each red: restoring the early
  return inside the cooldown, filing the marker when nothing was cycled, and
  narrowing the cycle scope back to only the late workflows.

## Done by hand at 16:32, separately from this change

All 15 active scheduled workflows were disabled and re-enabled to force
re-registration, and all 15 confirmed `active` afterwards. The estate should
not wait for code review to get its crons back. That is remediation of the
live incident; this change is so the next one does not need a person.

## And the remedy must not cause the disease

Cycling the 15 workflows by hand at 16:32 **cancelled the in-flight CI run on
the pull request that was fixing the red main**. "The operation was canceled",
after more than forty passing test files. Disabling a workflow cancels its
runs, and `build-for-world-hub.yml` is in the cycle list, so a heal timed a
minute differently would have cancelled a publish. A heal whose whole purpose
is to protect publishing must not be able to cancel one.

The healer now skips any workflow with an `in_progress` or `queued` run, lists
what it deferred, and cycles those on the next attempt. `isBusy` fails CLOSED:
if the API cannot be read the workflow is treated as busy and left alone,
because a missed cycle costs one more attempt while a wrong cycle costs a
cancelled publish. A workflow that is mid-run is in any case demonstrably
registered enough to run, so it is the least urgent thing in the list.

Two more mutations verified red: removing the busy check, and making `isBusy`
fail open. 26 of 26 pins green.

## Re-registering a cron is not the same as doing the work

The cycle remedy failed twice: once automatically at 14:56, once by hand across
all 15 workflows at 16:32. Through all of it `push`, `pull_request` and
`workflow_dispatch` fired normally and githubstatus reported Actions
operational, so the wedge is specifically in schedule DELIVERY and
re-registration is a remedy that only sometimes works on it.

The estate does not actually need the cron. It needs the WORK the cron stands
for, and `build-for-world-hub`'s 30-minute retry is the net that catches a
publish that failed. That afternoon production sat three commits behind main
with that net dead.

So the check now runs the starved work itself. It already runs on
`workflow_run`, which fires many times an hour regardless of the scheduler, and
`workflow_dispatch` still works. When a scheduled workflow has not run by ANY
trigger inside the interval it promises, it is dispatched.

Guards, because a dispatcher that loops is worse than a silent cron:

- only workflows whose file declares `workflow_dispatch` (`ci.yml` has none,
  and gates four jobs on `github.event_name == 'schedule'` that a manual run
  would skip anyway, so it is correctly left out and reported);
- never this workflow itself, which would be a self-trigger loop;
- never one with a run already in flight;
- staleness measured over runs of EVERY event, not just `schedule`. This is the
  part that makes the loop converge: once a workflow has been rescued it has
  run recently by some trigger and is no longer starved;
- a hard cap of 4 dispatches per pass;
- an unreadable run history counts as busy, so it never dispatches blind.

`build-for-world-hub` is safe to dispatch: its only schedule-gated step is the
dedupe that decides whether to skip when production already matches, and the
sync step still refuses to publish anything older than what is deployed.

Four more mutations verified red: allowing a self-dispatch, measuring staleness
over schedule-only runs, unwiring the dispatcher, and removing the cap. 36 of
36 pins green.

## The root cause, measured, and why cycling is now off

Every `schedule:` in Club Arena adds up to ~324 scheduled runs a day. Over the
48 hours to 18:45 UTC GitHub delivered **65 - about 10%**. World Hub asks for
~129 a day and was delivered **19%**. Across the seven repos the estate asks
for 700+ a day. GitHub's docs call the schedule event best-effort and say that
under load "some queued jobs may be dropped"; measured here, most are, all the
time, and the busiest repo is dropped hardest - today to zero from 14:42.

Nothing about registration was ever wrong, which is why cycling never fixed it
and why a brand-new workflow file created at 17:31 never got a scheduled run
either. The estate had also been compensating by asking for MORE ticks (three
an hour for one engine deploy), which under fair-share throttling deepens the
drop. `auto-deploy-hetzner.yml` is back to one tick.

The remedy is to stop needing the cron: dispatch starved work off
`workflow_run`, which GitHub delivers reliably many times an hour. That is now
the first and normally only action. Registration cycling is kept as code
behind `SCHEDULE_CYCLE_REGISTRATIONS=1`, off by default.
