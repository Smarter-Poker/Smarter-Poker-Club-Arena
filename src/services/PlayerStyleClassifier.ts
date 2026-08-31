/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER STYLE CLASSIFIER — Premium-Style Auto-Labeling
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Automatically classifies players into archetypes based on live VPIP/PFR/AF:
 *   S   Shark  — Selective + Aggressive (TAG with edge)
 *   F   Fish   — Loose + Passive (high VPIP, low PFR)
 *   R   Rock   — Ultra-tight + Passive (low VPIP, low PFR)
 *   M   Maniac — Hyper-aggressive + Loose
 *   T   TAG    — Tight-Aggressive (standard solid)
 *   L   LAG    — Loose-Aggressive
 *   N   Nit    — Extremely tight (even tighter than Rock)
 *   CS  Calling Station — Calls everything, never raises
 *
 * Badge icons are single letters (CS is the one two-letter case). The set was
 * migrated off emoji in 2026-08 because CLAUDE.md forbids emoji in code and
 * because emoji render at wildly different sizes across platforms, which made
 * the badge jitter on mobile. Shark and Fish were missed by that migration and
 * are brought into line here.
 *
 * Classification is based on real poker statistics:
 * - VPIP: Voluntarily Put $ In Pot (measures looseness)
 * - PFR: Pre-Flop Raise % (measures preflop aggression)
 * - AF: Aggression Factor = (bets+raises) / calls
 */

export type PlayerStyle =
  | 'shark'
  | 'fish'
  | 'rock'
  | 'maniac'
  | 'tag'
  | 'lag'
  | 'nit'
  | 'calling_station'
  | 'unknown';

export interface PlayerStyleResult {
  style: PlayerStyle;
  label: string;
  icon: string;
  color: string;
  /** Hex background for the badge */
  bgColor: string;
  /** Confidence 0-1 based on sample size */
  confidence: number;
  /** Short tactical note */
  tooltip: string;
}

export interface ClassifyInput {
  handsPlayed: number;
  vpipCount: number;
  pfrCount: number;
  /** Total aggressive actions (bets + raises) */
  aggressiveActions?: number;
  /** Total passive actions (calls + checks) */
  passiveActions?: number;
  /** Total 3-bets */
  threeBetCount?: number;
  /** Went to showdown count */
  wtsdCount?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const STYLE_MAP: Record<PlayerStyle, Omit<PlayerStyleResult, 'style' | 'confidence'>> = {
  shark: {
    label: 'Shark',
    icon: 'S',
    color: '#60A5FA',
    bgColor: 'rgba(96, 165, 250, 0.2)',
    tooltip: 'Selective & Aggressive - Plays Few Hands But Attacks',
  },
  fish: {
    label: 'Fish',
    icon: 'F',
    color: '#34D399',
    bgColor: 'rgba(52, 211, 153, 0.2)',
    tooltip: 'Plays Too Many Hands Passively - Vulnerable To Aggression',
  },
  rock: {
    label: 'Rock',
    icon: 'R',
    color: '#9CA3AF',
    bgColor: 'rgba(156, 163, 175, 0.2)',
    tooltip: 'Ultra-Tight - Only Plays Premium Hands',
  },
  maniac: {
    label: 'Maniac',
    icon: 'M',
    color: '#F87171',
    bgColor: 'rgba(248, 113, 113, 0.2)',
    tooltip: 'Hyper-Aggressive - Raises And Re-Raises Constantly',
  },
  tag: {
    label: 'TAG',
    icon: 'T',
    color: '#A78BFA',
    bgColor: 'rgba(167, 139, 250, 0.2)',
    tooltip: 'Tight-Aggressive - Solid, Balanced Style',
  },
  lag: {
    label: 'LAG',
    icon: 'L',
    color: '#FBBF24',
    bgColor: 'rgba(251, 191, 36, 0.2)',
    tooltip: 'Loose-Aggressive - Wide Range With Heavy Pressure',
  },
  nit: {
    label: 'Nit',
    icon: 'N',
    color: '#6EE7B7',
    bgColor: 'rgba(110, 231, 183, 0.15)',
    tooltip: 'Extremely Tight - Folds Almost Everything',
  },
  calling_station: {
    label: 'Station',
    icon: 'CS',
    color: '#FB923C',
    bgColor: 'rgba(251, 146, 60, 0.2)',
    tooltip: 'Calling Station - Calls Down With Weak Hands',
  },
  unknown: {
    label: '?',
    icon: '?',
    color: '#6B7280',
    bgColor: 'rgba(107, 114, 128, 0.15)',
    tooltip: 'Not Enough Data To Classify',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFIER
// ═══════════════════════════════════════════════════════════════════════════════

class PlayerStyleClassifierClass {
  /** Minimum hands before we classify (below this → "unknown") */
  private readonly MIN_SAMPLE = 15;

  /**
   * Classify a player based on their stats.
   * Uses a decision-tree approach matching player archetypes.
   */
  classify(input: ClassifyInput): PlayerStyleResult {
    const { handsPlayed, vpipCount, pfrCount, aggressiveActions = 0, passiveActions = 0 } = input;

    // Not enough data
    if (handsPlayed < this.MIN_SAMPLE) {
      return { style: 'unknown', ...STYLE_MAP.unknown, confidence: 0 };
    }

    const vpip = (vpipCount / handsPlayed) * 100;
    const pfr = (pfrCount / handsPlayed) * 100;
    const af =
      passiveActions > 0 ? aggressiveActions / passiveActions : aggressiveActions > 0 ? 5 : 1;

    // Confidence scales with sample size (15 hands = 0.3, 100+ hands = 1.0)
    const confidence = Math.min(1, handsPlayed / 100);

    const style = this.classifyFromStats(vpip, pfr, af);
    return { style, ...STYLE_MAP[style], confidence };
  }

  /**
   * Core classification logic.
   *
   * Decision boundaries (industry-standard ranges):
   *   VPIP < 15%  = Very tight
   *   VPIP 15-22% = Tight
   *   VPIP 22-35% = Loose
   *   VPIP > 35%  = Very loose
   *
   *   PFR < 8%    = Passive
   *   PFR 8-18%   = Standard
   *   PFR 18-28%  = Aggressive
   *   PFR > 28%   = Hyper-aggressive
   *
   *   AF < 1.0    = Passive
   *   AF 1.0-2.5  = Standard
   *   AF > 2.5    = Aggressive
   *   AF > 4.0    = Hyper-aggressive
   */
  private classifyFromStats(vpip: number, pfr: number, af: number): PlayerStyle {
    // ── Nit: Ultra-tight, barely plays anything ──
    if (vpip < 12 && pfr < 8) {
      return 'nit';
    }

    // ── Rock: Tight and passive ──
    if (vpip < 18 && pfr < 10 && af < 2.0) {
      return 'rock';
    }

    // ── Maniac: Very loose + very aggressive ──
    if (vpip > 40 && pfr > 25 && af > 2.5) {
      return 'maniac';
    }

    // ── Calling Station: Very loose + very passive ──
    if (vpip > 40 && pfr < 12 && af < 1.5) {
      return 'calling_station';
    }

    // ── Fish: Loose + passive (but not as extreme as calling station) ──
    if (vpip > 35 && pfr < 15 && af < 2.0) {
      return 'fish';
    }

    // ── Shark: Selective + highly aggressive + profitable style ──
    // Sharks have tight VPIP but very high aggression — the most dangerous
    if (vpip >= 18 && vpip <= 28 && pfr >= 15 && pfr <= 25 && af >= 2.5) {
      return 'shark';
    }

    // ── LAG: Loose + aggressive ──
    if (vpip > 28 && pfr > 18 && af >= 2.0) {
      return 'lag';
    }

    // ── TAG: Tight + aggressive (the "standard solid" style) ──
    if (vpip >= 15 && vpip <= 28 && pfr >= 10 && af >= 1.5) {
      return 'tag';
    }

    // ── Fish: Catch-all for loose-passive not caught above ──
    if (vpip > 30 && af < 2.0) {
      return 'fish';
    }

    // ── Rock: Catch-all for tight-passive not caught above ──
    if (vpip < 20 && af < 1.5) {
      return 'rock';
    }

    // Default: TAG (most common solid style)
    return 'tag';
  }

  /**
   * Get just the style label for a set of stats (convenience method).
   */
  getStyleLabel(input: ClassifyInput): string {
    const result = this.classify(input);
    return `${result.icon} ${result.label}`;
  }

  /**
   * Get all available style definitions.
   */
  getStyleDefinitions(): Record<PlayerStyle, Omit<PlayerStyleResult, 'style' | 'confidence'>> {
    return { ...STYLE_MAP };
  }
}

export const playerStyleClassifier = new PlayerStyleClassifierClass();
export default playerStyleClassifier;
