# The nightly replay keeps no receipt's locks; player_stats writers take player keys in player order

2026-10-19 - migration `20261019155432_replay_holds_no_lock_past_its_receipt_player_stats_key_order`.
Owner approval 2026-10-19 10:35 Chicago.

## What players saw

- **Every night at 04:37 UTC, running tournaments froze for about 100 seconds.** On 10-19 engine
  settlements on 26 tables waited (37 on 10-18), the oldest ~108 s; one hand per table was written
  ~95 s late (delayed, never lost). The affected tournaments were the targets of satellites that had
  finished in the previous 26 hours.
- **Hand side effects failed with deadlocks** 13-23 times an hour from 05:00 UTC on 10-19
  (DatabaseDeadlocksElevated); 79 of 95 in six hours were the hand projection against the cash
  commission batch, on `player_stats`.

## Why

- `fn_ca_replay_terminal_receipts` (pg_cron `ca-terminal-receipt-replay-daily`) re-proves every
  terminal receipt of the last 26 h in ONE transaction. A satellite receipt is a reader but takes a
  live settlement's locks: the finish lane F exclusively, both tournaments' T keys, the target's
  `tournaments` row FOR UPDATE and all its `tournament_players` rows FOR SHARE. Each receipt ran in
  a BEGIN/EXCEPTION subtransaction, and a subtransaction that succeeds hands its locks to the outer
  transaction, so they were kept until the whole run committed.
- `fn_credit_agent_commissions_batch` is one transaction over several cash hands; item by item it
  upserts each contributor's `player_stats` row (and, through `trg_sync_profile_total_hands`, the
  profile row) in page order and keeps them. The hand projection writes the same players' rows in
  player order. Each held one and waited for the other. Row locks alone cannot be put in order: a
  row not created yet cannot be locked ahead, and the profile row is shared by every club.

## What changed

- The replay ends each proved receipt with a private sentinel (SQLSTATE `CAR01`) that its own
  inner block catches, so the receipt's subtransaction is rolled back and releases every lock it
  took before the next receipt starts. The receipts write nothing, so nothing else is undone. The
  outcome (replayed / refused / skipped_locked, failures, alerts raised and resolved) is the same.
- The batch and the projection take `'player-stats-user:<player>'` for every player whose rows
  they write, in player uuid order, before the first such row. The batch takes them after its club
  commission keys and before its first item with the same discipline as those (a busy key waited
  for at most 1 s, otherwise the item is deferred and resubmitted by the settler).
- Not changed: the cron job, the settler, `fn_retry_cash_accounting_sources`,
  `fn_process_cash_accounting_source`, any value written, owner, grants or settings.

## Proof

`scripts/qualification/replay-locks-and-player-stats-keys.py` on native PostgreSQL 17
with production's md5-pinned bodies, before and after the migration file itself
(evidence: `docs/evidence/replay-locks-and-player-stats-keys-2026-10-19/replay-locks-and-player-stats-keys-run.json`):

- Before: while the replay is paused at a later receipt, an engine hand on the target's table and
  an unrelated tournament finish both wait for the replay. After: neither waits and the paused
  replay holds no lane key; the replay's result and alerts are identical.
- Before: the batch and the projection deadlock (existing rows, new rows, and profile rows across
  clubs; the projection is the victim, as in production). After: no deadlock, the projection
  waits for the batch, every value is written once; a key held longer than 1 s defers the batch
  without writing anything and the resubmission accrues.
