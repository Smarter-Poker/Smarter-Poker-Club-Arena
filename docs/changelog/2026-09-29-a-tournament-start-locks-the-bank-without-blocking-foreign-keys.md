# A tournament start locks the bank without blocking foreign keys

Date: 2026-09-29. Migration
`20260929071925_a_tournament_start_locks_the_bank_without_blocking_foreign_k.sql`.
Law: `tests/a-tournament-start-does-not-block-foreign-keys.law.test.ts`.
Native proof: `scripts/dev/probe-start-readiness-lock.py` (accounting job,
shard 3).

## What was measured

Tournament throughput collapsed on the morning of 2026-09-29: 508 tournaments
queued in the engine's elimination scheduler, the oldest for 655 s, sweeps
taking 10-20 s. Sampling `pg_locks` joined to `pg_stat_activity` every 2-3 s
from 07:09 to 07:15 UTC (read-only):

| what waited                                                                  | on what                                                                                                                                            | held by                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `fn_complete_tournament_terminal` (up to 4 at a time, 10+ s)                 | advisory `ca:tournament-finish-lane:v1` (F, global, exclusive)                                                                                     | the one finish inside F                                                                                       |
| that finish (holding F and its `club_wallets` row)                           | the Deep Stack Society `clubs` row, FOR NO KEY UPDATE                                                                                              | a queued tournament launch                                                                                    |
| `fn_complete_tournament_launch_atomic` (a queue of up to 5, one for 21.7 s)  | the same `clubs` row, FOR UPDATE (tuple lock `AccessExclusiveLock`: held or requested in 47 of 80 samples, a second launch queued behind it in 28) | `fn_credit_agent_commissions_batch` and every other open transaction that inserted a row referencing the club |
| every raked hand's `fn_ca_process_hand_post_commit_obligations` for the club | the club's `club_wallets` row                                                                                                                      | the finish above                                                                                              |

`pg_stat_statements`: `fn_complete_tournament_terminal` mean 2.8 s (max 43 s,
11,018 calls), `fn_complete_tournament_launch_atomic` mean 0.97 s (max 29.5 s),
`fn_credit_agent_commissions_batch` mean 4.2 s (max 131 s). Engine log, 10
minutes: 145 post-commit and 145 projection statement timeouts.

Read-only lock probe on production, 07:3x UTC, one `DO` block ending in
`RAISE EXCEPTION` (each lock taken `NOWAIT` in a savepoint and released at
once), 20 attempts 0.1 s apart on the Deep Stack Society `clubs` row:

    PROBE_RESULT no_key_update ok=20 busy=0 | for_update ok=0 busy=20

FOR NO KEY UPDATE was free every time; FOR UPDATE was never free. Something
always holds FOR KEY SHARE on that row, so a start's FOR UPDATE can only ever
be granted by waiting for a gap in the stream of foreign-key writers.

## The cause

`fn_guard_tournament_start_readiness` (BEFORE UPDATE OF status, every start)
serialises starts on the bank the overlay may debit with

    PERFORM 1 FROM public.clubs c WHERE c.id = NEW.club_id FOR UPDATE;

FOR UPDATE is the only row lock that also conflicts with FOR KEY SHARE, which
is what a foreign-key check takes on the club row whenever a row referencing
it is inserted: `agent_commissions` (252,623 inserts), `game_management_events`,
`accounting_cash_rake_sources`, `rake_records`, `club_wallet_transactions`,
`table_seats`, `tournament_players`, `tables` and more. So each start had to
wait until every open transaction that had written such a row for the club
committed (a commission batch holds its inserts for its whole ~31-item run),
and while it waited its tuple lock put every later locker of the club row,
including each finish, behind it. The finish holds the global finish lane F
and the club's `club_wallets` row while it waits, which is how one lock mode
on one club row stalled every finish on the platform and the club's hand
post-commit pipeline.

`fn_ca_fund_overlay_on_lock` (the same transaction, after the guard) locked
the same rows FOR UPDATE too, when a guarantee is short.

## The fix

Both functions take FOR NO KEY UPDATE on `public.clubs` and
`public.union_wallets`: five lock clauses, two comments, nothing else.
NO KEY UPDATE conflicts with NO KEY UPDATE, UPDATE, SHARE and every UPDATE of
the row, so a competing start, the overlay and every treasury debit or credit
are serialised against a start exactly as before. It does not conflict with
FOR KEY SHARE: a foreign-key check never changes the club row, and nothing
the guard reads can be changed by one. The overlay takes the same mode the
guard already holds, so the transaction never upgrades its lock; its UPDATE of
`chip_treasury` / `chip_balance` is a non-key update.

No readiness rule, balance, payout, ledger row or grant changes. The migration
refuses to run unless both `pg_get_functiondef` md5s are the reviewed
production pre-image (or its own post-image, so it replays), owner, security
definer, `search_path`, grants and both triggers are as read back, and it
asserts the exact post-image.

## Proof

`scripts/dev/probe-start-readiness-lock.py` on disposable PostgreSQL 17 with
the captured production pre-image:

    PASS: pre-image reproduces the drain: a start waits for an open foreign-key insert and the insert waits for the start
    PASS: migration applies over the pre-image and replays over its own post-image
    PASS: post-image: neither waits; start/start, start/treasury and union start/start still serialize
    PASS: an overlay start beside an open foreign-key holder debits the bank once (1000 -> 940, pool 100)
    PASS: the migration refuses an unreviewed pre-image

## What this does not change

- The finish lane F (`ca:tournament-finish-lane:v1`) is still one finish on
  the platform at a time (2026-09-17, chosen to keep finish-against-finish
  wallet order). A finish that waits on a row lock still holds every other
  finish; this change removes the longest such wait, it does not narrow F.
- `club_wallets` is still one row per club that every raked hand, finish and
  overlay writes; its holders are still whole transactions.
- In a multi-table MTT, `fn_f06_allocate_hand_number` /
  `fn_f06_hand_number_state` take the tournament lane T(id) exclusively (via
  `smarter_private.f06_prefix`) for per-table work, so each allocation drains
  every table's in-flight hand commit (T shared). Measured on the 43-table
  12:00 AM freeroll in the same window; not changed here.
