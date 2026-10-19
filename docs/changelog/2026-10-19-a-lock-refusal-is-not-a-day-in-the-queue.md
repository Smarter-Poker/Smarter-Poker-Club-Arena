# 2026-10-19: a lock refusal is not a day in the queue

Migration `20261019102410_a_transient_cash_refusal_is_retried_first_and_the_seal_write.sql`,
law `tests/a-lock-refusal-is-not-a-day-in-the-queue.law.test.ts`.

## What was wrong (read on production 2026-10-19 09:40-10:30 UTC)

**Midway rake that never reached its rakeback.** Fourteen Midway Union cash
rake receipts (31.41 chips, earned 2026-10-17 00:16 to 2026-10-19 07:15) had
no accrual batch, so the union's week could not certify
(`union_cash_sources_do_not_match_bank`). Thirteen had been refused exactly once
by a lock: eight `deadlock detected` (40P01) between two clubs'
`agent-commission:<club>` keys (Club JAQK and a41434bb), five
`lock timeout` (55P03). Each refusal is due again 60 s later, but
`fn_retry_cash_accounting_sources` takes five rows a settler cycle, oldest
`next_attempt_at` first, and ~900 Lightning Internal Pilot sources refused for
`cash_commission_attribution_incomplete` were older. At 09:33 the retry was
reaching rows due 2026-10-18 04:27, so a lock refusal waited up to a day.

A rolled-back replay of the fourteen through `fn_process_cash_accounting_source`
accrued ten, met a new deadlock on three, and refused one for a reason no retry
can change (below).

**The weekly close of 2026-10-12..19 could not start.** Its original inventory
checkpoint (4,520,200 rows) is published through bounded committed pages
(`20261012200734`). `fn_union_pnl_inventory_seal_advance` wrote one page per call
(16,893 rows, 14.5 MB of WAL, 0.7 s) and job 272 calls it once per five-minute
tick: 253,306 rows after 1 h 45 min, about 21 hours still to go.

**The engine's probe of the close always ran out of time.** The settler calls
`fn_union_settlement_cascade_due` every cycle as `service_role` (8 s statement
timeout). Without job 272's chunked settings that call runs the full scope
scan, which a rolled-back call measured past 50 s; it was cancelled at 8 s
(pg_stat_statements max 8,056 ms) while holding the scheduler lock job 272 needs.

## What changed

1. `fn_process_cash_accounting_source` retries its own subtransaction after a
   deadlock, at most three times, before it refuses. The rollback of the
   subtransaction releases the item's commission keys, so the other transaction
   proceeds. A lock refusal (40P01, 55P03, 40001) that still remains is due again
   after 15 s per attempt (at most 300 s) instead of 60 s per attempt.
2. `fn_retry_cash_accounting_sources` takes the rows with the fewest refusals
   first (attempts, then due time), in its commission-key walk and its loop.
3. `fn_union_pnl_inventory_seal_advance` keeps writing pages in the same call
   while rows remain past the durable cursor, until 384 MB of WAL has been
   written since the call began (a quarter of Realtime's 1.5 GB slot-lag
   cutoff from `20261012134146`), 45 s pass or 64 pages are written. A
   rolled-back replay on production wrote 18 pages (304,029 rows) in 11.1 s.
   The page writer, its equality proof and checksum are unchanged, and
   publication still happens on a later call, after the final page committed.
4. `fn_union_settlement_cascade_due` called without the chunked tick's settings
   and with under a minute of statement budget visits no scope and returns the
   zero-scope receipt the engine already accepts. Job 272
   (`union-weekly-rakeback-close`) owns the weekly close.

No ledger row, receipt, invoice or payment is written by the migration, and no
historical record is rewritten. The thirteen lock-refused receipts are accrued by
the settler's own retry path once the migration is installed.

## Left for a decision

Rake record `a6eaf5e8-0eb4-4d97-91d6-000c929c6b57` (5.00 chips, Midway hand of
2026-10-17 00:16:58.72) is refused `cash_commission_hierarchy_invalid_at_earning`
and parked behind 35 attempts. One of its three contributors (0.06 of the 5.00
credit) is a member whose agent's super agent `af6dc0cc` was suspended at
00:16:58.199 by the account-deletion migration, while that agent and the member
were only re-homed at 00:17:01.68-.70 in the same transaction. The hand's
as-of read therefore sees an upline that is suspended and a downline not yet
moved. The codebase has no documented exclusion or suspense path for this, so it
is left refused, and the union's earned-rake check counts it for the week of
2026-10-12..19 until someone decides how that 5.00 is attributed.

## Follow-up: the retry queue is backlog too (engine)

Read after the migration was installed (13:46 UTC): the queue order was right,
but the settler only reached the retry when its own cycle ran, and a cycle
whose page of new rake was empty reported `idle` even when the retry had just
returned a full batch. So it slept its 30-minute interval with ~700 refusals
still due (254 of them refused once, 216 ahead of the oldest Midway lock
refusal), retrying 5 per inner run, about 10 per half hour.
`RakebackSettlerService._runSettlementInner` now reports `more` when the retry
returned a full batch (`CASH_RETRY_LIMIT`), so the same bounded drain
(`MAX_DRAIN_BATCHES`, then the 60 s catch-up) keeps running until the due queue
is shorter than one batch. Pinned in `server/src/services/rakebackWatermark.test.ts`
("a full retry batch keeps the drain running even when there are no new rake rows").

## Follow-up: the seal proves its build bucket by bucket (20261019151632)

With all 4,520,200 rows written at 15:00 UTC, the publishing ticks of 15:05
and 15:10 were both cancelled at job 272's 240 s statement timeout:
`fn_union_pnl_inventory_seal_write_page` proved the build equal to the cache
with one `EXCEPT ALL` of the whole cache against the whole build in both
directions, and a read-only replay of exactly that query on production ran
past 290 s. The 15:15 tick happened to finish in 175 s and published the
checkpoint at 15:17:55 (rows hash `864e2008...`, equal to the original
assembly), but next week's inventory is larger and would not.

The proof is now taken bucket by bucket: each side is read once into
per-(kind, source, first two hex digits of row_id) counts and hashes and the
two bucket sets must be identical; the build's row buckets give the rows hash
that must still equal the original assembly's head. The build-side hash pass
measured 34.8 s on production. `scripts/dev/test-inventory-seal-committed-pages.py`
installs the successor in every scenario and adds a cache that drifted after
its rows were copied, which must be refused with
`inventory_build_disagrees_with_assembled_source`. The local native run was not
possible on the shared SSD (the harness refuses below 8 GiB free; 6.3 GiB);
the required accounting shard runs it.
