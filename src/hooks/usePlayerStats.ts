/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  usePlayerStats — Track opponent statistics for Mini-HUD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tracks VPIP, PFR, 3-bet, c-bet, WTSD per player across hands in the session.
 * Data persists in memory for the session and can be saved to localStorage.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { MiniHUDStats } from '../components/table/MiniHUD';

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

export function usePlayerStats() {
  const [statsMap, setStatsMap] = useState<PlayerStatsMap>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const statsRef = useRef(statsMap);
  statsRef.current = statsMap;

  // Persist to localStorage periodically
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(statsRef.current));
      } catch {
        /* quota exceeded — ignore */
      }
    };
    const interval = setInterval(flush, 30000); // Every 30 seconds
    /**
     * FLUSH ON THE WAY OUT 2026-08-28.
     *
     * The 30s timer was the ONLY writer: leaving the table, or having the tab
     * reclaimed on mobile, discarded up to thirty seconds of accumulated
     * opponent HUD counters — VPIP, 3-bet, hands played — that the player had
     * already been shown. `pagehide` is the reliable mobile signal (iOS often
     * never fires `beforeunload`), `visibilitychange -> hidden` covers a
     * backgrounded tab that may never come back, and the cleanup covers a
     * normal unmount. `lib/walletCache.ts` solves the same problem the same
     * way and explains why; this hook never got it.
     */
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(interval);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, []);

  const getStats = useCallback((playerId: string): MiniHUDStats | null => {
    return statsRef.current[playerId] || null;
  }, []);

  const recordHandPlayed = useCallback((playerId: string) => {
    setStatsMap((prev) => {
      const existing = prev[playerId] || createEmptyStats();
      return {
        ...prev,
        [playerId]: { ...existing, handsPlayed: existing.handsPlayed + 1 },
      };
    });
  }, []);

  const recordVPIP = useCallback((playerId: string) => {
    setStatsMap((prev) => {
      const existing = prev[playerId] || createEmptyStats();
      return {
        ...prev,
        [playerId]: { ...existing, vpipCount: existing.vpipCount + 1 },
      };
    });
  }, []);

  const recordPFR = useCallback((playerId: string) => {
    setStatsMap((prev) => {
      const existing = prev[playerId] || createEmptyStats();
      return {
        ...prev,
        [playerId]: { ...existing, pfrCount: existing.pfrCount + 1 },
      };
    });
  }, []);

  const recordThreeBet = useCallback((playerId: string) => {
    setStatsMap((prev) => {
      const existing = prev[playerId] || createEmptyStats();
      return {
        ...prev,
        [playerId]: { ...existing, threeBetCount: existing.threeBetCount + 1 },
      };
    });
  }, []);

  const recordWTSD = useCallback((playerId: string) => {
    setStatsMap((prev) => {
      const existing = prev[playerId] || createEmptyStats();
      return {
        ...prev,
        [playerId]: { ...existing, wtsdCount: existing.wtsdCount + 1 },
      };
    });
  }, []);

  const recordWin = useCallback((playerId: string) => {
    setStatsMap((prev) => {
      const existing = prev[playerId] || createEmptyStats();
      return {
        ...prev,
        [playerId]: { ...existing, wonCount: existing.wonCount + 1 },
      };
    });
  }, []);

  const clearStats = useCallback(() => {
    setStatsMap({});
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return {
    getStats,
    recordHandPlayed,
    recordVPIP,
    recordPFR,
    recordThreeBet,
    recordWTSD,
    recordWin,
    clearStats,
    statsMap,
  };
}
