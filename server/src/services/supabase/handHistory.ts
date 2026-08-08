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
    console.warn(`[DB] Failed to log hand history #${params.handNumber}:`, error.message);
    return { handId: null };
  }
  return { handId: data?.id ?? null };
}
