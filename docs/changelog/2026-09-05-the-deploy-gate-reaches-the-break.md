# 2026-09-05: the deploy gate reaches the break

Found while verifying that Realtime Phase 1 had actually reached production.
It had not, and neither had the three merges before it.

## What happened

Run 33942233521 carried the whole of Phase 1. Its build finished at
03:40:37, it polled the maintenance gate 56 times at 15-second intervals,
and it gave up at **03:54:37 — twenty-three seconds before**
`readyForRestart` went true at 03:55:00. The run reported **success**, and
its own summary said, accurately, "DID NOT DEPLOY". The run before it missed
the same way. Production sat on `dbe3c513` while `main` was four merges
ahead.

Dan, 2026-09-01: "no work ever gets lost, orphaned or not published ...
EVER." A gate that can expire one breath before it opens is exactly that
failure, and it is invisible because the run is green.

## Why the numbers stopped fitting

Two things drifted apart and nothing tied them together:

- the wait was a **fixed 14 minutes**, written when this workflow ran on
  three ticks (`:40,:45,:50`) and the wait began seconds after dispatch;
- the ticks were later cut to one (`:45`), and the build ahead of the gate
  grew from about five minutes to **8-18**.

From `:45`, an 8-minute build starts waiting at `:53` and wins; a 14-minute
build starts at `:59`, waits through an empty hour, and loses. Whether a
merge reached production had become a coin flip on build duration.

## The fix

- **The budget is derived from the clock, not guessed.** The gate polls
  until the next `:56` — one minute past the moment the flag opens — so a
  run whose build lands in the viable window always reaches it.
- **The ceiling is what the job actually has left.** A new first step stamps
  `DEPLOY_STARTED_AT`, so the build's real cost is subtracted, with five
  minutes reserved for cutover, verify and promote. A fixed cap was wrong
  twice; this cannot be.
- **A run that cannot win says so immediately.** If the next break is
  further off than the budget, it exits at once with the reason instead of
  sleeping fourteen minutes to reach the same answer.
- **`timeout-minutes` 25 -> 40**, because 25 could not hold an 18-minute
  build plus a full wait, and the wait was silently the part that got
  squeezed.
- **The tick moves `:45` -> `:35`**, so every build length actually observed
  finishes inside the window. `tests/the-break-clocks-agree.law.test.ts`
  holds every tick in `:35-:50`; `:35` is the earliest it allows, and the
  law stays green.

Replayed against the exact failure (build done `:40:37`, 397s elapsed): the
new budget grants 67 attempts covering 1005s and **reaches the gate**. A run
finishing at `:10` still cannot win, and now says so in one HTTP request
instead of a quarter hour of runner time.

## What this does not change

The gate itself is untouched: a restart still happens only when the engine
reports `readyForRestart` inside an announced break, and `force: true` is
still the only way past it. This changes how long the run is willing to
wait, not what it waits for.
