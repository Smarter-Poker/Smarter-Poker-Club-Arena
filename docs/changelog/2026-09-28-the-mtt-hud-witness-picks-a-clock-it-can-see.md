# The MTT HUD witness sizes its own deadline instead of gambling on one (2026-09-28)

Runs 36381276194 and 36389080031 of the post-deploy certificate
(`.github/workflows/post-deploy-e2e.yml`, "Live-table and engine
verification", `tests/e2e/production-live-table-realtime.spec.ts`, project
`webkit-live-table-realtime`) both failed only the MTT case with "The
recovered MTT has no eligible natural HUD clock inside the remaining case
budget". SPIN, SNG and cash all passed.

## What was wrong

PR #5465 (`aa47be83`) correctly moved the natural-HUD-clock qualification to
after the mandatory hand/offline/rejoin reconnect proof, so a level_up
received during the deliberate outage could no longer satisfy the witness.
But it kept qualification gated on the case's one remaining fixed deadline:
`eligibleHudClock` refused a level whenever `remainingMs + 60s` exceeded
whatever was left of the shared 390-second case budget after the reconnect
proof (which itself costs roughly 130s).

The attached `mtt-hud-clock-qualification` evidence from run 36389080031:
tournament `2dbd67a7`, RUNNING, 164 players, `current_level` 10 (zero-based,
7-minute levels), `level_started_at` 07:02:47.5Z; the case started
07:03:25.9Z with a 390000ms test timeout; the read left roughly 277398ms of
that deadline, while the level needed about 51.6s more than that to satisfy
its own 60s reserve. Nothing was wrong in production - the level simply
ended too late for the fixed case budget, and whether it did was chance:
roughly half the time, on a 5-10 minute production blind schedule, the
current level's remaining time plus the reserve fits inside whatever the case
happens to have left after the reconnect proof, and half the time it does
not. PR #5451 (`29577873`) had already found and tried to fix this exact
flakiness by fixing the MTT case's overall timeout at 900s; #5465
intentionally reverted that in favor of qualifying strictly after recovery,
which fixed a different, real bug (the outage-window race) but reintroduced
the coin flip against the fixed budget it kept.

## The fix

`eligibleHudClock`'s third argument is no longer a shrinking case budget to
compare `requiredObservationMs` against. It is `levelCapMs`
(`MTT_HUD_LEVEL_CAP_MS`, 15 minutes, well above the observed 5-10 minute
production schedule): a level is eligible whenever it fits under that cap,
regardless of how much of the case happens to be left. A genuinely long,
paused, terminal or malformed clock is still refused exactly as before, with
the same qualification attachment.

Once a clock is known, `mttCaseTimeoutMs(elapsedMs, clock, currentTimeoutMs)`
sizes the case's one deadline to what that specific clock actually needs -
time already spent plus the clock's own `requiredObservationMs` - and never
below the timeout already in force. `production-live-table-realtime.spec.ts`
calls `testInfo.setTimeout` with that result immediately after the clock is
read and before the event wait begins, so the wait (`hudEventObservationMs`)
gets a deadline sized to the real clock instead of the original fixed one. No
synthetic level change, no retry-to-green, no skipped case, no loosened
assertion: the natural `level_up` witnessed by both isolated spectators after
the mandatory reconnect is still required.

The 60-minute job timeout (`.github/workflows/post-deploy-e2e.yml`, already
raised from 45 to 60 by #5451) is unchanged and still covers the worst case:
`tests/await-engine-gameplay.test.ts` now checks the job budget against the
MTT case's actual worst-case ceiling (the shared 390s floor plus the 15-minute
cap plus the 60s reserve) instead of assuming every tournament case is the
same fixed size, and still requires five minutes of spare cleanup margin.

## Tests

`tests/unit/tournamentHudWitness.test.ts` reproduces the exact recorded
figures from run 36389080031 (the 277398ms budget, the 07:02:47.5Z level
start, the 7-minute level, the 390000ms case timeout) planted red against the
prior design - `eligibleHudClock`'s old budget-shaped third argument refused
this clock outright - and green against this fix, along with the cap
boundary, the still-refused paused/terminal/malformed/too-long cases, and the
`mttCaseTimeoutMs` arithmetic (including that it never shrinks a case below
its current timeout). `tests/unit/liveTableRealtimeFormats.guard.test.ts` and
`tests/await-engine-gameplay.test.ts` were updated to match the new call
shapes; SPIN, SNG and cash are untouched.

This change is verification tooling only. A local passing regression or a
protected merge is not production MTT HUD proof; the next containing
maintained browser run must supply that result.
