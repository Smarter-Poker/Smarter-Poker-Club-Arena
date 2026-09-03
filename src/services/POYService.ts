/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POY SERVICE — Player of the Year Integration
 * Connects Club Arena game results to World Hub's POY leaderboard system
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TournamentResultPayload {
  player_id: string;
  club_id: string;
  club_name?: string;
  game_type: 'tournament' | 'sit-n-go' | 'spin-n-go' | 'satellite';
  game_id?: string;
  placement: number;
  total_players: number;
  buy_in: number;
  winnings: number;
  duration_minutes?: number;
}

export interface CashSessionPayload {
  player_id: string;
  club_id: string;
  club_name?: string;
  game_type: 'cash';
  hands_played: number;
  winnings: number; // profit/loss
  duration_minutes: number;
  buy_in: number;
}

export interface POYLeaderboardEntry {
  rank: number;
  player_id: string;
  username: string;
  avatar_url?: string;
  total_points: number;
  arcade_points: number;
  club_arena_points: number;
  tournament_points: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// POY endpoints — same origin, no API key needed from client
// (server-side routes authenticate via Supabase JWT from the request)
const POY_WEBHOOK_URL = '/api/club-arena/results';
const POY_LEADERBOARD_URL = '/api/poy/leaderboard';

// Batch tracking for cash sessions
interface SessionTracker {
  playerId: string;
  clubId: string;
  clubName?: string;
  handsPlayed: number;
  profit: number;
  startTime: number;
  lastUpdate: number;
}

const activeSessions: Map<string, SessionTracker> = new Map();
const BATCH_INTERVAL_MS = 5 * 60 * 1000; // Batch submit every 5 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const POYService = {
  /**
   * Submit tournament result to POY system
   * Called when a player finishes a tournament (elimination or winner)
   */
  async submitTournamentResult(
    data: TournamentResultPayload
  ): Promise<{ success: boolean; points_awarded?: number }> {
    try {
      const response = await fetch(POY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          timestamp: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        reportError(error, 'POYService.POYService_Tournament_submit_failed');
        return { success: false };
      }

      const result = await response.json();
      return { success: true, points_awarded: result.points_awarded };
    } catch (error: unknown) {
      reportError(error, 'POYService.POYService_Tournament_submit_error');
      return { success: false };
    }
  },

  /**
   * Submit cash session result to POY system
   * Called when a player leaves a cash table
   */
  async submitCashSession(
    data: CashSessionPayload
  ): Promise<{ success: boolean; points_awarded?: number }> {
    try {
      const response = await fetch(POY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          timestamp: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        reportError(error, 'POYService.POYService_Cash_session_submit_failed');
        return { success: false };
      }

      const result = await response.json();
      return { success: true, points_awarded: result.points_awarded };
    } catch (error: unknown) {
      reportError(error, 'POYService.POYService_Cash_session_submit_error');
      return { success: false };
    }
  },

  /**
   * Track hand result for batched cash session submission
   * Accumulates hands and submits periodically
   */
  trackHandResult(result: {
    userId: string;
    clubId: string;
    clubName?: string;
    profit: number;
  }): void {
    const key = `${result.userId}:${result.clubId}`;
    const now = Date.now();

    const existing = activeSessions.get(key);
    if (existing) {
      existing.handsPlayed++;
      existing.profit += result.profit;
      existing.lastUpdate = now;

      // Check if we should batch submit
      if (now - existing.startTime >= BATCH_INTERVAL_MS) {
        this.flushSession(key);
      }
    } else {
      activeSessions.set(key, {
        playerId: result.userId,
        clubId: result.clubId,
        clubName: result.clubName,
        handsPlayed: 1,
        profit: result.profit,
        startTime: now,
        lastUpdate: now,
      });
    }
  },

  /**
   * Flush and submit a cash session
   */
  async flushSession(key: string): Promise<void> {
    const session = activeSessions.get(key);
    if (!session || session.handsPlayed === 0) return;

    activeSessions.delete(key);

    await this.submitCashSession({
      player_id: session.playerId,
      club_id: session.clubId,
      club_name: session.clubName,
      game_type: 'cash',
      hands_played: session.handsPlayed,
      winnings: session.profit,
      duration_minutes: Math.round((session.lastUpdate - session.startTime) / 60000),
      buy_in: 0, // Cash sessions don't have fixed buy-in
    });
  },

  /**
   * Flush all active sessions (call on app unload)
   */
  async flushAllSessions(): Promise<void> {
    const keys = Array.from(activeSessions.keys());
    await Promise.all(keys.map((key) => this.flushSession(key)));
  },

  /**
   * Get POY leaderboard from World Hub
   */
  async getLeaderboard(year?: number, limit = 50): Promise<POYLeaderboardEntry[]> {
    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
      });
      if (year) params.set('year', year.toString());

      const response = await fetch(`${POY_LEADERBOARD_URL}?${params}`);
      if (!response.ok) {
        throw new Error('Failed to fetch POY leaderboard');
      }

      const data = await response.json();
      return data.leaderboard || [];
    } catch (error: unknown) {
      reportError(error, 'POYService.POYService_Leaderboard_fetch_error');
      return [];
    }
  },

  /**
   * Get player's POY ranking
   */
  async getPlayerRanking(playerId: string): Promise<{
    rank: number;
    points: number;
    percentile: number;
  } | null> {
    try {
      const response = await fetch(`${POY_LEADERBOARD_URL}?player_id=${playerId}`);
      if (!response.ok) return null;

      const data = await response.json();
      return data.player_ranking || null;
    } catch (error: unknown) {
      reportError(error, 'POYService.POYService_Player_ranking_fetch_error');
      return null;
    }
  },
};

// Flush sessions on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    POYService.flushAllSessions();
  });
}

export default POYService;
