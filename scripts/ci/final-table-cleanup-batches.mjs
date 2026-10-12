// Explicit finite data-migration pages within the existing manual installer.
// No retry, DDL, release action, schedule or discovered work.
import { createHash } from 'node:crypto';
export const BATCH_MIGRATION =
  '20261005230204_the_final_table_cleanup_advances_in_bounded_transactions.sql';
export function batchRequest(file, count, operation, recovery) {
  if (count === null && operation === null) return null;
  if (
    file !== BATCH_MIGRATION ||
    recovery ||
    !/^[1-9][0-9]{0,3}$/.test(count ?? '') ||
    Number(count) > 3000 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation ?? '')
  ) {
    throw new Error(
      'bounded cleanup requires its exact migration, 1..3000 pages, operation UUID and no index recovery'
    );
  }
  return { count: Number(count), operation };
}
export function pageIdentity(operation, page) {
  const h = createHash('sha256').update(`${operation}:${page}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function applyFinalTablePages(client, request, sql, dryRun, log = console.log) {
  // Autocommit only. Settings are session scoped so the top-level call actually
  // has a deadline; SET LOCAL inside a function cannot start that deadline.
  await client.query(
    "SET statement_timeout='5s'; SET transaction_timeout='6s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='5s'"
  );
  const installed = await client.query(
    'SELECT statements = ARRAY[$2::text] AS exact FROM supabase_migrations.schema_migrations WHERE version=$1',
    [BATCH_MIGRATION.slice(0, 14), sql]
  );
  if (installed.rows.length !== 1 || installed.rows[0].exact !== true)
    throw new Error('exact bounded-helper installation is not recorded; nothing sent');
  if (dryRun) {
    log('[apply] DRY RUN: exact bounded-helper installation recorded; no pages sent');
    return;
  }
  const deadline = Date.now() + 240000;
  for (let page = 0; page < request.count; page++) {
    if (Date.now() >= deadline) {
      log(
        '[apply] PARTIAL: finite 240s budget reached; retain receipts and inspect before another explicit operation'
      );
      return;
    }
    const id = pageIdentity(request.operation, page);
    log(`[apply] bounded operation=${request.operation} page=${page} request=${id} sending once`);
    // Each SELECT is its own transaction. No BEGIN spans calls, no automatic retry.
    const sent = await client.query(
      'SELECT public.fn_advance_final_table_cleanup($1::uuid) AS result',
      [id]
    );
    const durable = await client.query(
      'SELECT result FROM public.final_table_cleanup_receipts WHERE request_id=$1::uuid',
      [id]
    );
    if (
      durable.rows.length !== 1 ||
      JSON.stringify(durable.rows[0].result) !== JSON.stringify(sent.rows[0]?.result)
    )
      throw new Error(
        `request ${id}: durable result unreadable or different; do not retry blindly`
      );
    log(`[apply] COMMITTED request=${id} ${JSON.stringify(durable.rows[0].result)}`);
    if (durable.rows[0].result.complete === true) {
      log('[apply] NORMALIZATION COMPLETE: forward finalizer remains separate and guarded');
      return;
    }
  }
  log('[apply] PARTIAL: explicit page count exhausted; forward finalizer not sent');
}
