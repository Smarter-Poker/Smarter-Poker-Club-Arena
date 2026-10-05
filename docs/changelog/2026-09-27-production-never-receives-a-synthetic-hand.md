# Production Never Receives A Synthetic Hand

Board #5070, incident `e2e-synthetic-hands`, lane PRIMARY-CHAT.

## What Happened

`tests/e2e/production-daily-missions.spec.ts` certified the settled-hand Daily
Missions trigger by inserting a synthetic `hand_history` row into the
production database through the service role: `table_id` and `tournament_id`
NULL, `winners` and `players` empty, `pot_size` 600, `hand_number` in
1,700,000,000 to 1,799,999,999, `source` defaulting to `manual`. It deleted the
row in a `finally` block. Every run of Post-Deploy E2E therefore put a
winnerless 600-chip hand into the live hand ledger for the length of the run,
and every run that was cancelled or hit the job timeout before its `finally`
left the row there for good.

Four survived: 2026-09-11, 09-19, 09-23 and 09-24. They are the only
`table_id IS NULL` rows in `hand_history`. The cash-pot conservation check read
three of them inside its 24-hour window and raised `no_winner_recorded` twelve
times (six-hourly, four detections per hand), all linked to the one unresolved
`financial_alerts` row for that condition. The monitor was right: a hand
holding 600 chips with no winner is what it exists to find. The hands were not
real.

Two earlier drafts (#5225, #5226) diagnosed an engine crash fallback and a
direct probe call; both were closed. The SIGTERM handler added by #5357 only
narrowed the window: the synthetic row still reached production on every run.

## The Fix

- The production spec no longer writes `hand_history` at all. Its step now
  certifies the production half the trigger hands off to. It inserts the exact
  `daily_challenge_event_outbox` row that `fn_enqueue_hand_daily_missions()`
  writes for a settled hand (`user_id`, `event_key`
  `certification:outbox:<uuid>`, `amounts`, `magnitudes`, `threshold_values`
  `{big_pots: [499, 500], strong_hands: [6, 7]}`, `occurred_at`; the rest take
  their table defaults, as they do for a real hand). It then waits for the live
  pg_cron drainer (`sp_drain_daily_challenge_event_outbox` to
  `fn_drain_daily_challenge_event_outbox_user`, four shards once a minute) to
  book it: the exact receipt appears in `daily_challenge_progress_events` and
  the outbox row is gone. The spec never books the event itself, so production
  still certifies the trigger's handoff, the outbox and the drainer, and a
  stalled or broken drainer fails the run.
- The drain wait is 180 seconds, derived from the measured production lag from
  `occurred_at` to the booked receipt (2026-09-27, three hours, 266,771 hand
  events): p50 29 s, p95 58 s, p99 69 s, max 173 s. The previous 60-second wait
  sat below the p99.
- The trigger itself (`hand_history` insert to `daily_challenge_event_outbox`)
  is certified on a private native PostgreSQL by
  `scripts/ci/test-daily-missions-hand-trigger-postgres.py`, which loads the
  newest migration that defines `fn_enqueue_hand_daily_missions()` and the
  trigger DDL, and proves: exact threshold preservation, per-player events and
  `{}` defaults, a malformed event isolated from its siblings, no event means no
  outbox row, and atomicity plus idempotency with the hand's own transaction.
- The service-role request layer refuses the write at run time.
  `serviceRequest` in `tests/e2e/support/temporaryCustomizationAccount.ts`, the
  one path every service-role row write and RPC takes, calls
  `assertProductionLedgerWriteAllowed` from
  `tests/e2e/support/productionLedgerWritePolicy.mjs` before it sends anything.
  A non-read request to a hand or ledger table, or to an RPC that commits,
  settles or repairs a hand, rake, payout, jackpot or seat, throws before it
  leaves the runner, whatever helper or path built it. There are no ledger-write
  exceptions. The prior milestone fixture now credits its 15 Diamonds once
  through `add_diamonds_to_balance` with its actual milestone reference and
  type; the credit produces its own journal. Legacy 1.5x metadata is tested
  against the maintained dashboard function in the private PostgreSQL cluster.
- `tests/operations/production-e2e-ledger-write-guard.test.mjs` reads the same
  lists and refuses, on every pull request that touches `tests/e2e`, any spec that
  writes a hand or ledger table, calls a hand or ledger RPC, or spells a REST
  path to a ledger table; a helper write or service RPC whose target it cannot
  read is refused too. It also pins the run-time refusal and the CI wiring.
- Both proofs run in their own workflow,
  `.github/workflows/production-e2e-synthetic-hand-guard.yml` (pull_request,
  no timer), on any change to `tests/e2e`, either proof, any migration (the
  trigger proof loads the newest definition) or the workflow itself; the native
  proof installs PostgreSQL 17 from the signed PGDG source and runs as the
  unprivileged runner user. `ci.yml` is not changed.

A database constraint on `hand_history` is not the owning layer here: the
engine writes hands through the same service role, so the database cannot tell
a certification write from a real one, and a constraint would be a migration
for a defect that lives in the test harness.

## Not Changed Here

The four surviving rows are left in place for the owner. Migration
`20260926151328_prune_e2e_certification_hand_history_fixtures.sql` (from #5357)
is on main and not installed in production; as written it would classify these
rows as keepers (their `players` array is empty) and set `has_human = true`
rather than prune them.

## October 5 Launch Repair

Recovered and qualified against current main under the owner's explicit request
to fix the launch-audit findings. Preserves the newer milestone-reference shape.
The old patch's exception prefix was stale and would have refused that fixture;
the exception and duplicate journal write are both removed. Historical rows are
not deleted by this test change; their separate migration retains its own owner.
