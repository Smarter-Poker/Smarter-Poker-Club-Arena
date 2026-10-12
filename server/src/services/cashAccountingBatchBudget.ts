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

/**
 * The engine's Supabase client budget, in one place.
 *
 * It lives HERE rather than in supabase/client.ts because callers that need to
 * size work against it must not have to import the database client to do
 * arithmetic - four test suites mock that module, and a constant imported
 * through a mock is a constant that disappears. client.ts reads this same
 * function, so there is still exactly one definition and one env var.
 */
export const DEFAULT_CLIENT_TIMEOUT_MS = 15_000;

export function resolveClientTimeoutMs(
  env: { SUPABASE_TIMEOUT_MS?: string } = process.env
): number {
  const raw = Number(env.SUPABASE_TIMEOUT_MS ?? DEFAULT_CLIENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLIENT_TIMEOUT_MS;
}

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
 * A CASH BATCH HANDS THE CLUB'S COMMISSION KEY BACK BEFORE A FINISH NOTICES
 * (2026-10-02).
 *
 * fn_credit_agent_commissions_batch is one transaction. It takes the
 * 'agent-commission:<club>' key of every club its items earn in and keeps
 * each key, and every row it touched, until the whole batch commits. A
 * tournament finish takes the same key for the host club's commission, and it
 * does so while it already holds its bank scope's finish lane
 * (fn_ca_lock_settlement_lane_for_finish: one finish at a time per union or
 * club bank). So every Spin and Sit & Go of that union waited for the cash
 * batch, one finish after another.
 *
 * Read on production 19:25-19:35 UTC on 2026-10-02 (engine ac2024b8): in 5 of
 * 6 lock snapshots the finish holding a union's lane was waiting on a club
 * commission key held by fn_credit_agent_commissions_batch (mean 5.3 s
 * per call, 31 items, sized only against the client's 15 s). Each of the two
 * busy unions finished one event every 8-10 s against about 5 decided a
 * minute, so the lane ran near full, the hourly maintenance freeze left a
 * backlog it could not drain, and fn_ca_tournament_finished_but_not_completed
 * raised a critical for every winner left unpaid past 15 minutes (7,113 in two
 * days). docs/evidence/chip-deadlocks-2026-10-01.md had already measured 1,170
 * finish waits over 1 s at the commission step and named the cure: a shorter
 * cash batch transaction.
 *
 * So the client's patience is not the only budget a batch must fit. It must
 * also fit how long a finish may wait behind it for a commission key. A batch
 * of COMMISSION_KEY_HOLD_MS / PER_ITEM_MS items is 5 at 290 ms, and at 4,800
 * cash raked hands an hour (1.3 a second) the settler still clears more than
 * three items a second.
 */
export const COMMISSION_KEY_HOLD_MS = 1_500;

/**
 * The largest batch that fits inside `clientTimeoutMs` at `perItemMs`, and
 * whose commission keys are held no longer than `keyHoldMs`.
 *
 * A non-finite or non-positive budget is NOT treated as generous - "I could not
 * tell" is its own outcome (CLAUDE.md 10.86 rule 1), and the safe reading of an
 * unreadable budget is the smallest batch, not the largest.
 */
export function cashAccountingBatchSize(
  clientTimeoutMs: number,
  perItemMs: number = PER_ITEM_MS,
  keyHoldMs: number = COMMISSION_KEY_HOLD_MS
): number {
  if (!Number.isFinite(clientTimeoutMs) || clientTimeoutMs <= 0) return MIN_BATCH;
  if (!Number.isFinite(perItemMs) || perItemMs <= 0) return MIN_BATCH;
  if (!Number.isFinite(keyHoldMs) || keyHoldMs <= 0) return MIN_BATCH;
  // The tighter of the two budgets binds: the client's patience, or how long
  // a tournament finish may wait behind this transaction for a commission key.
  const budgetMs = Math.min(clientTimeoutMs * BATCH_BUDGET_FRACTION, keyHoldMs);
  const fits = Math.floor(budgetMs / perItemMs);
  return Math.max(MIN_BATCH, Math.min(MAX_BATCH, fits));
}
