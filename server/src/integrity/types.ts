/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INTEGRITY — Shared Types + AntiCheat Seam
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FOUNDATION MODULE — pure types + the documented seam into the existing
 * AntiCheat / trust_score scaffolding. NOT wired into the live engine.
 *
 * Detectors (BotDetector, CollusionDetector, MultiAccountDetector) consume the
 * NORMALIZED hand shape below (produced by HandEventAdapter from the persisted
 * `hand_history` rows — see server/src/services/supabase.ts logHandHistory) and
 * emit scored `IntegrityFlag`s.
 *
 * ── ANTICHEAT SEAM (follow-up wiring) ──
 * `toAntiCheatEvent(flag)` shapes a flag into the `anti_cheat_events` insert
 * payload already used by server/src/handlers/admin.ts:
 *     supabase.from('anti_cheat_events').insert({
 *       event_type, player_id, club_id, table_id, details, triggered_by });
 * `trustScoreDelta(flags)` returns a suggested negative adjustment to the
 * club_members.trust_score column (src/types/database.types.ts ClubMember).
 * Neither performs I/O — the owning agent decides when/where to persist.
 * ───────────────────────────────────────
 */

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export type NormalizedActionType =
  | 'fold'
  | 'check'
  | 'call'
  | 'bet'
  | 'raise'
  | 'all_in'
  | 'post_blind'
  | 'post_ante'
  | 'discard'
  | 'unknown';

/** One player action within a hand, normalized + enriched with a decision latency. */
export interface NormalizedAction {
  handId: string;
  tableId: string;
  userId: string;
  seat: number;
  street: Street;
  action: NormalizedActionType;
  amount: number;
  timestamp: number;
  /**
   * Decision latency in ms: time from the previous action in the hand to this
   * one, i.e. an approximation of "time on the clock". 0 for the first action
   * or when timestamps are missing. Blind/ante posts are excluded upstream.
   */
  latencyMs: number;
  /** True for forced/mechanical actions (blinds, antes) — excluded from bot timing. */
  forced: boolean;
}

export interface NormalizedPlayer {
  userId: string;
  seat: number;
  startingStack: number;
  cards: string[];
}

export interface NormalizedWinner {
  userId: string;
  amount: number;
}

/** A single hand, normalized from a persisted hand_history row. */
export interface NormalizedHand {
  handId: string;
  tableId: string;
  gameVariant: string;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rake: number;
  communityCards: string[];
  startedAt: number;
  endedAt: number;
  players: NormalizedPlayer[];
  winners: NormalizedWinner[];
  actions: NormalizedAction[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Flags
// ─────────────────────────────────────────────────────────────────────────────

export type IntegrityFlagType = 'bot' | 'collusion' | 'multi_account';

export interface FlagReason {
  code: string;
  detail: string;
  /** Contribution of this reason to the overall score, 0..1. */
  weight: number;
}

/** Unified scored flag emitted by every detector. score is 0..1 (1 = most suspicious). */
export interface IntegrityFlag {
  type: IntegrityFlagType;
  /** One or more implicated users (single user for bot; clusters for collusion/multi-account). */
  userIds: string[];
  score: number;
  /** 'low' | 'medium' | 'high' derived from score thresholds. */
  severity: 'low' | 'medium' | 'high';
  reasons: FlagReason[];
  handsAnalyzed: number;
  /** Free-form structured evidence for reviewer UIs (e.g. AntiCollusionMonitor). */
  evidence: Record<string, unknown>;
}

export function severityFromScore(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.75) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

// ─────────────────────────────────────────────────────────────────────────────
// AntiCheat seam
// ─────────────────────────────────────────────────────────────────────────────

/** Shape matching the `anti_cheat_events` insert used by handlers/admin.ts. */
export interface AntiCheatEventInsert {
  event_type: string;
  player_id: string;
  club_id: string | null;
  table_id: string | null;
  details: Record<string, unknown>;
  triggered_by: string;
}

/**
 * Map a detector flag to an anti_cheat_events insert payload. Does NOT perform
 * I/O — the caller (owning agent) persists via supabase when ready.
 */
export function toAntiCheatEvent(
  flag: IntegrityFlag,
  ctx: { clubId?: string | null; tableId?: string | null; triggeredBy?: string } = {}
): AntiCheatEventInsert {
  const eventTypeByFlag: Record<IntegrityFlagType, string> = {
    bot: 'bot_suspicion',
    collusion: 'collusion_suspicion',
    multi_account: 'multi_account_suspicion',
  };
  return {
    event_type: eventTypeByFlag[flag.type],
    // Primary implicated player; full set carried in details for clusters.
    player_id: flag.userIds[0],
    club_id: ctx.clubId ?? null,
    table_id: ctx.tableId ?? null,
    details: {
      source: 'integrity_detector',
      flag_type: flag.type,
      score: flag.score,
      severity: flag.severity,
      user_ids: flag.userIds,
      reasons: flag.reasons,
      hands_analyzed: flag.handsAnalyzed,
      evidence: flag.evidence,
    },
    triggered_by: ctx.triggeredBy ?? 'system:integrity',
  };
}

/**
 * Suggested trust_score delta (negative) aggregated from a set of flags for a
 * single user. Bounded to [-40, 0]. The owning agent applies it to
 * club_members.trust_score with its own clamping/decay policy.
 */
export function trustScoreDelta(flags: IntegrityFlag[]): number {
  let delta = 0;
  for (const f of flags) {
    const base = f.type === 'multi_account' ? 30 : f.type === 'collusion' ? 25 : 20;
    delta -= base * f.score;
  }
  return Math.max(-40, Math.round(delta));
}
