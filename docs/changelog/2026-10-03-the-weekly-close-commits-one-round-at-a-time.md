# The weekly close commits one round at a time (2026-10-03)

## What happened

Cron job 272 (`union-weekly-rakeback-close`) closed each weekly book in one transaction. The
Midway close of 2026-10-01 held one for 68 minutes (4,090 s; auto_explain, job 391) and the Deep
Stack Society close of 2026-09-29 one for 21 minutes, pinning the xmin horizon of a WAL-saturated
database the whole time. The week closing 2026-10-05 carries about 2.3 times the sources, which put
that transaction at 1.5-2 hours. The coordinator decided (2026-10-03, Dan having delegated settlement
decisions to the agents) that each money round commits in its own bounded transaction, resumed from
the rounds' own receipts.

## Fix

Migration `20261003101805_the_weekly_close_commits_one_round_at_a_time`. Everything below happens
only when job 272 sets `app.weekly_accounting_chunked`; unset, every function behaves as before.

- `fn_union_settlement_cascade` returns `{"success":false,"chunk_committed":true,"committed_round":N}`
  after a round that moved money: round 1 (its union wallet debit posted inside round 1 by its
  original undeferred path, since a pending debit is transaction-local), round 2 (only without
  shortfall), round 3 (only after the shortfall, pending player period and conservation tests). The
  next attempt skips round 1 by `union_rakeback_log` (`already_executed`) and rounds 2 and 3 by
  `accounting_routed_settlement_runs`, answered exactly as the stage answers a duplicate.
- Marking the period settled, ECO, round 4 square-ups, credit invoices and club statements happen only
  in the attempt that finds rounds 1-3 committed.
- `fn_process_weekly_accounting_scope` keeps a chunk's run row `running` with the chunk receipt, with
  no failure and no alert, returns `more_remaining`, and does the same for the standalone club stages.
  An attempt that runs out of its 9-minute budget files a warning, not a critical alert.
- `fn_prepare_accounting_week` answers the paid-scope replay of a committed round 3 from its receipt.
- The union P&L evidence (13-18 minutes for one week at last week's volume) and the earned plan are
  proved step by step; each problem-free step is kept in `accounting_close_certificates` (private,
  RLS on, no grants) for the rest of that close (12 hours). An attempt with under 6 minutes of budget
  left after a step it proved returns a `warming` report, which the scheduler records as a
  `certifying` step.
- Job 272 runs every 5 minutes, visiting the scheduler only in the original :40 slot or while a book
  has a committed chunk in progress (or a chunk that ran out of time in the last 3 hours). Statement
  timeout 720 s and scope budget 9 minutes; 3600 s and 50 minutes when the inventory seal is due or the
  last attempt ran out of time, so a close that cannot be chunked still finishes.

## What does not change

Rates, payees, amounts, rounding, routing, which sources count, the receipts each round writes and
every refusal. A round is never paid twice: rounds 2 and 3 are found by their unique receipt key,
round 1 by `union_rakeback_log` and its final `ca_settlements` row.

## What it trades

Money a round moved stays committed when a later round fails (it used to roll back with it). Each
payee's own paid invoice is delivered when its round commits, as it always is for a payee. A club or
agent can spend a round's money before the next round's attempt locks it; that round then refuses on
funding exactly as it always would.
