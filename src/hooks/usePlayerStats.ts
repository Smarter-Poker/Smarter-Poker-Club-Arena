/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  usePlayerStats — Track opponent statistics for Mini-HUD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tracks VPIP, PFR, 3-bet, c-bet, WTSD per player across hands in the session.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * ONE MAP, ONE TIMER (audit 2026-08-28)
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * This hook used to keep the whole map in PER-INSTANCE `useState`, seeded from
 * one GLOBAL localStorage key, and flush it on a PER-INSTANCE 30s timer. Up to
 * four TablePages are mounted at once inside the persistent table layer, so:
 *
 *   - four independent in-memory maps existed, none of which could see the
 *     others' hands — the same opponent at two of your tables accumulated two
 *     separate, both-wrong sets of counters;
 *   - four timers each serialised a whole map to the SAME key every 30s, so
 *     THE LAST WRITER CLOBBERED THE OTHER THREE. Opponent stats built at
 *     tables 1-3 were silently destroyed by table 4's flush. That is a
 *     correctness bug wearing a performance bug's clothes.
 *
 * The map is now a module-level singleton read through `useSyncExternalStore`,
 * with ONE refcounted flush timer for the document. Every mounted table writes
 * into and reads from the same map — which is what a per-OPPONENT statistic
 * means — and there is exactly one writer to the storage key.
 *
 * The flush-on-the-way-out behaviour (2026-08-28, kept) still applies: the 30s
 * timer used to be the only writer, so leaving a table or having the tab
 * reclaimed on mobile discarded up to thirty seconds of counters the player
 * had already been shown. `pagehide` is the reliable mobile signal (iOS often
 * never fires `beforeunload`) and `visibilitychange -> hidden` covers a
 * backgrounded tab that may never come back. Both are now attached ONCE
 * rather than once per table.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { MiniHUDStats } from '../components/table/MiniHUD';
import {
  observePublicHandStats,
  resetPublicObservedHandStats,
  publicObservedReceiptKeys,
  restorePublicObservedReceiptKeys,
} from './publicObservedHandStats';

interface PlayerStatsMap {
  [playerId: string]: MiniHUDStats;
}

import { STORAGE_KEYS } from '../lib/storage';
const STORAGE_KEY = STORAGE_KEYS.PLAYER_STATS_SWR;

function createEmptyStats(): MiniHUDStats {
  return {
    handsPlayed: 0,
    vpipCount: 0,
    pfrCount: 0,
    threeBetCount: 0,
    cBetCount: 0,
    wtsdCount: 0,
    wonCount: 0,
    totalBuyIn: 0,
    totalCashOut: 0,
  };
}

// ─── The one map ─────────────────────────────────────────────────────────────

function hydrate(): PlayerStatsMap {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    if (
      parsed?.version === 3 &&
      parsed.stats &&
      typeof parsed.stats === 'object' &&
      !Array.isArray(parsed.stats)
    ) {
      restorePublicObservedReceiptKeys(parsed.receipts);
      return parsed.stats;
    }
    // Legacy counters blended game modes and cannot be reliably split.
    return {};
  } catch {
    return {};
  }
}

let statsMap: PlayerStatsMap = hydrate();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function mutate(playerId: string, patch: (s: MiniHUDStats) => MiniHUDStats): void {
  if (!playerId) return;
  const existing = statsMap[playerId] || createEmptyStats();
  // New object identity for the map so useSyncExternalStore sees the change.
  statsMap = { ...statsMap, [playerId]: patch(existing) };
  emit();
}

function flush(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 3, stats: statsMap, receipts: publicObservedReceiptKeys() })
    );
  } catch {
    /* quota exceeded — ignore */
  }
}

// ─── One refcounted flush timer for the document ─────────────────────────────

let holders = 0;
let interval: ReturnType<typeof setInterval> | null = null;
const onHide = () => {
  if (document.visibilityState === 'hidden') flush();
};

function acquireFlusher(): () => void {
  holders += 1;
  if (holders === 1) {
    interval = setInterval(flush, 30000);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
  }
  return () => {
    holders = Math.max(0, holders - 1);
    if (holders === 0) {
      if (interval) clearInterval(interval);
      interval = null;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      // Last table closing is exactly when the accumulated counters must land.
      flush();
    }
  };
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const releaseFlusher = acquireFlusher();
  return () => {
    listeners.delete(onStoreChange);
    releaseFlusher();
  };
}

function getSnapshot(): PlayerStatsMap {
  return statsMap;
}

export function usePlayerStats(observerId?: string, gameMode: 'cash' | 'tournament' = 'cash') {
  const playerKey = useCallback(
    (id: string) => JSON.stringify([observerId ?? 'legacy', gameMode, id]),
    [observerId, gameMode]
  );
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const getStats = useCallback(
    (playerId: string): MiniHUDStats | null => {
      return statsMap[playerKey(playerId)] || null;
    },
    [playerKey]
  );

  const recordHandPlayed = useCallback(
    (playerId: string) => {
      mutate(playerKey(playerId), (s) => ({ ...s, handsPlayed: s.handsPlayed + 1 }));
    },
    [playerKey]
  );

  const recordVPIP = useCallback(
    (playerId: string) => {
      mutate(playerKey(playerId), (s) => ({ ...s, vpipCount: s.vpipCount + 1 }));
    },
    [playerKey]
  );

  const recordPFR = useCallback(
    (playerId: string) => {
      mutate(playerKey(playerId), (s) => ({ ...s, pfrCount: s.pfrCount + 1 }));
    },
    [playerKey]
  );

  const recordThreeBet = useCallback(
    (playerId: string) => {
      mutate(playerKey(playerId), (s) => ({ ...s, threeBetCount: s.threeBetCount + 1 }));
    },
    [playerKey]
  );

  const recordWTSD = useCallback(
    (playerId: string) => {
      mutate(playerKey(playerId), (s) => ({ ...s, wtsdCount: s.wtsdCount + 1 }));
    },
    [playerKey]
  );

  const recordWin = useCallback(
    (playerId: string) => {
      mutate(playerKey(playerId), (s) => ({ ...s, wonCount: s.wonCount + 1 }));
    },
    [playerKey]
  );

  const observePublicEvent = useCallback(
    (tableId: string, type: string, data: Record<string, unknown>) => {
      const observed = observePublicHandStats(
        JSON.stringify([observerId ?? 'legacy', gameMode]),
        tableId,
        type,
        data
      );
      if (!observed.length) return;
      const next = { ...statsMap };
      for (const row of observed) {
        const key = playerKey(row.playerId);
        const previous = next[key] ?? createEmptyStats();
        next[key] = {
          ...previous,
          handsPlayed: previous.handsPlayed + 1,
          vpipCount: previous.vpipCount + Number(row.vpip),
          pfrCount: previous.pfrCount + Number(row.pfr),
          wonCount: previous.wonCount + Number(row.won),
          aggressiveActions: (previous.aggressiveActions ?? 0) + (row.aggressiveActions ?? 0),
          callActions: (previous.callActions ?? 0) + (row.callActions ?? 0),
          aggressionMeasured:
            (previous.handsPlayed === 0 || previous.aggressionMeasured === true) &&
            row.aggressiveActions !== undefined &&
            row.callActions !== undefined,
        };
      }
      statsMap = next;
      flush();
      emit();
    },
    [observerId, gameMode, playerKey]
  );

  const clearStats = useCallback(() => {
    statsMap = {};
    resetPublicObservedHandStats();
    emit();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, [playerKey]);

  return {
    getStats,
    observePublicEvent,
    recordHandPlayed,
    recordVPIP,
    recordPFR,
    recordThreeBet,
    recordWTSD,
    recordWin,
    clearStats,
    statsMap: map,
  };
}

/** Test-only reset so a suite can start from a clean map. */
export function __resetPlayerStatsForTests(): void {
  resetPublicObservedHandStats();
  statsMap = {};
  listeners.clear();
  if (interval) clearInterval(interval);
  interval = null;
  holders = 0;
}
