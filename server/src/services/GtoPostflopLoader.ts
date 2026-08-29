/**
 * GTO POSTFLOP LOADER (V29, Dan 2026-08-29)
 *
 * Hydrates gto_postflop_compact (~5.5k rows, ~12MB) into the in-memory store
 * the flop consult reads synchronously. Paged at 500 rows so no single
 * response carries more than ~1.5MB of jsonb; refreshed every 6 hours so a
 * re-aggregation (new solves folding in) reaches the fleet without a deploy.
 *
 * Reads ONLY the compact table. The 79 GB warehouse is never touched at
 * runtime — that is the whole architecture (2026-08-15 incident).
 *
 * A failed load is loud but not fatal: gtoFlopAdvice returns null on an empty
 * store and yesterday's heuristics decide.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { setGtoPostflop, gtoPostflopCount, type GtoPostflopRow } from '../engine/GtoPostflop.js';

const REFRESH_MS = 6 * 60 * 60_000;
const BOOT_DELAY_MS = 25_000;
const PAGE = 500;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export async function loadGtoPostflop(): Promise<number> {
  try {
    let applied = 0;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('gto_postflop_compact')
        .select('street, game_family, position, depth_bucket, texture_class, facing, hand_matrix')
        .order('game_family', { ascending: true })
        .order('position', { ascending: true })
        .order('depth_bucket', { ascending: true })
        .order('texture_class', { ascending: true })
        .order('facing', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      applied += setGtoPostflop(data as GtoPostflopRow[]);
      if (data.length < PAGE) break;
    }
    console.log(
      `[GtoPostflopLoader] ${applied} solver flop cells loaded (${gtoPostflopCount()} in the store)`
    );
    return applied;
  } catch (err) {
    reportError(err, 'GtoPostflopLoader.load');
    console.warn(
      `[GtoPostflopLoader] flop cell load FAILED — the brain falls back to heuristics (${gtoPostflopCount()} cached)`
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
