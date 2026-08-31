# 2026-08-31 — MTT Phase 2: tournaments are observable

Phase 2 of 7 from `.agent/audits/2026-08-31-mtt-deep-dive-what-is-left.md`.

## What was wrong

`/metrics` carried **895 `poker_*` series and not one mentioned a tournament.**
Every rule file was about tables — and a tournament that never started owns no
table, so it was invisible by construction. No tournament alert rule could be
written, because there was no series to write one against.

That is why every tournament defect in the 2026-08-30/31 audit was found by a
human running SQL by hand:

- 10 of 16 RUNNING MTTs hung heads-up-won for **hours**, champion unpaid;
- 19 scheduled events spawned nothing for **six days**;
- one event paid **141%** of its prize pool.

Separately, `raiseFinancialAlert` had callers only in **cash** settlement — no
tournament payout path raised one, so a failed prize landed in the error
tracker with the stack traces instead of the financial alerts queue with the
other money incidents.

## What changed

**1. `services/TournamentMetrics.ts` (new).** A 60-second collector behind one
`STABLE SECURITY DEFINER` RPC (`fn_tournament_metrics`), emitting seven gauges:
running, registering, overdue_start, stuck_completing, seatless_phantoms,
unpaid_completed, and `metrics_stale_seconds`.

It comes from the **database**, not from in-memory managers, deliberately: the
most valuable signal is "a tournament that should be running is not", and an
engine reporting only on tournaments it owns can never see that — the failure
_is_ the absence of a manager.

**Fail-closed, loudly.** A failed refresh keeps the last good snapshot rather
than zeroing it, because a row of zeroes is indistinguishable from perfect
health — the defect shape this codebase keeps re-learning (`remainingCount ||
0`, `players ?? []`, `takenRows || []`). `metrics_stale_seconds` is what proves
the other six are current, and a collector that has _never_ succeeded reports
86,400 rather than 0, so a permanently-broken boot is a firing alert instead of
a healthy-looking platform. Refresh failures are reported once per outage, not
once per attempt — an every-minute timer would otherwise turn one broken query
into 1,440 error reports a day.

**2. `infra/monitoring/tournament-rules.yml` (new)** — six alerts:
`TournamentNeverStarted`, `TournamentStuckCompleting`,
`TournamentSeatlessPhantoms`, `TournamentCompletedUnpaid`,
`TournamentMetricsStale`, `TournamentLobbyEmpty`. Loaded in `prometheus.yml`,
mounted in `docker-compose.yml`; `check-monitoring-drift.mjs` now reports
**6 rule files** (was 5).

**3. Tournament payout failures escalate as money.** Both prize-credit failure
paths in `TournamentManagerEliminations` now `await raiseFinancialAlert(...)`
with the tournament id, user, place, amount and idempotency key — awaited so
the alert is on disk before the process can be recycled.

**4. `idx_tournaments_completed_ended_at`** — the unpaid-prize arm was a **Seq
Scan discarding 50,849 rows, 908ms**. With the partial index the whole grouped
read is ~470ms once a minute.

## The finding that changed the design

The first cut counted _every_ format past its start time and read **31 on
production** — all SNG or Spin with **zero entrants**. That is not a fault: a
seat-first game sits open with a nominal start time and begins when its seats
fill, so "past start time with nobody in it" is its resting state. An alert
wired to that number would have fired the day it shipped and been muted by the
end of the week, which is worse than no alert.

`overdue_start` is therefore **MTT only** — the format where a start time is a
promise to the player — and reads 0. The SNG/Spin number is kept as
`poker_tournaments_seat_first_waiting`, informational, and a law test asserts
no alert expression ever references it.

## Tests

`tournamentsAreObservable.law.test.ts` — 11 pins, including: every gauge an
alert references is actually emitted; every metric named in a rule expression
exists; a never-collected snapshot reports stale above the alert threshold; a
failed refresh preserves the last good values; the rule file is both loaded and
mounted; and the seat-first count is never alerted on.

Full server suite: **271 files, 3,085 tests, all passing. `tsc --noEmit`
clean.** `check-monitoring-drift.mjs` green.
