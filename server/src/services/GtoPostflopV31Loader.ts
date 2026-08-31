/**
 * GTO POSTFLOP V31 LOADER (2026-08-30)
 *
 * Hydrates `gto_postflop_v31` into the in-memory store the open-node consult
 * reads synchronously — the sibling of GtoPostflopLoader, which does the same
 * for `gto_postflop_compact`. Both are needed because the two source exports
 * are disjoint; neither table can answer for the other.
 *
 * Paged at 500 rows so no single response carries an unbounded amount of
 * jsonb, and refreshed every 6 hours so the ongoing V31 aggregation reaches
 * the fleet without a deploy. That refresh matters far more here than it does
 * for V30: this table is built from empty over days, so nearly every refresh
 * is delivering cells that did not exist before.
 *
 * COLLECT-THEN-SWAP, deliberately: every page is fetched before the store is
 * touched, and a failed or partial load changes nothing. The brain keeps the
 * cells it already had rather than half a table. It also means a DB-side
 * purge reaches memory on the next refresh instead of lingering forever.
 *
 * Reads ONLY the compact V31 table. The 79 GB warehouse is never touched at
 * runtime — that is the whole architecture, and the reason the 2026-08-15
 * liveness incident stayed a one-off.
 *
 * A failed load is loud but not fatal: the lookup reports an empty store, the
 * consult falls back to V30 and then to the heuristics.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import {
  setGtoPostflopV31,
  gtoPostflopV31Count,
  _clearGtoPostflopV31,
  type GtoPostflopV31Row,
} from '../engine/GtoPostflopV31.js';

const REFRESH_MS = 6 * 60 * 60_000;
/** After the V30 loader (25s), so the two do not page the DB together. */
const BOOT_DELAY_MS = 35_000;
const PAGE = 500;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export async function loadGtoPostflopV31(): Promise<number> {
  try {
    const rows: GtoPostflopV31Row[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('gto_postflop_v31')
        .select('street, game_family, position, depth_bucket, texture_class, hand_matrix, size_pct')
        // the full primary key, so paging stays stable while the V31 driver
        // inserts rows into the same table underneath us
        .order('street', { ascending: true })
        .order('game_family', { ascending: true })
        .order('position', { ascending: true })
        .order('depth_bucket', { ascending: true })
        .order('texture_class', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as GtoPostflopV31Row[]));
      if (data.length < PAGE) break;
    }
    // full success only: swap, so DB-side deletions evict from memory too
    _clearGtoPostflopV31();
    const applied = setGtoPostflopV31(rows);
    console.log(
      `[GtoPostflopV31Loader] ${applied} suit-aware solver cells loaded (${gtoPostflopV31Count()} in the store)`
    );
    return applied;
  } catch (err) {
    reportError(err, 'GtoPostflopV31Loader.load');
    console.warn(
      `[GtoPostflopV31Loader] V31 cell load FAILED - the brain falls back to V30 and the heuristics (${gtoPostflopV31Count()} cached)`
    );
    return 0;
  }
}

export function startGtoPostflopV31Loader(): void {
  if (timer) return;
  bootTimer = setTimeout(() => void loadGtoPostflopV31(), BOOT_DELAY_MS);
  bootTimer.unref?.();
  timer = setInterval(() => void loadGtoPostflopV31(), REFRESH_MS);
  timer.unref?.();
}

export function stopGtoPostflopV31Loader(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}
