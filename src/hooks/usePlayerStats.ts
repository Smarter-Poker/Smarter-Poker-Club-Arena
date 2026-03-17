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
    const interval = setInterval(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(statsRef.current));
      } catch {
        /* quota exceeded — ignore */
      }
    }, 30000); // Every 30 seconds
    return () => clearInterval(interval);
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
