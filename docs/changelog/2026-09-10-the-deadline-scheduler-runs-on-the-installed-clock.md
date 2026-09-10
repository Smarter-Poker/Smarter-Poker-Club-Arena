# The deadline scheduler runs on the installed clock

## The flake

`server/src/tournament/SeatFirstActualDeal.test.ts` failed once on 2026-09-10
on a loaded CI runner ("launches HU 1000 plo4 with a full first action
clock": the actor's timer was gone) and passed on the re-run, on a sibling
run at the same minute, and in 29ms on an idle Mac, ten times out of ten.
The log line beside the failure said what happened: the first actor's time
bank had "expired" and the engine auto-folded, one settle beat into hand #1.

## Why

`deadlineScheduler` is one instance per process, constructed when its module
loads, with `this.now = opts.now ?? Date.now` and
`this.setIntervalFn = opts.setInterval ?? setInterval`. Those bound the REAL
functions at import. A test that installed fake timers afterwards therefore
ran a scheduler that ticked on a real 100ms interval and compared every
deadline against the real clock, while the engine registered deadlines from
the fake clock, set to noon: each was hours past the moment it was scheduled
and fired on whichever real tick landed inside the test. On an idle machine
no tick lands inside a 29ms test. On a loaded one, one does, the primary
timer "expires", the time bank auto-activates and "expires" on the next
tick, and the actor is folded.

`vi.clearAllTimers()` in the test's `afterEach` could not remove that
interval (it was real), and the scheduler kept believing it was running, so
the loop and the previous test's leftover deadlines - same table id, same
seats - carried into every later test in the file. Nineteen engine test
files run under fake timers with the same exposure.

## What changed

- `DeadlineScheduler` binds `Date.now`, `setInterval` and `clearInterval` at
  call time, so whichever clock is installed when it runs is the clock it
  runs on. Production installs nothing; nothing changes there.
- `schedule()` starts the tick loop if it is not running, so an engine built
  before the loop was stopped still gets its deadlines fired.
- `server/src/testing/theSchedulerStopsBetweenTests.ts`, a setup file for the
  whole server suite: `deadlineScheduler.stop()` after every test, so no tick
  loop and no deadline crosses from one test into the next.
- Two tests in `DeadlineScheduler.test.ts` pin it: the singleton fires
  exactly when the fake clock reaches a deadline and not before (red on the
  old binding), and nothing scheduled by the previous test is pending.

Full server suite on the Mac after the change: 662 files, 9104 tests, green.
