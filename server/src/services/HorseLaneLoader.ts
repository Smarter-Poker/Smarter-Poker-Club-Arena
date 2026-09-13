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
/**
 * UNTIL THE FIRST LOAD LANDS, A FAILURE IS RETRIED IN A MINUTE, NOT IN
 * THIRTY (2026-09-09). `stakeBandAllows` refuses every seat while no band is
 * loaded (HorseBehavior) - a fleet that has not read its bands would seat
 * 10/25 names at 0.05/0.10 - so the fleet is only as unmanaged as this
 * retry is slow.
 */
const FIRST_LOAD_RETRY_MS = 60_000;
/** Re-assign when this many horses are missing a stored lane. */
const REASSIGN_THRESHOLD = 25;

let timer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightLoads = new Set<Promise<void>>();

const lifecycleIsCurrent = (generation?: number): boolean =>
  generation === undefined || (lifecycleActive && lifecycleGeneration === generation);

export async function loadHorseLanes(generation?: number): Promise<number> {
  if (!lifecycleIsCurrent(generation)) return 0;
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
      if (!lifecycleIsCurrent(generation)) return 0;
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
      if (!lifecycleIsCurrent(generation)) return 0;
      if (bandErr) {
        reportError(new Error(bandErr.message), 'HorseLaneLoader.reassign_stake_bands');
      } else {
        console.log(
          `[HorseLaneLoader] ${missingBand} horses had no stake band - re-ran the exact assignment`
        );
        return loadHorseLanes(generation);
      }
    }

    // Enough horses without a lane means the fleet grew: re-balance so the
    // split stays exact instead of drifting toward the fallback hash's skew.
    if (missing >= REASSIGN_THRESHOLD) {
      const { error: assignErr } = await supabase.rpc('fn_assign_horse_lanes');
      if (!lifecycleIsCurrent(generation)) return 0;
      if (assignErr) {
        reportError(new Error(assignErr.message), 'HorseLaneLoader.reassign');
      } else {
        console.log(
          `[HorseLaneLoader] ${missing} horses had no lane - re-ran the exact assignment`
        );
        return loadHorseLanes(generation);
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
    // Nothing loaded yet: the band gate is refusing every seat it decides
    // (HorseBehavior.stakeBandAllows), so ask again soon, not in half an hour.
    if (assignedStakeBandCount() === 0 && lifecycleIsCurrent(generation) && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        launchLoad();
      }, FIRST_LOAD_RETRY_MS);
      retryTimer.unref?.();
    }
    return 0;
  }
}

function launchLoad(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightLoads.size > 0) return;
  let tracked!: Promise<void>;
  tracked = loadHorseLanes(generation)
    .then(() => undefined)
    .finally(() => inFlightLoads.delete(tracked));
  inFlightLoads.add(tracked);
}

async function drainLoads(): Promise<void> {
  while (inFlightLoads.size > 0) await Promise.allSettled([...inFlightLoads]);
}

/**
 * THE FIRST LOAD IS IMMEDIATE (2026-09-09). This waited twenty seconds
 * after boot, and HorseFleetManager.start() launches its initial seeding
 * cycle at once - so on every restart outside the maintenance break the
 * fleet's first pass, the one that refills a whole floor, ran with no band
 * loaded. `stakeBandFor` answers 'micro' for a horse with no record, which
 * for one cycle was every horse: the pass could seat the entire fleet at the
 * 0.05/0.10 tables and nowhere else. The band gate now refuses while nothing
 * is loaded, and this starts loading the moment it is asked to.
 */
export function startHorseLaneLoader(): void {
  if (timer || lifecycleActive) return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  launchLoad();
  timer = setInterval(launchLoad, REFRESH_MS);
  timer.unref?.();
}

export function stopHorseLaneLoader(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  stopOperation = drainLoads();
  return stopOperation;
}
