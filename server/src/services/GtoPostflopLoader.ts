/**
 * GTO POSTFLOP LOADER (V29 flop, V30 turn/river — Dan 2026-08-29)
 *
 * Hydrates gto_postflop_compact into the in-memory store the open-node
 * consult reads synchronously. Paged at 500 rows so no single response
 * carries more than ~1.5MB of jsonb; refreshed every 6 hours so the ongoing
 * V30 aggregation (GtoAggregationDriver folding turn/river in) reaches the
 * fleet without a deploy.
 *
 * Reads ONLY the compact table. The 79 GB warehouse is never touched at
 * runtime — that is the whole architecture (2026-08-15 incident).
 *
 * The load is COLLECT-THEN-SWAP: all pages are fetched first and the store
 * is replaced only on full success. That makes a DB-side purge (like the
 * 2026-08-29 facing-cell deletion) reach memory on the next refresh, while
 * a failed or partial load changes nothing — the brain keeps yesterday's
 * cells rather than half a table.
 *
 * A failed load is loud but not fatal: gtoStreetAdvice returns null on an
 * empty store and yesterday's heuristics decide.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import {
  setGtoPostflop,
  gtoPostflopCount,
  _clearGtoPostflop,
  type GtoPostflopRow,
} from '../engine/GtoPostflop.js';

const REFRESH_MS = 6 * 60 * 60_000;
const BOOT_DELAY_MS = 25_000;
const PAGE = 500;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export async function loadGtoPostflop(): Promise<number> {
  try {
    const rows: GtoPostflopRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('gto_postflop_compact')
        .select('street, game_family, position, depth_bucket, texture_class, facing, hand_matrix')
        // the full unique key, so paging stays stable while the V30 driver
        // inserts rows into the same table
        .order('street', { ascending: true })
        .order('game_family', { ascending: true })
        .order('position', { ascending: true })
        .order('depth_bucket', { ascending: true })
        .order('texture_class', { ascending: true })
        .order('facing', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as GtoPostflopRow[]));
      if (data.length < PAGE) break;
    }
    // full success only: swap, so DB-side deletions evict from memory too
    _clearGtoPostflop();
    const applied = setGtoPostflop(rows);
    console.log(
      `[GtoPostflopLoader] ${applied} solver open-node cells loaded (${gtoPostflopCount()} in the store)`
    );
    return applied;
  } catch (err) {
    reportError(err, 'GtoPostflopLoader.load');
    console.warn(
      `[GtoPostflopLoader] solver cell load FAILED - the brain falls back to heuristics (${gtoPostflopCount()} cached)`
    );
    return 0;
  }
}

export function startGtoPostflopLoader(): void {
  if (timer) return;
  bootTimer = setTimeout(() => void loadGtoPostflop(), BOOT_DELAY_MS);
  bootTimer.unref?.();
  timer = setInterval(() => void loadGtoPostflop(), REFRESH_MS);
  timer.unref?.();
}

export function stopGtoPostflopLoader(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}
