/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LIGHTNING HAND IS A HAND IN THE STATS (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production 2026-10-24: 0 of 40 settled Lightning hands had a ca_hand_facts
 * row or a ca_hand_transfers row; 40 of 40 physical hands of the same hour had
 * both. The collusion scan (fn_ca_collusion_scan) reads only ca_hand_transfers;
 * the player statistics, the Lightning session recap's VPIP/PFR
 * (fn_lightning_session_stats) and the VPIP floor (fn_cash_vpip_status,
 * fn_nit_check) read ca_hand_facts. Every fast-fold hand was invisible to all
 * of them - for horses and humans alike (CLAUDE.md 10.5).
 *
 * A physical hand carries its private per-hand facts in the accepted hand
 * row (`_accepted_post_commit_facts.stats_facts`, built by writeHandFacts in
 * collect-only mode), the accepted-hand door stores them in its immutable
 * receipt, and the post-commit projector writes both tables from it. This
 * builds the SAME payload, with the SAME builder, for a Lightning hand: every
 * participant dealt in, keyed by the Lightning hand id, at the host table and
 * its club. fn_lightning_settle_hand keeps it only when it names exactly that
 * hand, table and club (migration 20261025000729), and the hand row then takes
 * the Lightning hand id so the facts and the row agree.
 *
 * Never throws and never blocks a settlement: a hand whose facts cannot be
 * built settles exactly as it did before, without them.
 */
import {
  writeHandFacts,
  type DurableStatsFactPayload,
  type HandAction,
  type HandFactsInput,
} from '../services/supabase/handFacts.js';

export interface LightningFactsHand {
  /** The Lightning hand id: the hand_history id the settlement gives the row. */
  handId: string;
  hostTableId: string;
  rules: Record<string, unknown>;
  handNumber: number;
  /** The hand row's own `ended_at`, so the facts and the row agree. */
  playedAtIso: string;
  buttonSeat: number | null;
  rake: number;
  board: readonly unknown[];
  /** Every participant dealt in: their seat and hole cards. */
  holeCards: ReadonlyMap<string, { seat: number; cards: unknown }>;
  /** Every participant's settled chips in, net of any uncalled return. */
  players: ReadonlyArray<{ user_id: string; totalInvested?: number }>;
  stacksBefore: ReadonlyMap<string, number>;
  winners: ReadonlyArray<{ userId: string; amount: number }>;
  actions: ReadonlyArray<Record<string, unknown>>;
  participants: ReadonlyArray<{ playerId: string; isHorse: boolean }>;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** The physical builder's input for this Lightning hand. Pure. */
export function lightningHandFactsInput(hand: LightningFactsHand): HandFactsInput | null {
  const clubId = typeof hand.rules.club_id === 'string' ? hand.rules.club_id : null;
  const bigBlind = Number(hand.rules.big_blind);
  if (!hand.handId || !hand.hostTableId || !clubId || !(bigBlind > 0)) return null;
  if (hand.participants.length === 0 || hand.holeCards.size === 0) return null;
  return {
    handId: hand.handId,
    tableId: hand.hostTableId,
    clubId,
    tournamentId: null,
    handNumber: hand.handNumber,
    gameVariant: String(hand.rules.game_variant || 'nlh'),
    bigBlind,
    playedAt: hand.playedAtIso,
    buttonSeat: hand.buttonSeat,
    rakeAmount: hand.rake,
    boardLength: hand.board.length,
    holeCardsAll: new Map(hand.holeCards),
    contributions: new Map(hand.players.map((p) => [p.user_id, cents(p.totalInvested ?? 0)])),
    dealtStacksAtDeal: new Map(hand.stacksBefore),
    winners: hand.winners.map((w) => ({ userId: w.userId, amount: w.amount })),
    actions: hand.actions as unknown as HandAction[],
    roster: hand.participants.map((p) => ({ userId: p.playerId, isHorse: p.isHorse })),
    nitGame: hand.rules.nit_game === true,
    isBombPot: false,
    collectOnly: true,
  };
}

export type LightningFactsBuilder = (
  input: HandFactsInput
) => Promise<DurableStatsFactPayload | null>;

/** The accepted-hand stats payload for this Lightning hand, or null. Never throws. */
export async function buildLightningStatsFacts(
  hand: LightningFactsHand,
  build: LightningFactsBuilder = writeHandFacts,
  report: (err: unknown, where: string) => void = () => undefined
): Promise<DurableStatsFactPayload | null> {
  try {
    const input = lightningHandFactsInput(hand);
    if (!input) return null;
    const payload = await build(input);
    if (!payload || !Array.isArray(payload.facts) || payload.facts.length === 0) return null;
    return payload;
  } catch (err) {
    try {
      report(err, 'LightningHandFacts.build');
    } catch {
      /* reporting must not throw */
    }
    return null;
  }
}
