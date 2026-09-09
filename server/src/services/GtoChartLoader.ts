/**
 * GTO CHART LOADER (Dan 2026-08-29)
 *
 * Hydrates the PioSolver push/fold charts (memory_charts_gold, 240 rows,
 * ~330KB) into the in-memory store the horse brain reads synchronously.
 * The live worker explicitly awaits the authoritative initial load before it
 * publishes READY. This module's start/stop pair owns the slow periodic
 * refresh plus bounded recovery after a failed load; requests never overlap.
 *
 * The refresh is HOURLY and the table is 240 rows — this loader must never
 * become the 2026-08-15 incident (a dashboard count on the 79GB solver
 * warehouse starving the platform). It reads the small charts table only;
 * solved_spots_gold is Stage 2 and will arrive as a pre-aggregated compact
 * table, never a live read.
 *
 * A failed load is loud but not fatal: the brain's chart lookups return null
 * and the heuristics that ran yesterday keep deciding while bounded retries
 * recover the store. The solver upgrades the brain; its absence must never
 * lobotomize it.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { setGtoCharts, gtoChartCount, type GtoChartRow } from '../engine/GtoCharts.js';
import {
  recordChartPolicyRefreshError,
  solverPolicyArtifactStatus,
} from '../gto/SolverPolicyArtifactLoader.js';
import { assertCompleteGtoChartCorpus } from '../gto/GtoChartCorpus.js';
import { createAdaptiveRefreshLoop } from './AdaptiveRefreshLoop.js';

const REFRESH_MS = 60 * 60_000;
const RETRY_MS = 30_000;
const MAX_RETRY_MS = 5 * 60_000;

async function loadGtoChartsAttempt(): Promise<{ ok: boolean; count: number }> {
  try {
    const { data, error } = await supabase
      .from('memory_charts_gold')
      .select(
        'chart_id, game_type, stack_depth, hero_position, villain_action, hand_matrix, created_at'
      );
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as GtoChartRow[];
    assertCompleteGtoChartCorpus(rows);
    const applied = setGtoCharts(rows);
    console.log(
      `[GtoChartLoader] ${applied} solver charts loaded (${gtoChartCount()} rows, ` +
        `${solverPolicyArtifactStatus().charts.count} canonical policies)`
    );
    return { ok: true, count: applied };
  } catch (err) {
    recordChartPolicyRefreshError(err);
    reportError(err, 'GtoChartLoader.load');
    console.warn(
      `[GtoChartLoader] chart load FAILED - the brain falls back to heuristics (${gtoChartCount()} cached)`
    );
    return { ok: false, count: 0 };
  }
}

const refreshLoop = createAdaptiveRefreshLoop({
  load: loadGtoChartsAttempt,
  refreshMs: REFRESH_MS,
  retryMs: RETRY_MS,
  maxRetryMs: MAX_RETRY_MS,
});

export async function loadGtoCharts(): Promise<number> {
  return (await refreshLoop.runNow()).count;
}

export function startGtoChartLoader(): void {
  refreshLoop.start();
}

export function stopGtoChartLoader(): void {
  refreshLoop.stop();
}
