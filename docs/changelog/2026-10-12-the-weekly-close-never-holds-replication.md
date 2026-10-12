# 2026-10-12: the weekly close never holds replication

## What broke

On 2026-10-12 Supabase Realtime shut its replication connection down four
times with `ReplicationSlotLagTooHigh` ("lag exceeds 50% of
max_slot_wal_keep_size", which is 3 GB here, so 1.5 GB): 09:19:48, 09:39:56,
10:19:20 and 11:23:45 UTC. DB broadcasts were down for every player for
roughly 09:19-09:23, 09:39-09:47, 10:19-10:49 and 11:23-11:44. The same
happened three times on 2026-10-06 (16:33:21, 18:25:26, 19:35:41).

The slot's restart point cannot pass the first WAL record of the oldest open
writing transaction. This database writes about 240-280 MB of WAL a minute
(measured 13:15-13:20 UTC: 1,151 MB of lag behind a 4 min 44 s old job 272
transaction, 61 MB a minute after it committed). So any transaction that
writes and stays open for about 5.3 minutes takes Realtime down.

Every one of those transactions was cron job 272, `union-weekly-rakeback-close`:

| day   | job 272 tick (UTC) | length | budget          | Realtime shut down |
| ----- | ------------------ | ------ | --------------- | ------------------ |
| 10-12 | 09:10:00           | 13:47  | 3600 s / 50 min | 09:19:48           |
| 10-12 | 09:27:28           | 16:49  | 3600 s / 50 min | 09:39:56           |
| 10-12 | 10:10:00           | 15:23  | 3600 s / 50 min | 10:19:20           |
| 10-12 | 11:15:00           | 24:22  | 3600 s / 50 min | 11:23:45           |
| 10-06 | 16:25:00           | 12:00  | 720 s / 9 min   | 16:33:21           |
| 10-06 | 18:20:00           | 5:26   | 720 s / 9 min   | 18:25:26           |
| 10-06 | 19:30:00           | 5:45   | 720 s / 9 min   | 19:35:41           |

The 10:29:35 tick (17:17) and the 11:39:23 tick also ran on the large budget
while Realtime was already down. The 12:31:38 shutdown on 10-12 was most likely
not job 272 (its 12:30 tick was 1.6 minutes old): 300 s statements were being
cancelled at 12:31:15-39, the shape of the rakeback settler's page recomputes of
the closed week that #6757 stops sending.

## Why the ticks were that long

1. **Job 272 escalated itself to an hour.** Its command set statement_timeout
   3600 s and a 50 minute scope budget whenever this week's inventory
   checkpoint was unsealed, or a tick had timed out or run out of budget in the
   last 3 hours (720 s and 9 minutes otherwise). That is the "close that cannot
   be chunked still finishes" fallback of 20261003101805, and it was armed all
   morning: the seal failed with 54000 after ~10 minutes on every tick (rows
   hashed as one >1 GB string; fixed in 20261012113248), and because the seal's
   failure handler fell through, each tick then went on to visit a scope in the
   same transaction.
2. **Every ordinary tick re-proved the same failed steps.** A union P&L step
   that finds a problem is never kept, so every attempt re-read the closing
   boundary, the counts and the original flows of the week (the week
   2026-10-05..12 has 31 invalid original flows; fn_union_pnl_original_flow_evidence
   alone is 76 s over 814,510 rows; ~175 s for the report up to the plan) before
   reaching the earned plan's two-hour windows, which take 3.9 s each but are
   rationed to 120 s after the attempt began. Each 3-5 minute tick proved ONE
   window: 9 of 84 between 10:25 and 13:20.

## What changed (20261012134146_the_weekly_close_never_holds_replication)

- **Job 272 has one budget:** statement_timeout 240 s and a 3 minute scope
  budget on every tick. No larger fallback exists. 240 s is about 1.0-1.1 GB of
  WAL at the measured rate.
- **The windows go first.** fn_union_pnl_evidence_report proves the plan's
  two-hour windows right after the opening boundary, before any step that can
  be re-proved, so one tick proves ~25 windows instead of one.
- **A step that found a problem is kept for one hour** (closing and opening
  boundary, original flows, touched registrations, club rows), as
  `<kind>_problem` in accounting_close_certificates, read through the new
  fn_accounting_close_problem. It is never certified and never pays: the report
  states the same issues from the same value, and an attempt re-proves it once
  the hour has passed. Each attempt therefore proves at most one long step.
- **The seal runs in the bounded tick**, a failed seal ends a chunked tick, and
  a seal or scope step that does not fit the tick raises a critical
  union_accounting_scheduler alert: there is no larger budget to retry it with,
  so it is a step to split, not one to wait on.

No rate, payee, amount, rounding, routing, receipt, idempotency key or refusal
changed, and the money rounds were not touched.

## Equivalence

- The migration was run against a local PostgreSQL 17 holding production's
  exact preimages (md5 ac28cf98..., 3cb89019..., job a532167f...): every anchor
  matched once, the installed text equals the substituted text, the live proof
  is true, and a second apply refuses.
- Moving the advance only changes WHEN windows are proved: outside a chunked
  close it returns NULL (no-op, as before) and once every window exists it
  returns true immediately, so the report then runs exactly the statements it
  ran before, in the same order.
- A kept problem holds the value the same function returned; every read of it
  is the read the fresh proof fed into the report (the clean certificate path
  already reads these same fields).

## Known steps that may not fit 240 s yet

These will now raise a critical alert instead of stalling Realtime, and are to
be split:

- the inventory seal's final assembly: ~90 s for 3,352,453 rows on 10-12, but
  it inserts every row of the week (~1.7 GB of table) in one transaction, which
  is over the 1.5 GB lag by itself. It grows each week (478k, 1.8M, 3.4M rows).
- the round-4 attempt of 2026-10-07 (union invoices issued) ran 7:19.
