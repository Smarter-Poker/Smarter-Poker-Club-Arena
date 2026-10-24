/**
 * LIGHTNING PHASE 6: the one read behind a Lightning Cluster's lobby card.
 *
 * fn_cash_game_lobby embeds fn_cash_cluster_lightning_state as `lightning`
 * (20260920234647). The board asks it only for Clusters whose mode is already
 * Lightning, so a board with none (every board today) never asks at all.
 */
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { parseLightningLobbyState, type LightningLobbyState } from './lightningLobby';
import { fetchLightningPoolHealth } from './lightningSessionApi';

export async function fetchLightningLobbyState(
  clusterId: string
): Promise<LightningLobbyState | null> {
  const [lobby, health] = await Promise.all([
    supabase.rpc('fn_cash_game_lobby', { p_game_id: clusterId }),
    /* LIGHTNING PHASE 8: the pool's health in the database's own words. A
       database without the function yet (or a failed read) leaves the card
       on the status derived from the lobby state, as before. */
    fetchLightningPoolHealth(clusterId).catch(() => null),
  ]);
  if (lobby.error) throw lobby.error;
  const state = parseLightningLobbyState(
    (lobby.data as { lightning?: unknown } | null)?.lightning ?? null
  );
  if (!state || !health) return state;
  return {
    ...state,
    poolStatus: health.status,
    poolPlayers: health.players,
    /* LIGHTNING PHASE 13: the pool door's own joins flag wins over the lobby's. */
    ...(health.joinsEnabled !== undefined ? { joinsEnabled: health.joinsEnabled } : {}),
  };
}

/** How often a visible board re-reads a Lightning Cluster's pool (a modest 30 s). */
export const LIGHTNING_LOBBY_REFRESH_MS = 30_000;

/**
 * The Lightning state of each listed Cluster, keyed by Cluster id. An empty
 * list reads nothing and returns an empty map.
 *
 * `settleClassic`: a Cluster whose first clean answer is "no Lightning state"
 * is a Classic game, and is never asked again while this list stands. The
 * table page sets it, because it asks about the one table it is showing
 * before it knows which kind of game that is (Dan 2026-10-24: "NO PART OF THE
 * LIGHTNING GAMES OR FUNCTIONALITY SHOULD BE TOUCHING THE CLASSIC GAMES").
 * A failed read is not an answer, so it is asked again on the next tick.
 */
export function useLightningLobbyStates(
  clusterIds: readonly string[],
  options: { settleClassic?: boolean } = {}
): Record<string, LightningLobbyState | null> {
  const key = useMemo(() => [...new Set(clusterIds)].sort().join(','), [clusterIds]);
  const settleClassic = options.settleClassic === true;
  const [states, setStates] = useState<Record<string, LightningLobbyState | null>>({});
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) {
      setStates((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let live = true;
    const classic = new Set<string>();
    let timer: ReturnType<typeof setInterval> | null = null;
    const readAll = async () => {
      const pairs = await Promise.all(
        ids.map(async (id) => {
          if (classic.has(id)) return [id, null] as const;
          try {
            const state = await fetchLightningLobbyState(id);
            if (settleClassic && state === null) classic.add(id);
            return [id, state] as const;
          } catch (err) {
            reportError(err, 'lightningLobbyFeed.read_failed', { clusterId: id });
            return [id, null] as const;
          }
        })
      );
      if (!live) return;
      setStates(Object.fromEntries(pairs));
      if (settleClassic && timer !== null && ids.every((id) => classic.has(id))) {
        clearInterval(timer);
        timer = null;
      }
    };
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void readAll();
    }, LIGHTNING_LOBBY_REFRESH_MS);
    void readAll();
    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [key, settleClassic]);
  return states;
}
