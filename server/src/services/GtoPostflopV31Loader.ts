/**
 * GTO POSTFLOP V31 LOADER (2026-08-30)
 *
 * Hydrates the active certified V31 dataset into the in-memory policy store.
 * The RPC exposes only a dataset that passed provenance, held-out, replay and
 * league promotion gates. The legacy `gto_postflop_v31` table is intentionally
 * not read: it has no source seal and cannot distinguish response nodes.
 *
 * Paged at 500 rows so no single response carries an unbounded amount of
 * jsonb, and refreshed every 6 hours so the ongoing V31 aggregation reaches
 * the fleet without a deploy. The live worker explicitly awaits the initial
 * load; this module's timer owns periodic refresh only. That refresh matters
 * far more here than it does for V30: this table is built from empty over days,
 * so nearly every refresh is delivering cells that did not exist before.
 *
 * COLLECT-THEN-SWAP, deliberately: every page is fetched and every row is
 * revalidated before the store is touched. A failed or partial load leaves
 * the last known-good snapshot in place.
 *
 * The 80 GB warehouse is never touched at runtime.
 *
 * A failed load is loud but not fatal: the lookup reports an empty store, the
 * consult falls back to V30 and then to the heuristics.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import {
  replaceGtoPostflopV31,
  replaceGtoPostflopV31Evaluation,
  gtoPostflopV31Count,
  gtoPostflopV31EvaluationCount,
  type GtoPostflopV31Row,
} from '../engine/GtoPostflopV31.js';

const REFRESH_MS = 6 * 60 * 60_000;
const PAGE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let timer: NodeJS.Timeout | null = null;

export async function loadGtoPostflopV31(): Promise<number> {
  try {
    const rows: GtoPostflopV31Row[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase.rpc('fn_gto_v31_active_cells', {
        p_offset: offset,
        p_limit: PAGE,
      });
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as GtoPostflopV31Row[]));
      if (data.length < PAGE) break;
    }
    // Full success only. The validator performs the atomic swap.
    const applied = replaceGtoPostflopV31(rows);
    console.log(
      `[GtoPostflopV31Loader] ${applied} certified solver cells loaded (${gtoPostflopV31Count()} in the store)`
    );
    return applied;
  } catch (err) {
    reportError(err, 'GtoPostflopV31Loader.load');
    console.warn(
      `[GtoPostflopV31Loader] certified V31 load FAILED - the brain keeps the last sealed snapshot or falls back (${gtoPostflopV31Count()} cached)`
    );
    return 0;
  }
}

/**
 * Hydrate one sealed, not-yet-active dataset for an offline evaluation run.
 * This never mutates the live store and therefore cannot activate a candidate.
 */
export async function loadGtoPostflopV31Evaluation(datasetId: string): Promise<{
  checksum: string;
  cells: number;
}> {
  if (!UUID.test(datasetId)) {
    throw new Error('invalid V31 evaluation dataset id');
  }
  const rows: GtoPostflopV31Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.rpc('fn_gto_v31_evaluation_cells', {
      p_dataset_id: datasetId,
      p_offset: offset,
      p_limit: PAGE,
    });
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as GtoPostflopV31Row[]));
    if (data.length < PAGE) break;
  }
  if (rows.length === 0) throw new Error('V31 evaluation dataset returned no cells');
  const checksum = rows[0].dataset_checksum;
  if (!checksum || rows.some((row) => row.dataset_checksum !== checksum)) {
    throw new Error('V31 evaluation dataset checksum is missing or inconsistent');
  }
  replaceGtoPostflopV31Evaluation(rows);
  const cells = gtoPostflopV31EvaluationCount(checksum);
  console.log(
    `[GtoPostflopV31Loader] ${cells} sealed candidate cells loaded for ${checksum.slice(0, 12)}`
  );
  return { checksum, cells };
}

export function startGtoPostflopV31Loader(): void {
  if (timer) return;
  timer = setInterval(() => void loadGtoPostflopV31(), REFRESH_MS);
  timer.unref?.();
}

export function stopGtoPostflopV31Loader(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
