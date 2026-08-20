/**
 * Supabase helpers — the 4-tier hand history writer (Bible V8 §2.18).
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

/**
 * Log hand history — every hand documented for audit and replay.
 */
/**
 * Bible V8 §2.18: 4-tier Hand History system
 *
 * Tier 1: raw_events — Every action with timestamps (audit/dispute)
 * Tier 2: audit_log — Normalized format for compliance review
 * Tier 3: player_summary — Per-player view (what they can see in their history)
 * Tier 4: dispute_review — Full data package for dispute resolution
 *
 * All 4 tiers are computed from the same input and stored in a single row
 * with JSONB columns for each tier.
 */
export async function logHandHistory(params: {
  tableId: string;
  tournamentId?: string;
  handNumber: number;
  gameVariant: string;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount: number;
  bbjAmount?: number;
  communityCards: string[];
  // Round 38 — wall-clock timestamps. startedAt is captured at HAND_START
  // in ServerTableEngine; endedAt is stamped here at write time.
  startedAt?: number;
  endedAt?: number;
  winners: {
    userId: string;
    amount: number;
    potIndex?: number;
    hand?: { name: string; ranking: number };
  }[];
  players: { userId: string; username: string; seat: number; stack: number; cards: string[] }[];
  actions: {
    seat: number;
    userId?: string;
    action: string;
    amount?: number;
    timestamp?: number;
    stage: string;
  }[];
  showdownResults?: {
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards: { rank: string; suit: string }[];
  }[];
  /**
   * ASSISTANT FIX 2026-08-16: dealer/button seat for this hand.
   *
   * Without it no positional analysis is possible at all — seat 3 is UTG in
   * one hand and the cutoff two hands later, so "you open too wide from early
   * position", the most common leak in low-stakes poker, was uncomputable.
   * The engine has always tracked this (currentHandDealerSeat); it was simply
   * never persisted.
   */
  buttonSeat?: number;
}): Promise<{ handId: string | null }> {
  // ── Tier 1: Raw Events ──────────────────────────────────────────────
  const rawEvents = params.actions.map((a, idx) => ({
    seq: idx,
    seat: a.seat,
    userId: a.userId || params.players.find((p) => p.seat === a.seat)?.userId || 'unknown',
    action: a.action,
    amount: a.amount ?? 0,
    stage: a.stage,
    timestamp: a.timestamp ?? Date.now(),
  }));

  // ── Tier 2: Audit Log ───────────────────────────────────────────────
  const auditLog = {
    table_id: params.tableId,
    tournament_id: params.tournamentId || null,
    hand_number: params.handNumber,
    game_variant: params.gameVariant,
    blinds: { sb: params.smallBlind, bb: params.bigBlind },
    pot_size: params.potSize,
    rake: params.rakeAmount,
    bbj_fee: params.bbjAmount || 0,
    board: params.communityCards,
    player_count: params.players.length,
    action_count: params.actions.length,
    went_to_showdown: (params.showdownResults?.length ?? 0) > 0,
    created_at: new Date().toISOString(),
  };

  // ── Tier 3: Player Summaries ────────────────────────────────────────
  const playerSummaries = params.players.map((p) => {
    const winRecord = params.winners.find((w) => w.userId === p.userId);
    const showdown = params.showdownResults?.find((s) => s.userId === p.userId);
    const playerActions = params.actions.filter((a) => a.seat === p.seat || a.userId === p.userId);
    return {
      userId: p.userId,
      username: p.username,
      seat: p.seat,
      startStack: p.stack,
      netResult: winRecord ? winRecord.amount : 0,
      handName: showdown?.handName || null,
      handRanking: showdown?.handRanking || null,
      actionCount: playerActions.length,
      folded: playerActions.some((a) => a.action === 'fold'),
      wentAllIn: playerActions.some((a) => a.action === 'all_in'),
    };
  });

  // ── Tier 4: Dispute Review Package ──────────────────────────────────
  const disputeReview = {
    raw_events: rawEvents,
    audit_log: auditLog,
    player_summaries: playerSummaries,
    showdown_results: params.showdownResults || [],
    community_cards: params.communityCards,
    pot_breakdown: params.winners,
    integrity_hash: `${params.tableId}:${params.handNumber}:${Date.now()}`,
  };

  // Round 38 fix: stamp started_at/ended_at + RETURNING id so the caller
  // can FK rake_records.hand_id back to this hand_history row.
  const startedAtIso = params.startedAt
    ? new Date(params.startedAt).toISOString()
    : new Date().toISOString();
  const endedAtIso = params.endedAt
    ? new Date(params.endedAt).toISOString()
    : new Date().toISOString();

  // ── Personal-assistant inputs (ASSISTANT FIX 2026-08-16) ────────────
  // `hand_history.hole_cards` and `.board` have existed as columns for a long
  // time and NOTHING has ever written to them: 0 populated rows out of 56,594
  // hands a day. Meanwhile the leak detector selects exactly those two columns
  // (`hero_cards:hole_cards, board`) to attach a worked example to every leak
  // it reports — so every example it produced showed the player a leak with no
  // hand and no board attached.
  //
  // Only SHOWDOWN-revealed holdings go in. That is information the whole table
  // already saw face-up, so a hand participant reading this column learns
  // nothing new. Mucked cards are deliberately never stored: persisting them
  // would let anyone who played the hand mine their opponents' mucked ranges
  // afterwards, which is a game-integrity problem, not a feature.
  const holeCardsByUser: Record<string, { rank: string; suit: string }[]> = {};
  for (const sd of params.showdownResults ?? []) {
    if (sd.userId && sd.holeCards?.length) holeCardsByUser[sd.userId] = sd.holeCards;
  }
  const holeCardsPayload =
    Object.keys(holeCardsByUser).length > 0 ? holeCardsByUser : null;
  const boardPayload = params.communityCards?.length ? params.communityCards : null;

  const { data, error } = await supabase
    .from('hand_history')
    .insert({
      table_id: params.tableId,
      tournament_id: params.tournamentId || null,
      hand_number: params.handNumber,
      game_variant: params.gameVariant,
      small_blind: params.smallBlind,
      big_blind: params.bigBlind,
      pot_size: params.potSize,
      rake_amount: params.rakeAmount,
      bbj_amount: params.bbjAmount || 0,
      community_cards: params.communityCards,
      started_at: startedAtIso,
      ended_at: endedAtIso,
      winners: params.winners,
      players: params.players,
      actions: params.actions,
      hole_cards: holeCardsPayload,
      board: boardPayload,
      button_seat: params.buttonSeat ?? null,
      // Bible V8 §2.18: 4-tier hand history layers (stored as JSONB)
      raw_events: rawEvents,
      audit_log: auditLog,
      player_summaries: playerSummaries,
      dispute_review: disputeReview,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    // Non-fatal: the 4-tier columns may not exist yet in the DB schema.
    // Fall back to legacy insert without the new columns if the error is about unknown columns.
    if (error.message?.includes('column') || error.code === '42703') {
      const { data: fbData, error: fallbackError } = await supabase
        .from('hand_history')
        .insert({
          table_id: params.tableId,
          tournament_id: params.tournamentId || null,
          hand_number: params.handNumber,
          game_variant: params.gameVariant,
          small_blind: params.smallBlind,
          big_blind: params.bigBlind,
          pot_size: params.potSize,
          rake_amount: params.rakeAmount,
          bbj_amount: params.bbjAmount || 0,
          community_cards: params.communityCards,
          started_at: startedAtIso,
          ended_at: endedAtIso,
          winners: params.winners,
          players: params.players,
          actions: params.actions,
          // The assistant inputs travel on the fallback too — this branch only
          // exists to drop the 4-tier JSONB columns, and losing the leak
          // detector's inputs here would make the degradation silent.
          hole_cards: holeCardsPayload,
          board: boardPayload,
          button_seat: params.buttonSeat ?? null,
        })
        .select('id')
        .maybeSingle();
      if (fallbackError) {
        console.warn(
          `[DB] Failed to log hand history #${params.handNumber}:`,
          fallbackError.message
        );
        return { handId: null };
      }
      return { handId: fbData?.id ?? null };
    }
    /**
     * FIX 2026-08-20: this failure used to be a bare console.warn, and it is
     * anything but cosmetic.
     *
     * A null handId propagates into atomic_distribute_rake and
     * bbj_record_contribution as p_hand_id = NULL, and BOTH of those dedupe on
     * a partial index predicated on `hand_id IS NOT NULL`. Until today that
     * meant a hand with no history row had no idempotency at all on its rake or
     * its jackpot contribution: 527 such rows exist, 55 of them banked more
     * than once, 237.95 chips of rake over-credited. The RPCs now key off
     * (table_id, hand_number) instead, so a null id is no longer dangerous —
     * but it is still a real failure that was invisible, logged at a level
     * nothing alerts on, on a path nothing retried.
     *
     * Report it properly. The rate is low (527 of ~1.01M cash rake rows over 30
     * days, 0.05%) which is exactly the profile of a transient write failure
     * worth retrying rather than a systematic one.
     */
    reportError(
      new Error(
        `[DB] Failed to log hand history #${params.handNumber} for table ${params.tableId}: ` +
          `${error.message}. The hand has NO history row, so its rake and BBJ contribution ` +
          `will be keyed on (table_id, hand_number) rather than hand_id.`
      ),
      'logHandHistory.insert_failed'
    );
    return { handId: null };
  }
  return { handId: data?.id ?? null };
}
