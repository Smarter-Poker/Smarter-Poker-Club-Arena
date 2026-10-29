import type { HorseHistoryLoadReporter } from '../engine/horseDecision/ownPublicHistoryProvenance.js';
import {
  attachRiverNodeSidecar,
  riverNodeBindings,
} from '../engine/horseDecision/riverNodeSidecar.js';
import { supabase } from './supabase/client.js';
import {
  horseObserverReadContextIsValid,
  horseObserverReadContextKey,
  type HorseObserverReadContext,
} from '../engine/HorseObserverReadContext.js';
import { noteFire } from '../engine/BrainTelemetry.js';
import { makeOwnPublicHistoryPacket } from '../engine/horseDecision/ownPublicHistory.js';
import { shownRiverCallSamples } from '../engine/HorseRiverCallEvidence.js';
import { reportThrottled } from './errorReporter.js';

// Native PG17 qualification checks this against the exact installed function.
export const HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5 = '3a2ea02c1c36661b37ef51d328c92fce';
/**
 * How long the engine waits for one horse's history before giving up on it.
 *
 * Measured live 2026-10-26 01:06-01:55 UTC, the first hour after this reader
 * shipped: 6,692 calls reached the database and every one answered 200, the
 * slowest in 1,330 ms (p50 46 ms, p99 613 ms). Over the same hour the engine
 * gave up on roughly a quarter of them at the old 1,500 ms deadline, and a
 * context that gives up is not asked again for the life of the process, so
 * that horse played that game type without its own history. The time was
 * lost between the engine and the database, not inside the query.
 *
 * Nothing waits on this read: the turn never blocks on it, and a load only
 * holds one of the cache's 16 slots. So the deadline is sized like the
 * engine's other non-blocking calls (SEEDING_DB_TIMEOUT_MS, 5 s), not like a
 * hand-path call. The three failure fires below say which way a load failed.
 */
export const HORSE_OWN_PUBLIC_HISTORY_TIMEOUT_MS = 5_000;
/** A read of already accepted public hands only. Caller stamps availability
 * after resolution; this SQL cutoff alone never proves earlier visibility. */
export async function readHorseOwnPublicHistory(
  context: HorseObserverReadContext,
  report?: HorseHistoryLoadReporter
): Promise<unknown> {
  if (!horseObserverReadContextIsValid(context)) return null;
  // A diagnostic callback cannot change the read result or introduce an error.
  const failed: HorseHistoryLoadReporter = (reason) => {
    try {
      report?.(reason);
    } catch {
      /* diagnostic only */
    }
  };
  let deadline: AbortSignal | undefined;
  try {
    deadline = AbortSignal.timeout(HORSE_OWN_PUBLIC_HISTORY_TIMEOUT_MS);
    const before = new Date().toISOString();
    const { data, error } = await supabase
      .rpc('fn_horse_own_public_history_read_v3', {
        p_observer: context.observerId,
        p_variant: context.variant,
        p_format: context.format,
        p_dealt_count: context.dealtCount,
        p_before: before,
      })
      .abortSignal(deadline);
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      noteFire('horse_observer_history_unavailable');
      noteFire(error ? 'horse_observer_history_error' : 'horse_observer_history_empty_response');
      failed(
        deadline.aborted
          ? 'provider_deadline'
          : error
            ? 'provider_error'
            : 'provider_empty_response'
      );
      return null;
    }
    if (
      Object.keys(data).length !== 2 ||
      data.definitionMd5 !== HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5 ||
      !data.window ||
      horseObserverReadContextKey(data.window.context) !== horseObserverReadContextKey(context)
    ) {
      noteFire('horse_observer_history_source_mismatch');
      failed('provider_source_mismatch');
      return null;
    }
    // Validate original dealt participation and the bounded closed schema
    // BEFORE selecting public categories by those exact hand IDs. The SQL
    // reader stays unchanged; older engines never receive additional fields.
    const packet = makeOwnPublicHistoryPacket(data.window, Date.now());
    if (!packet) {
      failed('provider_invalid_window');
      return null;
    }
    if (!packet.hands.length) return data.window;
    const window = structuredClone(data.window);
    try {
      const { data: rows, error: categoryError } = await supabase
        .from('hand_history')
        .select('id,game_variant,showdown,community_cards2,community_cards3,rit_boards')
        .in(
          'id',
          packet.hands.map((h) => h.handId)
        )
        .limit(64)
        .abortSignal(deadline);
      if (categoryError || !Array.isArray(rows)) throw Error('public categories unavailable');
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const hand of window.hands) {
        const row = byId.get(hand.handId);
        if (
          !row ||
          row.game_variant !== hand.variant ||
          (row.community_cards2 !== null && !Array.isArray(row.community_cards2)) ||
          (row.community_cards3 !== null && !Array.isArray(row.community_cards3)) ||
          (row.rit_boards !== null && !Array.isArray(row.rit_boards))
        )
          continue;
        hand.riverCalls = shownRiverCallSamples(hand.actions, row.showdown, {
          variant: hand.variant,
          boardCount: Math.max(
            row.rit_boards?.length ?? 0,
            row.community_cards3?.length ? 3 : row.community_cards2?.length ? 2 : 1
          ),
        });
      }
    } catch {
      // Preserve known public actions/results; absent categories remain
      // explicitly unknown. No retry, guessed category or pooled fallback.
      reportThrottled(
        'HorseOwnPublicHistory.river_calls',
        'Public river-call evidence unavailable'
      );
    }
    if (
      context.format === 'cash' &&
      context.dealtCount >= 3 &&
      ['nlh', 'plo4', 'plo5', 'plo6'].includes(context.variant)
    ) {
      try {
        const { data: sidecar, error: nodeError } = await supabase
          .rpc('fn_horse_multiway_river_nodes_v1', {
            p_observer: context.observerId,
            p_variant: context.variant,
            p_dealt_count: context.dealtCount,
            p_before: before,
            p_hands: riverNodeBindings(packet),
          })
          .abortSignal(deadline);
        const enriched = nodeError ? null : attachRiverNodeSidecar(window, sidecar, Date.now());
        if (enriched?.status === 'captured') return enriched.window;
        noteFire('horse_river_nodes_unavailable');
      } catch {
        noteFire('horse_river_nodes_unavailable');
      }
    }
    return window;
  } catch {
    noteFire('horse_observer_history_unavailable');
    noteFire('horse_observer_history_thrown');
    failed(deadline?.aborted ? 'provider_deadline' : 'provider_thrown');
    return null;
  }
}
