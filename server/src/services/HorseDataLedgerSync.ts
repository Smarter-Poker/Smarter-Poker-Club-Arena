/**
 * HORSE DATA LEDGER SYNC (Phase 1, Dan 2026-09-04)
 *
 * The ledger lives in TypeScript (engine/HorseDataLedger.ts) because that is
 * where its tests can read the source it describes. The daily audit and the
 * horses panel live in Postgres. This service carries the ledger across at
 * boot: every row upserted, every row the ledger no longer has deleted, so
 * horse_data_ledger is always exactly the shipped contract and
 * fn_audit_data_receipts judges yesterday against the brain that is running.
 *
 * Fire-and-forget and fail-safe: a failed sync is reported, never fatal, and
 * the audit then raises data_stale on horse_data_ledger itself (its
 * updated_at goes stale), which is the loud failure this estate wants.
 */
import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { ledgerRows } from '../engine/HorseDataLedger.js';

let lastSync: { at: string; rows: number; deleted: number } | null = null;

/** What the last sync did (for the health endpoint and tests). */
export function horseDataLedgerSyncStatus(): typeof lastSync {
  return lastSync;
}

export async function syncHorseDataLedger(): Promise<{ rows: number; deleted: number }> {
  const rows = ledgerRows();
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({ ...r, updated_at: now }));
  // Upsert in pages: the ledger is a few hundred rows, one page today, but
  // the contract grows every phase.
  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await supabase
      .from('horse_data_ledger')
      .upsert(payload.slice(i, i + 200), { onConflict: 'key' });
    if (error) throw new Error(`horse_data_ledger upsert: ${error.message}`);
  }
  // Rows the shipped ledger no longer carries are not a contract any more.
  const keys = rows.map((r) => r.key);
  const { data: stale, error: readErr } = await supabase
    .from('horse_data_ledger')
    .select('key')
    .lt('updated_at', now);
  if (readErr) throw new Error(`horse_data_ledger read: ${readErr.message}`);
  const gone = (stale ?? [])
    .map((s) => (s as { key: string }).key)
    .filter((k) => !keys.includes(k));
  if (gone.length > 0) {
    const { error: delErr } = await supabase.from('horse_data_ledger').delete().in('key', gone);
    if (delErr) throw new Error(`horse_data_ledger delete: ${delErr.message}`);
  }
  lastSync = { at: now, rows: rows.length, deleted: gone.length };
  return { rows: rows.length, deleted: gone.length };
}

/** Boot entry: sync once now, then daily (the ledger only changes on deploy,
 *  and a deploy restarts the process, but a long-lived process should still
 *  refresh updated_at so the freshness check means "this brain is alive"). */
export function startHorseDataLedgerSync(): void {
  const run = (): void => {
    syncHorseDataLedger()
      .then((r) => console.log(`[HorseDataLedger] synced ${r.rows} rows (${r.deleted} retired)`))
      .catch((err) => reportError(err, 'HorseDataLedgerSync'));
  };
  run();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
