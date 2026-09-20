/**
 * THE CASH ACCOUNTING BATCH IS DERIVED FROM THE CLIENT'S PATIENCE (2026-09-20)
 *
 * Deliberately import-free, for the same reason as engineStartBudget.ts and
 * tournamentResumeBudget.ts: the law is arithmetic, and its test must not have
 * to half-initialise a Supabase client - which logs FATAL without a service
 * role key - in order to check a multiplication.
 *
 * THE INCIDENT
 * RakebackSettlerService stopped on 2026-09-17 07:28:31 and did not move again
 * for three days. 264,835 cash rake_records carrying 485,712.99 of rake piled
 * up behind a cursor that never advanced; no cash agent commission was written
 * anywhere on the platform in that time.
 *
 * Nothing threw. Every cycle opened with
 *   supabase.rpc('fn_retry_cash_accounting_sources', { p_limit: 50 })
 * which took about 20.6 s. The engine's Supabase client gives up at
 * DB_TIMEOUT_MS (15,000 ms), so the client aborted, the catch wrote
 * 'source_retry_holds_cursor' and returned 'halted' - while the SERVER
 * transaction committed regardless. accounting_cash_source_receipts grew by
 * exactly 50 rows an hour for days, 5,294 receipts for 150 records: the work
 * was done and thrown away every single cycle.
 *
 * WHY THE NUMBERS WENT WRONG, WHICH IS THE PART WORTH REMEMBERING
 * Both literals were sized honestly and both were sized against something that
 * then changed underneath them - CLAUDE.md 1.1.7: "A NUMBER TUNED TO HARDWARE
 * AND WRITTEN DOWN AS A CONSTANT OUTLIVES THE HARDWARE."
 *
 *   * CREDIT_BATCH_SIZE = 150 was chosen after 500 hit the SERVER's ~8 s
 *     statement timeout. The functions then set their own 300 s server-side
 *     timeout, so the server stopped being the constraint entirely - and the
 *     constant was never re-derived against the one that still binds, the
 *     client's 15 s.
 *   * Then migration 20260917181100 repointed fn_credit_agent_commissions_batch
 *     at fn_process_cash_accounting_source, taking one item from cheap to
 *     ~290 ms. 150 x 290 ms = 43.5 s. The batch size did not change, because a
 *     literal cannot notice that its own cost moved.
 *
 * So the size is no longer written down. It is computed from the budget that
 * actually binds - how long the client will wait - and a per-item cost measured
 * against production, and it carries that measurement with it.
 *
 * ON THE MEASUREMENT ITSELF
 * PER_ITEM_MS is the cost AFTER idx_rake_attributions_rake_record_id exists.
 * Without that index the same item costs ~947 ms, because the cash path joins
 * rake_attributions on rake_record_id and the column was unindexed: four full
 * scans of 1.18M rows per item, 164.99 ms each. The index is the root fix for
 * the cost; this module is the root fix for the batch never noticing the cost.
 * They are separate defects and both were live.
 */

/** How much of the client's budget one server call may spend. */
export const BATCH_BUDGET_FRACTION = 0.6;

/**
 * Measured per item against production 2026-09-20, with
 * idx_rake_attributions_rake_record_id in place: ~290 ms to settle one cash
 * source through fn_process_cash_accounting_source end to end. Re-measure this
 * when the accrual path changes; that is the whole point of naming it.
 */
export const PER_ITEM_MS = 290;

/** Never ship a batch of nothing, whatever arithmetic says. */
export const MIN_BATCH = 1;

/**
 * Never exceed this however generous the budget: a page is 1,000 rows, and a
 * single call that could hold a lock or a snapshot across the whole page is a
 * different risk from a slow one.
 */
export const MAX_BATCH = 250;

/**
 * The largest batch that fits inside `clientTimeoutMs` at `perItemMs`.
 *
 * A non-finite or non-positive budget is NOT treated as generous - "I could not
 * tell" is its own outcome (CLAUDE.md 10.86 rule 1), and the safe reading of an
 * unreadable budget is the smallest batch, not the largest.
 */
export function cashAccountingBatchSize(
  clientTimeoutMs: number,
  perItemMs: number = PER_ITEM_MS
): number {
  if (!Number.isFinite(clientTimeoutMs) || clientTimeoutMs <= 0) return MIN_BATCH;
  if (!Number.isFinite(perItemMs) || perItemMs <= 0) return MIN_BATCH;
  const budgetMs = clientTimeoutMs * BATCH_BUDGET_FRACTION;
  const fits = Math.floor(budgetMs / perItemMs);
  return Math.max(MIN_BATCH, Math.min(MAX_BATCH, fits));
}
