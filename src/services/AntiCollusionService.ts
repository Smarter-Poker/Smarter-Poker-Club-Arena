/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ANTI-COLLUSION SERVICE — Pattern detection for cheating prevention
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tracks suspicious patterns between players:
 * - Fold-to-specific-player patterns (always folding to same opponent)
 * - Chip-dumping (large pot → fold with strong hand)
 * - Coordinated seat-taking (same IP/device fingerprint)
 * - Scoring system: 0-100 suspicion score
 * - Threshold alerts at score > 70
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type PatternType =
  | 'FOLD_TO_PLAYER'
  | 'CHIP_DUMP'
  | 'COORDINATED_SEATING'
  | 'SOFT_PLAY'
  | 'WIN_RATE_ANOMALY';

export interface CollusionEvent {
  playerA: string;
  playerB: string;
  patternType: PatternType;
  evidence: Record<string, unknown>;
  timestamp: number;
}

export interface SuspicionScore {
  playerA: string;
  playerB: string;
  score: number; // 0-100
  patterns: PatternType[];
  lastUpdated: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

const ALERT_THRESHOLD = 70;
const FOLD_PATTERN_THRESHOLD = 0.8; // Folding to same player > 80% of the time
const CHIP_DUMP_MIN_POT = 50; // Minimum pot size to flag chip dumping
const SCORE_DECAY_RATE = 0.95; // Score decays 5% per day

// In-memory tracking for current session
const sessionTracking: Map<string, { folds: number; encounters: number }> = new Map();
const SESSION_STORAGE_KEY = 'ac:session_tracking';

// Hydrate session tracking from sessionStorage
function hydrateSession(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      const parsed: [string, { folds: number; encounters: number }][] = JSON.parse(raw);
      for (const [key, value] of parsed) {
        sessionTracking.set(key, value);
      }
    }
  } catch (err) {

    console.error("[AntiCollusionService] Error:", err);
    /* ignore */
  }
}

function persistSession(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(Array.from(sessionTracking.entries()))
    );
  } catch (err) {

    console.error("[AntiCollusionService] Error:", err);
    /* quota exceeded — non-fatal */
  }
}

hydrateSession();

export const AntiCollusionService = {
  /**
   * Track a fold event between two players
   */
  trackFold(foldingPlayer: string, potWinner: string, potSize: number): void {
    const pairKey = [foldingPlayer, potWinner].sort().join(':');

    const existing = sessionTracking.get(pairKey) || { folds: 0, encounters: 0 };
    existing.folds++;
    existing.encounters++;
    sessionTracking.set(pairKey, existing);

    // Check for suspicious fold pattern
    if (existing.encounters >= 10) {
      const foldRate = existing.folds / existing.encounters;
      if (foldRate >= FOLD_PATTERN_THRESHOLD) {
        this.recordEvent({
          playerA: foldingPlayer,
          playerB: potWinner,
          patternType: 'FOLD_TO_PLAYER',
          evidence: {
            foldRate: Math.round(foldRate * 100),
            folds: existing.folds,
            encounters: existing.encounters,
            potSize,
          },
          timestamp: Date.now(),
        });
      }
    }
  },

  /**
   * Track a hand where player folds a strong hand in a big pot
   */
  trackChipDump(
    foldingPlayer: string,
    potWinner: string,
    potSize: number,
    handStrength: number // 0-1 scale
  ): void {
    if (potSize >= CHIP_DUMP_MIN_POT && handStrength >= 0.7) {
      this.recordEvent({
        playerA: foldingPlayer,
        playerB: potWinner,
        patternType: 'CHIP_DUMP',
        evidence: {
          potSize,
          handStrength: Math.round(handStrength * 100),
          action: 'fold_strong_hand_in_big_pot',
        },
        timestamp: Date.now(),
      });
    }
    // Persist to sessionStorage
    persistSession();
  },

  /**
   * Track players who always sit together at the same table
   */
  trackSeating(tableId: string, playerIds: string[]): void {
    // Store seating patterns for cross-reference
    if (playerIds.length < 2) return;

    // Check all pairs
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const pairKey = `seat:${[playerIds[i], playerIds[j]].sort().join(':')}`;
        const existing = sessionTracking.get(pairKey) || { folds: 0, encounters: 0 };
        existing.encounters++;
        sessionTracking.set(pairKey, existing);

        // Flag if same pair appears > 10 times in a session
        if (existing.encounters > 10) {
          this.recordEvent({
            playerA: playerIds[i],
            playerB: playerIds[j],
            patternType: 'COORDINATED_SEATING',
            evidence: {
              tableId,
              coSeatedCount: existing.encounters,
            },
            timestamp: Date.now(),
          });
        }
      }
    }
    // Persist to sessionStorage
    persistSession();
  },

  /**
   * Record a suspicious event and update scores
   */
  async recordEvent(event: CollusionEvent): Promise<void> {
    // Calculate new suspicion score
    const score = this.calculateScore(event);

    // Log to Supabase
    try {
      await supabase.from('collusion_tracking').insert({
        player_a: event.playerA,
        player_b: event.playerB,
        pattern_type: event.patternType,
        suspicion_score: score,
        evidence: event.evidence,
        created_at: new Date(event.timestamp).toISOString(),
      });
    } catch (err: unknown) {
      console.error('[AntiCollusion] Failed to log event:', err);
    }

    // Emit bus event
    masterBus.emit('COLLUSION_DETECTED', {
      playerA: event.playerA,
      playerB: event.playerB,
      patternType: event.patternType,
      score,
    });

    // Raise alert if score exceeds threshold
    if (score >= ALERT_THRESHOLD) {
      try {
        const { FinancialAlertService } = await import('./FinancialAlertService');
        FinancialAlertService.raise(
          'critical',
          `Collusion alert: ${event.patternType} between players ${event.playerA.slice(0, 8)} and ${event.playerB.slice(0, 8)} (score: ${score})`,
          'AntiCollusionService',
          {
            playerA: event.playerA,
            playerB: event.playerB,
            patternType: event.patternType,
            score,
            evidence: event.evidence,
          }
        );
      } catch (err) {

        console.error("[AntiCollusionService] Error:", err);
        /* best effort */
      }
    }
  },

  /**
   * Calculate suspicion score based on pattern type and frequency
   */
  calculateScore(event: CollusionEvent): number {
    const baseScores: Record<PatternType, number> = {
      FOLD_TO_PLAYER: 25,
      CHIP_DUMP: 40,
      COORDINATED_SEATING: 15,
      SOFT_PLAY: 30,
      WIN_RATE_ANOMALY: 20,
    };

    const base = baseScores[event.patternType] || 10;

    // Amplify based on evidence strength
    let multiplier = 1;
    if (event.evidence.foldRate && typeof event.evidence.foldRate === 'number') {
      multiplier = event.evidence.foldRate / 100; // Higher fold rate = higher score
    }
    if (event.evidence.potSize && typeof event.evidence.potSize === 'number') {
      multiplier *= Math.min(event.evidence.potSize / 100, 2); // Cap at 2x for big pots
    }

    return Math.min(100, Math.round(base * Math.max(1, multiplier)));
  },

  /**
   * Get suspicion report for a player pair
   */
  async getReport(
    playerA: string,
    playerB: string
  ): Promise<{
    events: CollusionEvent[];
    totalScore: number;
  }> {
    const sorted = [playerA, playerB].sort();

    // Query both directions of the player pair safely (no string interpolation)
    const { data: dataAB } = await supabase
      .from('collusion_tracking')
      .select('player_a, player_b, pattern_type, suspicion_score, evidence, created_at')
      .eq('player_a', sorted[0])
      .eq('player_b', sorted[1])
      .order('created_at', { ascending: false })
      .limit(25);

    const { data: dataBA } = await supabase
      .from('collusion_tracking')
      .select('player_a, player_b, pattern_type, suspicion_score, evidence, created_at')
      .eq('player_a', sorted[1])
      .eq('player_b', sorted[0])
      .order('created_at', { ascending: false })
      .limit(25);

    const data = [...(dataAB || []), ...(dataBA || [])]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 50);

    if (data.length === 0) return { events: [], totalScore: 0 };

    const events = data.map((row: Record<string, unknown>) => ({
      playerA: row.player_a as string,
      playerB: row.player_b as string,
      patternType: row.pattern_type as PatternType,
      evidence: row.evidence as Record<string, unknown>,
      timestamp: new Date(row.created_at as string).getTime(),
    }));

    // Sum scores with time decay
    const now = Date.now();
    const totalScore = data.reduce((sum: number, row: Record<string, unknown>) => {
      const age = (now - new Date(row.created_at as string).getTime()) / (24 * 60 * 60 * 1000);
      const decayedScore = (row.suspicion_score as number) * Math.pow(SCORE_DECAY_RATE, age);
      return sum + decayedScore;
    }, 0);

    return { events, totalScore: Math.min(100, Math.round(totalScore)) };
  },

  /**
   * Clear session tracking data
   */
  clearSession(): void {
    sessionTracking.clear();
  },
};

export default AntiCollusionService;
