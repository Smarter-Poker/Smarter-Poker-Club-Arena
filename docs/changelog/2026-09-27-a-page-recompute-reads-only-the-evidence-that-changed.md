# A Page Recompute Reads Only The Evidence That Changed (2026-09-27)

Migration `20260927160709_a_page_recompute_reads_only_the_evidence_that_changed`.

## What Production Was Paying

- `pg_stat_statements` for the settler's `fn_rakeback_recompute_periods` RPC:
  15:40 to 21:22 UTC on 2026-09-27, 233 calls and 5,299 s of execution, about
  930 s of database time an hour, a mean of 22.7 s a call.
- `auto_explain` logged page calls of 34 to 288 s, 830 to 1,350 s an hour between
  11:00 and 14:00 UTC, each holding the club-week advisory lock.
- Read-only EXPLAIN (ANALYZE, BUFFERS), Deep Stack Society week 2026-09-21:
  the three evidence counts 60,276 ms, 3.17 M buffers (211,471 read from disk)
  over 336,785 records, 527,470 attributions and 527,314 sources; the
  tournament gate 9,368 ms warm for 14,152 events.
- None of those calls wrote a certificate. The last certificate of the week is
  from 2026-09-26 13:38. The week carries 51 cash records with no accrual batch
  and no work row (40 Deep Stack Society, 11 union house) that are older than the
  200 newest records the unaccrued-hand door reads, so every fall-through read
  the whole week to reach the same refusal. Those records are older than the
  settler's cursor (late commits); that is the settler's defect, owned by the
  held PR #5430, and not changed here.

## Why It Can Be Exact

The three counts are sums over the week's records. A record with an accrual
batch is frozen: `rake_records` and `rake_attributions` refuse every change once
the batch exists, batches are insert-only, and sources are insert-only, carry a
foreign key to their batch and are written in the same transaction by the only
writer, `fn_accrue_cash_hand_commissions`. Its share of each count can only
change if the clubs' union shape changes.

`accounting_rakeback_period_evidence_checkpoints` keeps, per club-week, the
shares of every batch recorded before a horizon: the start of the oldest
transaction running (all sessions, `pg_read_all_stats`), or the clock if
earlier, less two minutes. A batch is recorded at or after its own transaction
began, so no batch recorded before the horizon can still be uncommitted, and none
can appear later. The page adds, in one snapshot (the helper is `STABLE`), the
batches recorded since the horizon and the records with no batch at all, found
by a merge of two new index ranges. The totals are the whole-week counts. A
changed clubs digest, a missing row or a changed `period_end` rebuilds from the
week's first batch. A prepared transaction or a reader that cannot see every
session leaves the horizon where it was.

Two `BEFORE INSERT` guards turn the facts into refusals: a batch must carry its
record's `created_at` and be recorded no earlier than its transaction began; a
source must carry its batch's `earned_at`. Read-only on production: 0 of 621,250
batches and 0 of 1,625,809 sources differ, no source lacks a batch.

## What Changes And What Does Not

- Only page calls (`p_user_ids` not NULL). The whole-period call made by
  `fn_prepare_accounting_week` keeps its verification byte for byte.
- A page returns the same status, reasons and counts, and writes the same
  certificates: the certificate loop is untouched. One difference, in refusals
  only, of the shape the unaccrued-hand door already answers: a page refused by
  its cash evidence is not also sent through the tournament gate.
- The first page of a club-week reads the week once to build its checkpoint.
- No cron, watcher or reconciler; the settler, cursor, `daemon_state`,
  settlement floors, `cron.job` and timeouts are untouched.
- Not addressed: the tournament gate still runs for a page whose cash evidence
  is clean, and a ready page still writes a full certificate per paged player.

## Proof

- Native (`scripts/dev/test-union-weekly-basis.py`, PG17, 84 steps, exit 0):
  `page-evidence-regression.sql`, 955 assertions. The whole-period query is lifted
  from the installed calculator as the oracle. Cluster book: 50 club-weeks, 120
  checkpoint splits. Three randomized seeded weeks with every defect the counts
  look for: 70 club-weeks, 448 splits, and 15 club-weeks after the week moved
  under a checkpoint. Calculator: 30 cluster and 14 seeded club-weeks, page
  receipts and certificates equal to the whole-period call (zero-entitlement
  payee included). Before/after: the predecessor sent a page with a stale
  batchless hand through the gate (1 call), the page path does not (0 calls); a
  checkpointed page read 6 attribution rows where the whole week reads 6,015.
  Both guards refuse and the real writer passes. `period-coverage-regression`'s
  settler-page drain now runs on the page path.
- Production, read-only, oracle and checkpoint in one statement snapshot:
  Deep Stack Society week 0/112/0 (evidence/incomplete/drifted) both ways and
  split at now-6h; Diamond Arena and Midway Union 0/0/0; SHARK 2026-09-26 12:00
  to 09-27 12:00, 0/20/0; JAQK 09-21 07:00 to 09-22 19:00, 0/0/0.
- PG17 plan check on a production-sized synthetic week (1.4 M records, 1.24 M
  batches, 275 k cash records in the week): batchless read 65 ms, a page since
  its checkpoint 54 ms warm, the one-time build 7.4 s against 8.8 s for the
  whole-week query.
- Law: `tests/a-page-reads-only-the-evidence-that-changed.law.test.ts` with
  planted regressions.
