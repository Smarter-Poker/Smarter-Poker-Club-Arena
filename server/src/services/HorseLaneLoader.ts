/**
 * HORSE LANE LOADER (Dan 2026-08-27)
 *
 * Lanes are ASSIGNED and stored (fn_assign_horse_lanes) rather than hashed,
 * because a hash cannot produce an exact 33/33/34 split at fleet size - the
 * hash that shipped earlier measured 32.0/39.0/28.9 over the real 584 horses.
 * This hydrates the assignment into HorseBehavior at boot and refreshes it
 * periodically so newly-created horses pick up a real lane instead of living
 * on the fallback forever.
 *
 * It also RE-RUNS the assignment when the fleet has grown enough to shift the
 * split: new horses land on the hash fallback until then, so a fleet that
 * doubles would drift back toward the hash's skew if nothing re-balanced it.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import {
  setHorseLanes,
  assignedLaneCount,
  setHorseStakeBands,
  assignedStakeBandCount,
} from './HorseBehavior.js';

const REFRESH_MS = 30 * 60_000;
const BOOT_DELAY_MS = 20_000;
/** Re-assign when this many horses are missing a stored lane. */
const REASSIGN_THRESHOLD = 25;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export async function loadHorseLanes(): Promise<number> {
  try {
    const rows: Array<{ id: string; lane: string | null }> = [];
    // Stake bands ride along on the SAME page scan. They are stored in the same
    // jsonb column and needed at the same moment, so a second loader would be a
    // second full pass over every horse for no reason.
    const bandRows: Array<{ id: string; stakeBand: string | null }> = [];
    let missing = 0;
    let missingBand = 0;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, horse_profile')
        .eq('is_horse', true)
        .order('id', { ascending: true })
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const row of data as Array<{ id: string; horse_profile: unknown }>) {
        const hp = row.horse_profile;
        const obj = hp && typeof hp === 'object' ? (hp as Record<string, unknown>) : null;
        const lane = obj ? (obj.lane as string) : null;
        const stakeBand = obj ? (obj.stakeBand as string) : null;
        if (!lane) missing++;
        if (!stakeBand) missingBand++;
        rows.push({ id: row.id, lane: lane ?? null });
        bandRows.push({ id: row.id, stakeBand: stakeBand ?? null });
      }
      if (data.length < 1000) break;
    }

    // Same argument as lanes, with more at stake: a band that comes out short
    // is a stake level with too few horses to fill its tables, so the exact
    // assignment is re-run rather than left drifting toward the hash's skew.
    if (missingBand >= REASSIGN_THRESHOLD) {
      const { error: bandErr } = await supabase.rpc('fn_assign_horse_stake_bands');
      if (bandErr) {
        reportError(new Error(bandErr.message), 'HorseLaneLoader.reassign_stake_bands');
      } else {
        console.log(
          `[HorseLaneLoader] ${missingBand} horses had no stake band - re-ran the exact assignment`
        );
        return loadHorseLanes();
      }
    }

    // Enough horses without a lane means the fleet grew: re-balance so the
    // split stays exact instead of drifting toward the fallback hash's skew.
    if (missing >= REASSIGN_THRESHOLD) {
      const { error: assignErr } = await supabase.rpc('fn_assign_horse_lanes');
      if (assignErr) {
        reportError(new Error(assignErr.message), 'HorseLaneLoader.reassign');
      } else {
        console.log(
          `[HorseLaneLoader] ${missing} horses had no lane - re-ran the exact assignment`
        );
        return loadHorseLanes();
      }
    }

    const applied = setHorseLanes(rows);
    const bandsApplied = setHorseStakeBands(bandRows);
    console.log(
      `[HorseLaneLoader] ${applied} assigned lanes loaded (${missing} on the hash fallback), ` +
        `${bandsApplied} assigned stake bands (${missingBand} on the hash fallback)`
    );
    return applied;
  } catch (err) {
    // A failed load leaves gameLaneFor on its hash fallback: the split skews
    // but the fleet keeps playing. Say so rather than failing silently.
    reportError(err, 'HorseLaneLoader.load');
    console.warn(
      `[HorseLaneLoader] lane/band load FAILED - running on the hash fallback (${assignedLaneCount()} lanes, ${assignedStakeBandCount()} bands cached)`
    );
    return 0;
  }
}

export function startHorseLaneLoader(): void {
  if (timer) return;
  bootTimer = setTimeout(() => void loadHorseLanes(), BOOT_DELAY_MS);
  bootTimer.unref?.();
  timer = setInterval(() => void loadHorseLanes(), REFRESH_MS);
  timer.unref?.();
}

export function stopHorseLaneLoader(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}
