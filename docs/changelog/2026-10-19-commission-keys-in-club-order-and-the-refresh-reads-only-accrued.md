# Commission keys are taken in club order, and the union refresh reads only what is accrued (2026-10-19)

Migration `20261019094914_commission_keys_in_club_order_refresh_reads_accrued` and an engine change in `RakebackSettlerService`. Law: `tests/commission-keys-are-taken-in-club-order.law.test.ts`.

## What was wrong

**A cash commission batch deadlocked with tournament finishes.** `fn_credit_agent_commissions_batch` and `fn_retry_cash_accounting_sources` took the club commission keys their items needed in club order, but only while they were free (`20261001001000`). The first busy key ended that walk, and every later key was then taken by the rollup trigger, item by item, in page order. One transaction could therefore hold a higher club's key while waiting for a lower one. A tournament finish takes the same keys in club order. Production logged the result at 2026-10-19 07:28:34 UTC: the batch held SHARK CLUB and waited for Club JAQK, and the finish held Club JAQK and waited for SHARK CLUB. First-attempt 40P01/55P03 refusals ran at 4 to 13 a day from 10-15 to 10-18, and 31 on 10-19 by 09:30.

The 10-01 reason for the try-lock (a wait outside an item failed the whole batch at the 8 s lock timeout) still holds. The 10-03 change that would have removed it was reverted the same night.

**The union refresh claimed sources that had not been accrued.** A refused item gets a durable `blocked` receipt, and the settler's cursor moves past it while the retry queue owns it. `fn_union_rake_basis_refresh` read through the cursor on the premise that everything below it was accrued. With one refused source below the cursor, the plan check raised `union_cash_sources_do_not_match_bank:1`, and a `financial_alerts` row was written every hour from 07:35 UTC (rake record `b23a0294-63d8-4311-8d18-b224e8d3cbf4`, 0.95).

## What changed

- **Keys first, in club order.** The batch and the retry now work out every club key their items need and take them all, in club order, before the first item. A free key is taken at once. A busy key gets a wait of at most 1 s, in its own subtransaction, while holding only lower keys. A finish never waits for a lower key while holding a higher one, so this wait cannot close a cycle. A key not granted in that time ends the walk.
- **An item whose keys are not all held is deferred.** It is not run and not refused. It writes nothing (no receipt, no retry work, no attempt) and comes back in a new `deferred` list. No item ever asks for a key its transaction does not already hold.
- **The settler resubmits deferred sources before its cursor can pass them.** It sends exactly the deferred sources again, up to 3 more times, 250 ms apart. If one is still deferred, the page halts with the cursor where it was, as for any failed call. A deferred retry keeps its blocked work row untouched and is first in line next cycle.
- **The refresh stops before the first refused source.** It reads through the earliest `banked_at` of its union's bank receipts in the window whose source work is still `blocked`. It moves forward by itself once the retry accrues that source. The weekly close's strict check is unchanged.

Not added: no repair job, sweep, backfill or compensating write.

## Proof (isolated PostgreSQL 17, never production)

- `scripts/qualification/chip-deadlocks.py`, extended with an `after` stage (production's text today) and a `sorted` stage (this migration's own `$subs$` block):
  - On production's text, the batch and the retry both deadlock on the 10-19 interleaving. The club A item is refused with `deadlock detected`, exactly as in production.
  - With the migration there are no deadlocks, and every commission tier is written exactly once.
  - A key still busy after 1 s defers both items and writes nothing. Resubmitting after the finish commits accrues both.
  - A deferred retry leaves its work rows `blocked:1`, and the next retry accrues them.
  - A key freed inside the wait is taken in order.
  - Every pair the 10-01 migrations fixed stays fixed.
  - Evidence: `docs/evidence/commission-keys-2026-10-19/chip-deadlocks-run.json`.
- `scripts/qualification/refresh-horizon.py` runs the migration file whole over production's three bodies (md5-pinned):
  - On production's body, the refresh raises `union_cash_sources_do_not_match_bank:1`.
  - The new body reads through the refused source (+20 min), not through the cursor (+50 min).
  - It reads exactly as before for a union with nothing refused, and through the cursor again once the source is accrued.
  - Evidence: `docs/evidence/commission-keys-2026-10-19/refresh-horizon-run.json`.

## Deploy order

**The engine ships first, then the migration is installed.** Today's engine treats a batch receipt with fewer receipts than items as incomplete and holds its cursor. If the migration went first, every deferral would halt a settler page (nothing lost, but cash accrual would stall) until the new engine was live. The new engine accepts both the old receipt (no `deferred`) and the new one.
