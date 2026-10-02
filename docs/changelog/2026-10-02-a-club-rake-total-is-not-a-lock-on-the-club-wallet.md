# A club's rake total is not a lock on its wallet (2026-10-02)

Phase 2 of 9 (live game integrity): the voided hands and the decided-tournament backlog.

## What was happening

Between 18:00 and 19:45 UTC the postgres log recorded 1,518 `canceling statement due to
statement timeout` errors on one statement, plus about 100 more `while locking tuple ... in
relation "club_wallets"`. That is more than every other timed-out statement on the platform put
together (the next one had 85). The statement was the per-hand accumulator in
`atomic_distribute_rake`:

```sql
UPDATE public.club_wallets
   SET period_rake_collected = period_rake_collected + p_rake, ...,
       chip_balance = chip_balance, updated_at = NOW()
 WHERE club_id = p_club_id
```

It runs inside `fn_ca_process_hand_post_commit_obligations`, and the transaction keeps the row
until COMMIT. That means every raked hand at every table of a club waited on every other one.
They also waited on every tournament finish of the club, because
`fn_complete_tournament_terminal_pre_seat_guard` takes the same row first (`FOR NO KEY UPDATE`)
and keeps it for its whole body. That body ran 4 to 12 seconds this evening.

What it caused:

- **Voided hands.** At 19:33, `pg_stat_activity` showed post-commit calls queued 3 to 8 seconds
  deep, each waiting on the one before it. The root of the queue was a tournament finish that had
  been running for 15.6 seconds. At 19:37:07 PostgREST began killing threads ("Thread killed by
  timeout manager"). The lease heartbeats use the same PostgREST client, so they got no
  connection. At 19:37:26-32 the engine refused 180 hands on 116 tables as `lease_proof_expired`.
  The engine's `hand_history` step averaged 1.13 s per cash hand, and 127 of those steps threw.
- **Decided tournaments waiting for their payout.** A finish that waits on the wallet also holds
  its settlement lane, so the club's other decided events wait behind it. At 19:33 there were
  244 decided but unfinished events. The oldest last bust was at 18:10, and the time from last
  bust to payout was 45 to 60 minutes.

## Why the write could move instead of staying

The columns are a statistic, not a balance:

- The hand's rake leaves the felt through `rake_records`. From there it either goes to the union
  rake treasury or is retired.
- The club's share is paid weekly. The UPDATE even wrote `chip_balance = chip_balance`.

Only three SQL functions touch the columns. No page, no engine code and no World Hub route reads
them (checked on main and in `pg_proc` today):

| function                    | before                                                             | after                                                     |
| --------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `atomic_distribute_rake`    | adds every hand to the club row                                    | adds it to the hand's (club, table) row                   |
| `fn_settle_tournament_rake` | adds tournament net rake under the finish's own lock               | unchanged (the finish already holds the row)              |
| `fn_club_money_panel`       | shows `period_rake_collected` as a standalone club's rake treasury | shows the wallet column plus the sum of the club's tables |

`period_*` has never been reset, so the panel shows exactly what it would have shown. Nothing was
backfilled and nothing was repaired.

## What changed

Migration `20261002194128_a_club_rake_total_is_not_a_lock_on_the_club_wallet`:

- **New table `public.club_table_rake_totals`.** It has one row per (club, table). A table deals
  one hand at a time, and its post-commit obligations already run one at a time per table, so
  each row has exactly one writer. The table has no foreign keys (CLAUDE.md section 2 rule 7).
  Row-level security is on, and anon and authenticated are revoked.
- **`atomic_distribute_rake`.** The UPDATE becomes an upsert into that table. The receipt's
  `balance_after` is read from the wallet without a lock. A club with no wallet row still gets
  one, at zero.
- **`fn_club_money_panel`.** It now adds the club's table sums to the wallet column.
- **Pinned text.** Both changes are asserted substitutions over the pinned live text
  (`0ef820b1... -> 3cb33db3...`, `1374b5a7... -> b565ebe8...`). They abort if either function
  has changed underneath them, and they check that the reverse substitution reproduces the
  pre-image.

It also ends the finish-against-raked-hand deadlock pair that `20261001000500` had to reopen.
That migration tried to fix the pair by having hands take the wallet earlier, which made finishes
wait on hands. A raked hand now only reads the wallet, so the pair no longer includes a
`club_wallets` lock at all.

## Proof

`scripts/ci/test-club-rake-total-is-not-a-lock.py` runs on a disposable PostgreSQL cluster
(17 cases, all green):

- It loads production's pre-image exactly; the md5 of `pg_get_functiondef` matches production.
- With one hand left open at table 1, a hand at table 2 of the same club blocks, and so does a
  finish's wallet lock. This is the BEFORE case, and it reproduces the problem.
- It then runs the shipped migration's own substitution block (pins included), and the
  post-image md5 matches.
- With the same hand left open, neither the table-2 hand nor the finish blocks. This is the AFTER
  case.
- Every figure is still written exactly once:
  - the per-table total
  - the same hand id twice counts once
  - the wallet is untouched
  - one receipt, carrying the wallet balance
  - one burn for a standalone club
  - the union rake treasury still credited for a union club
  - a new club's wallet created at zero

Law: `tests/a-club-rake-total-is-not-a-lock-on-the-club-wallet.law.test.ts`.

## What is still held

- **The union rake treasury.** `union_wallets.rake_wallet` is still one row per union, and every
  union hand writes it. It is real money, so it stays.
- **The cash commission batch.** The finish body still waits on the club's agent-commission key
  while a cash commission batch holds it. That is fixed separately, by limiting how long a batch
  may hold the key.
