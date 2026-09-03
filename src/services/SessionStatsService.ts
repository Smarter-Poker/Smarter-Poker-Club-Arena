/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION STATS SERVICE — Real-time cash game session analytics
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * In-memory tracking per session:
 * - P&L (profit/loss from initial buy-in)
 * - Hands played, hands/hour
 * - VPIP% and PFR%
 * - Session trajectory data points for mini-graph
 * - Resets on table leave
 */

import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionStats {
  tableId: string;
  userId: string;
  sessionStartTime: number;
  initialStack: number;
  currentStack: number;
  buyInTotal: number;
  handsPlayed: number;
  handsWon: number;
  handsPerHour: number;
  vpipHands: number; // Hands where player voluntarily put chips in preflop
  vpipPercent: number;
  pfrHands: number; // Hands where player raised preflop
  pfrPercent: number;
  profitLoss: number;
  bigBlindsWon: number;
  bigBlind: number;
  /** Data points for session trajectory graph: [timestamp, stack] */
  trajectory: [number, number][];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION STATS SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class SessionStatsServiceClass {
  private sessions: Map<string, SessionStats> = new Map(); // key = tableId
  /** Feature 8: Debounce timers for SESSION_STATS_UPDATE emissions */
  private emitTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Enhancement #7: localStorage key prefix for session backup */
  private readonly STORAGE_PREFIX = 'club-arena-session-';
  /** Enhancement #8: localStorage key for offline session queue */
  private readonly OFFLINE_QUEUE_KEY = 'club-arena-offline-sessions';

  /**
   * Start tracking a new session at a table
   */
  startSession(tableId: string, userId: string, initialStack: number, bigBlind: number): void {
    const now = Date.now();
    const session: SessionStats = {
      tableId,
      userId,
      sessionStartTime: now,
      initialStack,
      currentStack: initialStack,
      buyInTotal: initialStack,
      handsPlayed: 0,
      handsWon: 0,
      handsPerHour: 0,
      vpipHands: 0,
      vpipPercent: 0,
      pfrHands: 0,
      pfrPercent: 0,
      profitLoss: 0,
      bigBlindsWon: 0,
      bigBlind,
      trajectory: [[now, initialStack]],
    };

    this.sessions.set(tableId, session);

    // Enhancement #7: Try to restore previous session for same table/user
    try {
      const stored = localStorage.getItem(this.STORAGE_PREFIX + tableId);
      if (stored) {
        const prev = JSON.parse(stored) as SessionStats;
        if (prev.userId === userId && Date.now() - prev.sessionStartTime < 3600_000) {
          // Resume session if same user and < 1 hour old
          Object.assign(session, prev, { tableId, userId, bigBlind, initialStack });
        }
        localStorage.removeItem(this.STORAGE_PREFIX + tableId);
      }
    } catch (err) {
      reportError(err, 'SessionStatsService.Error');
      /* localStorage may be unavailable */
    }

    // Enhancement #8: Flush any queued offline sessions on startup
    this.flushOfflineQueue();
  }

  /**
   * Feature 8: Debounced emission — batches rapid SESSION_STATS_UPDATE bus events
   * within a 500ms window to reduce bus traffic during high-volume play.
   */
  private debouncedEmit(tableId: string, session: SessionStats): void {
    // Clear existing timer for this table
    const existing = this.emitTimers.get(tableId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.emitTimers.delete(tableId);
      masterBus.emit('SESSION_STATS_UPDATE', {
        tableId,
        stats: { ...session, trajectory: [...session.trajectory] },
      });

      // Enhancement #7: Backup session to localStorage for reconnect resume
      try {
        localStorage.setItem(this.STORAGE_PREFIX + tableId, JSON.stringify(session));
      } catch (err) {
        reportError(err, 'SessionStatsService.Error');
        /* localStorage may be full or unavailable */
      }
    }, 500);
    this.emitTimers.set(tableId, timer);
  }

  /**
   * Record a completed hand
   */
  recordHand(tableId: string, finalStack: number, won: boolean, vpip: boolean, pfr: boolean): void {
    const session = this.sessions.get(tableId);
    if (!session) return;

    session.handsPlayed++;
    if (won) session.handsWon++;
    if (vpip) session.vpipHands++;
    if (pfr) session.pfrHands++;

    session.currentStack = finalStack;
    session.profitLoss = finalStack - session.buyInTotal;
    session.bigBlindsWon =
      session.bigBlind > 0 ? Math.round((session.profitLoss / session.bigBlind) * 100) / 100 : 0;

    // Calculate rates
    const elapsedHours = (Date.now() - session.sessionStartTime) / 3_600_000;
    session.handsPerHour = elapsedHours > 0 ? Math.round(session.handsPlayed / elapsedHours) : 0;
    session.vpipPercent =
      session.handsPlayed > 0 ? Math.round((session.vpipHands / session.handsPlayed) * 100) : 0;
    session.pfrPercent =
      session.handsPlayed > 0 ? Math.round((session.pfrHands / session.handsPlayed) * 100) : 0;

    // Add trajectory data point (max 200 points to prevent memory bloat)
    session.trajectory.push([Date.now(), finalStack]);
    if (session.trajectory.length > 200) {
      // Thin out older points — keep first, last, and every 4th
      const thinned: [number, number][] = [session.trajectory[0]];
      for (let i = 1; i < session.trajectory.length - 1; i += 4) {
        thinned.push(session.trajectory[i]);
      }
      thinned.push(session.trajectory[session.trajectory.length - 1]);
      session.trajectory = thinned;
    }

    // Feature 8: Debounced broadcast to reduce bus traffic
    this.debouncedEmit(tableId, session);
  }

  /**
   * Record a top-up / rebuy during session
   */
  recordRebuy(tableId: string, amount: number): void {
    const session = this.sessions.get(tableId);
    if (!session) return;

    session.buyInTotal += amount;
    session.currentStack += amount;
    session.profitLoss = session.currentStack - session.buyInTotal;
    session.bigBlindsWon =
      session.bigBlind > 0 ? Math.round((session.profitLoss / session.bigBlind) * 100) / 100 : 0;
    session.trajectory.push([Date.now(), session.currentStack]);

    // Rebuys emit immediately (user expects instant feedback)
    masterBus.emit('SESSION_STATS_UPDATE', {
      tableId,
      stats: { ...session, trajectory: [...session.trajectory] },
    });
  }

  /**
   * Get current session stats for a table
   */
  getStats(tableId: string): SessionStats | null {
    return this.sessions.get(tableId) || null;
  }

  /**
   * Feature 6: End session tracking, persist to Supabase, and return final stats.
   * Writes session data to `session_history` table for permanent analytics.
   */
  endSession(tableId: string): SessionStats | null {
    const session = this.sessions.get(tableId);
    if (!session) return null;

    // Clear any pending debounce timer for this table
    const pendingTimer = this.emitTimers.get(tableId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.emitTimers.delete(tableId);
    }

    this.sessions.delete(tableId);

    const durationMs = Date.now() - session.sessionStartTime;
    const durationMinutes = Math.round(durationMs / 60_000);
    // Feature 6: Persist to Supabase (fire-and-forget, non-blocking)
    if (session.handsPlayed > 0) {
      const insertPayload = {
        user_id: session.userId,
        table_id: tableId,
        started_at: new Date(session.sessionStartTime).toISOString(),
        ended_at: new Date().toISOString(),
        duration_minutes: durationMinutes,
        initial_stack: session.initialStack,
        final_stack: session.currentStack,
        buy_in_total: session.buyInTotal,
        profit_loss: session.profitLoss,
        hands_played: session.handsPlayed,
        hands_won: session.handsWon,
        vpip_percent: session.vpipPercent,
        pfr_percent: session.pfrPercent,
        big_blind: session.bigBlind,
        bb_won: session.bigBlindsWon,
        trajectory: session.trajectory,
      };

      supabase
        .from('session_history')
        .insert(insertPayload)
        .then(({ error }) => {
          if (error) {
            reportError(error, 'SessionStatsService.Failed_to_persist_session');
            this.queueOfflineSession(insertPayload);
          }
        });
    }

    // Enhancement #7: Clean up localStorage backup
    try {
      localStorage.removeItem(this.STORAGE_PREFIX + tableId);
    } catch (err) {
      reportError(err, 'SessionStatsService.Error');
      /* no-op */
    }

    return session;
  }

  /**
   * Enhancement #8: Queue failed session to localStorage for later retry
   * Features Sweep #10 bugfix: Added retry_count to prevent poison-pill infinite DB failures.
   */
  private queueOfflineSession(payload: Record<string, unknown>): void {
    try {
      const retryCount = (payload.retry_count as number) || 0;
      if (retryCount >= 3) {
        reportError(
          new Error(
            `[SessionStats] Offline session dropped after ${retryCount} failures to prevent poison pill loop.`
          ),
          'SessionStatsService.Offline_session_dropped_after_retryCount'
        );
        return;
      }

      const existing = localStorage.getItem(this.OFFLINE_QUEUE_KEY);
      const queue = existing ? JSON.parse(existing) : [];
      queue.push({ ...payload, queued_at: new Date().toISOString(), retry_count: retryCount + 1 });
      localStorage.setItem(this.OFFLINE_QUEUE_KEY, JSON.stringify(queue.slice(-20))); // Max 20 queued
    } catch (err) {
      reportError(err, 'SessionStatsService.Error');
      /* localStorage may be full — intentional no-op */
    }
  }

  /**
   * Enhancement #8: Flush offline queue — retry sending queued sessions to Supabase
   */
  private flushOfflineQueue(): void {
    try {
      const existing = localStorage.getItem(this.OFFLINE_QUEUE_KEY);
      if (!existing) return;
      const queue = JSON.parse(existing) as Record<string, unknown>[];
      if (queue.length === 0) return;

      localStorage.removeItem(this.OFFLINE_QUEUE_KEY); // Clear queue immediately

      queue.forEach((payload) => {
        // Remove tracking fields before inserting
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { queued_at: _queued_at, retry_count: _retry_count, ...insertData } = payload;
        supabase
          .from('session_history')
          .insert(insertData)
          .then(({ error }) => {
            if (error) {
              reportError(error, 'SessionStatsService.Offline_flush_failed');
              // Re-queue if still failing (tracks retry_count natively)
              this.queueOfflineSession(payload);
            }
          });
      });
    } catch (err) {
      reportError(err, 'SessionStatsService.Error');
      /* localStorage may be unavailable — intentional no-op */
    }
  }

  /**
   * Reset all sessions (cleanup on unmount)
   */
  resetAll(): void {
    // Clear all debounce timers
    this.emitTimers.forEach((timer) => clearTimeout(timer));
    this.emitTimers.clear();
    this.sessions.clear();
  }
}

export const sessionStatsService = new SessionStatsServiceClass();
export default sessionStatsService;
