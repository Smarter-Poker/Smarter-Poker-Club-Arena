/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Hand History Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages hand history data for replay and sharing
 * Real Supabase integration — no demo data
 */

import { supabase } from '../lib/supabase';
import type { Card } from '../types/database.types';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
//
// Round 38 RE-RUN cleanup: removed HandPlayerDB / HandActionDB / TableDB / HandDB
// and the methods that consumed them (getTableHands, getRecentWinningHands,
// searchHands, mapHandRecord). Those types described the legacy `hands` /
// `hand_players` / `hand_actions` tables, which are EMPTY in production
// (0 rows each) — see BUG 021 FIX comment on getPlayerHands. The canonical
// store is `hand_history` (5.15M rows) and its mapper is mapHandHistoryRow.
// Dead-code removal aligns with the "no stubs / no broken paths" rule.

export interface HandPlayer {
  seat: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  position: 'UTG' | 'UTG+1' | 'UTG+2' | 'MP' | 'MP+1' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';
  hole_cards: Card[];
  final_hand?: string;
  result: number;
  is_winner: boolean;
}

export interface HandAction {
  player_id: string;
  /* These are the values the ENGINE STORES, verified in production over 11.8M
     action rows on 2026-08-23. This union previously read `'all-in'` while
     every row says `all_in`, and the mapper below cast straight through it, so
     the type was a lie the compiler happily enforced against nobody: anyone
     writing `a.action === 'all-in'` got silence and a branch that never ran.
     `discard` (74,631 rows, draw and pineapple games) was missing outright. */
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | 'discard';
  amount?: number;
  /** Stored as `stage`. `pineapple_discard` is a real street here. */
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'pineapple_discard';
  timestamp: number;
}

/** One winner of one pot, as stored. */
export interface HandWinner {
  user_id: string;
  /** Chips taken from the pot. NOT the player's net result. */
  amount: number;
  /** Potindex 0 is the main pot; higher indices are side pots. */
  pot_index: number;
  hand_name?: string;
}

export interface HandRecord {
  id: string;
  serial_number: string;
  table_id: string;
  table_name: string;
  played_at: string;
  hand_number: number;
  total_hands: number;
  main_pot: number;
  side_pots: number[];
  community_cards: Card[];
  /** Round 2 (double board): board 2, empty on single-board hands. */
  community_cards2?: Card[];
  players: HandPlayer[];
  actions: HandAction[];
  /* Real per-winner amounts. Consumers used to reconstruct these by dividing
     main_pot by the number of winners, which is wrong on every split pot and
     on every hand with a side pot — and it was presented to the recipient of a
     shared hand as fact. The row has always carried the true figure. */
  winners: HandWinner[];
  game_type: string;
  stakes: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class HandHistoryServiceClass {
  /**
   * Get a single hand by ID.
   *
   * Round 38 RE-RUN fix: previously queried `hands` (0 rows in prod) with a
   * nested join to `hand_players` and `hand_actions` (also 0 rows each). Result:
   * every call returned null, so the entire hand-replay feature (HandReplay
   * component + HandReplayerPage) was dead in production. Same root cause as
   * BUG 021 FIX in getPlayerHands.
   *
   * Fix: query `hand_history` (5.15M rows, the canonical store), use the
   * existing mapHandHistoryRow mapper, and resolve profile names from the
   * JSONB `players` array.
   */
  async getHand(handId: string): Promise<HandRecord | null> {
    const { data, error } = await supabase
      .from('hand_history')
      .select(
        'id, created_at, table_id, hand_number, pot_size, community_cards, community_cards2, players, actions, winners, game_variant, small_blind, big_blind, rake_amount, hole_cards'
      )
      .eq('id', handId)
      .maybeSingle();

    if (error || !data) {
      if (error) reportError(error, 'HandHistoryService.getHand_query');
      return null;
    }

    const userIds: string[] = [];
    for (const p of (data as any).players || []) if (p?.userId) userIds.push(p.userId);
    for (const w of (data as any).winners || []) if (w?.userId) userIds.push(w.userId);
    const profileMap = await this.fetchProfileMap(userIds);

    // Pass empty string for requestingUserId — getHand by ID is a public
    // replay use case so no per-viewer hole-card hiding (cards remain hidden
    // for non-winners by the mapper anyway).
    return this.mapHandHistoryRow(data, '', profileMap);
  }

  /**
   * Get hands for a player.
   *
   * BUG 021 FIX (2026-04-15): previously queried `hand_players` table (EMPTY — 0 rows) with a
   * nested join to `hands` (also empty). The canonical hand history store is `hand_history`
   * (5.1M rows in prod) with JSONB columns `players`, `actions`, `winners`. Rewrote to filter
   * by players JSONB containing the requested userId, then map JSONB → HandRecord inline.
   */
  async getPlayerHands(userId: string, limit = 50): Promise<HandRecord[]> {
    // BUG 021 Layer D (2026-04-16): Supabase JS `.contains('column', [{key: val}])` serializes
    // the object literal with unquoted keys, producing invalid JSON in PostgREST. Symptom:
    //   {"code":"22P02","details":"Expected string or '}', but found '['","message":"invalid input syntax for type json"}
    // Fix: pass a pre-stringified JSON string, which Supabase JS URL-encodes verbatim.
    const containmentJson = JSON.stringify([{ userId }]);
    const { data, error } = await supabase
      .from('hand_history')
      .select(
        'id, created_at, table_id, hand_number, pot_size, community_cards, players, actions, winners, game_variant, small_blind, big_blind, rake_amount, hole_cards'
      )
      .contains('players', containmentJson)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) {
      if (error) reportError(error, 'HandHistoryService.getPlayerHands_hand_history_query');
      return [];
    }

    // Collect all user ids across all hands, including winners — needed to resolve display names
    const allUserIds: string[] = [];
    for (const row of data as any[]) {
      for (const p of row.players || []) if (p?.userId) allUserIds.push(p.userId);
      for (const w of row.winners || []) if (w?.userId) allUserIds.push(w.userId);
    }
    const profileMap = await this.fetchProfileMap(allUserIds);

    return data
      .map((d: any) => this.mapHandHistoryRow(d, userId, profileMap))
      .filter((h: HandRecord | null): h is HandRecord => h !== null);
  }

  // Round 38 RE-RUN cleanup: deleted 3 dead methods that queried the empty
  // `hands` / `hand_players` tables and had ZERO callers in the codebase:
  //   - getTableHands(tableId)
  //   - getRecentWinningHands(userId)
  //   - searchHands(filters)
  // If any of these features is wanted later, re-add via hand_history +
  // mapHandHistoryRow (the canonical pattern used by getPlayerHands and getHand).

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * BUG 021 FIX — map a row from `hand_history` (the canonical prod source) to a HandRecord.
   * hand_history stores players + actions + winners as JSONB with camelCase keys
   * (userId, not user_id). We compute result per hand by looking up the player in winners[]
   * and subtracting their total invested from actions[].
   */
  private mapHandHistoryRow(
    row: any,
    requestingUserId: string,
    profileMap: Map<string, { username: string; avatar_url: string | null }>
  ): HandRecord | null {
    if (!row?.id) return null;
    const jsonbPlayers: any[] = Array.isArray(row.players) ? row.players : [];
    const jsonbActions: any[] = Array.isArray(row.actions) ? row.actions : [];
    const jsonbWinners: any[] = Array.isArray(row.winners) ? row.winners : [];

    // Compute per-player result: winnings from winners[] minus total amount bet in actions[]
    const buildResult = (userId: string): number => {
      const invested = jsonbActions
        .filter((a) => a?.userId === userId && typeof a?.amount === 'number' && a.amount > 0)
        .reduce((sum, a) => sum + Number(a.amount), 0);
      const won = jsonbWinners
        .filter((w) => w?.userId === userId && typeof w?.amount === 'number')
        .reduce((sum, w) => sum + Number(w.amount), 0);
      return Math.round((won - invested) * 100) / 100;
    };

    const buttonSeat = (jsonbPlayers.find((p) => p?.isButton)?.seat as number | undefined) ?? 1;
    const playerCount = jsonbPlayers.length || 1;

    /* The hand's hole cards live in their own JSONB column, keyed by user id:
       { "<uuid>": [{ rank: 'A', suit: 'spades' }, ...] }. See the server's
       handHistory.ts `hole_cards: holeCardsPayload`. */
    const holeCardsByUser: Record<string, unknown[]> =
      row && typeof (row as any).hole_cards === 'object' && (row as any).hole_cards
        ? ((row as any).hole_cards as Record<string, unknown[]>)
        : {};

    const players: HandPlayer[] = jsonbPlayers.map((p: any): HandPlayer => {
      const uid: string = p?.userId || '';
      const profile = profileMap.get(uid);
      const isMe = uid === requestingUserId;
      const isWinner = jsonbWinners.some((w) => w?.userId === uid);
      return {
        seat: Number(p?.seat) || 0,
        user_id: uid,
        username: profile?.username || p?.username || (uid ? uid.slice(0, 8) : 'Unknown'),
        avatar_url: profile?.avatar_url || null,
        position: this.getPositionName(Number(p?.seat) || 0, buttonSeat, playerCount),
        // Only reveal hole cards if it's the requesting user OR cards are already exposed in the JSONB
        /* 2026-08-23: this read `players[].cards`, which is `[]` on every row
           in production — the engine writes hole cards to a SEPARATE
           `hole_cards` column, an object keyed by user id, and that column was
           not even in the select above. So no hand in history has ever shown a
           hole card to anybody; the showdown row rendered two grey backs.
           Prefer the real column, keep the old field as the fallback, and hold
           the same reveal rule (your own hand, or a hand that got shown). */
        hole_cards:
          isMe || isWinner
            ? Array.isArray(holeCardsByUser[uid]) && holeCardsByUser[uid].length
              ? holeCardsByUser[uid]
              : Array.isArray(p?.cards)
                ? p.cards
                : []
            : [],
        final_hand: jsonbWinners.find((w) => w?.userId === uid)?.hand?.name || undefined,
        result: buildResult(uid),
        is_winner: isWinner,
      };
    });

    const actions: HandAction[] = jsonbActions.map(
      (a: any): HandAction => ({
        player_id: a?.userId || '',
        action: (a?.action as HandAction['action']) || 'fold',
        amount: typeof a?.amount === 'number' ? a.amount : undefined,
        street: (a?.stage as HandAction['street']) || 'preflop',
        timestamp:
          typeof a?.timestamp === 'number' ? a.timestamp : new Date(row.created_at).getTime(),
      })
    );

    const winners: HandWinner[] = jsonbWinners.map((w: any) => ({
      user_id: w?.userId || '',
      amount: typeof w?.amount === 'number' ? w.amount : Number(w?.amount) || 0,
      pot_index: typeof w?.potIndex === 'number' ? w.potIndex : 0,
      hand_name: typeof w?.hand?.name === 'string' ? w.hand.name : undefined,
    }));

    const sb = Number(row.small_blind) || 0;
    const bb = Number(row.big_blind) || 0;
    const stakes = sb > 0 && bb > 0 ? `${sb}/${bb}` : '1/2';

    return {
      id: row.id,
      serial_number: row.id,
      table_id: row.table_id,
      table_name: 'Table',
      played_at: row.created_at,
      hand_number: Number(row.hand_number) || 1,
      total_hands: 1,
      main_pot: Number(row.pot_size) || 0,
      side_pots: [],
      community_cards: Array.isArray(row.community_cards) ? row.community_cards : [],
      community_cards2: Array.isArray((row as any).community_cards2)
        ? (row as any).community_cards2
        : [],
      players,
      actions,
      winners,
      game_type: (row.game_variant || 'nlh').toUpperCase(),
      stakes,
    };
  }

  // Round 38 RE-RUN cleanup: deleted private mapHandRecord(HandDB) — only
  // consumer was the now-deleted dead methods (getTableHands /
  // getRecentWinningHands / searchHands). The active mapper is
  // mapHandHistoryRow above.

  /**
   * Batch-fetch profiles for a list of user_ids
   */
  private async fetchProfileMap(
    userIds: string[]
  ): Promise<Map<string, { username: string; avatar_url: string | null }>> {
    const map = new Map<string, { username: string; avatar_url: string | null }>();
    if (userIds.length === 0) return map;

    try {
      const unique = [...new Set(userIds)];
      const { data } = await supabase
        .from('profiles')
        .select('id, username, avatar_url:arena_avatar_url')
        .in('id', unique);

      for (const p of data || []) {
        map.set(p.id, { username: p.username, avatar_url: p.avatar_url });
      }
    } catch (err: unknown) {
      reportError(err, 'HandHistoryService.fetchProfileMap');
      // Non-critical — names will fall back to truncated user_id
    }

    return map;
  }

  private getPositionName(
    seat: number,
    buttonSeat: number,
    playerCount: number
  ): 'UTG' | 'UTG+1' | 'UTG+2' | 'MP' | 'MP+1' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB' {
    // Calculate position relative to button
    const positions = this.getPositionOrder(playerCount);
    const relativePos = (seat - buttonSeat + playerCount) % playerCount;
    return positions[relativePos] || 'MP';
  }

  /**
   * Save a completed hand to Supabase for cross-device persistence and admin review.
   * Fire-and-forget — localStorage is the primary real-time store.
   */
  async saveHandToSupabase(
    tableId: string,
    handData: {
      handNumber: number;
      pot: number;
      communityCards: Array<{ rank: string; suit: string }>;
      players: Array<{
        id: string;
        name: string;
        seat: number;
        stack: number;
        holeCards?: Array<{ rank: string; suit: string }>;
        isWinner?: boolean;
        result?: number;
      }>;
      actions: Array<{
        seat: number;
        action: string;
        amount?: number;
        street: string;
      }>;
      winners: Array<{
        playerId: string;
        amount: number;
        hand?: string;
      }>;
    }
  ): Promise<void> {
    try {
      // 1. Insert the hand record
      const { data: handRecord, error: handErr } = await supabase
        .from('hands')
        .insert({
          table_id: tableId,
          hand_number: handData.handNumber,
          pot_size: handData.pot,
          community_cards: handData.communityCards,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (handErr || !handRecord) {
        console.debug('[HandHistory] Failed to save hand:', handErr?.message);
        return;
      }

      const handId = handRecord.id;

      // 2. Insert hand_players
      const playerRows = handData.players.map((p) => ({
        hand_id: handId,
        user_id: p.id,
        seat: p.seat,
        hole_cards: p.holeCards || [],
        result: p.result || 0,
        is_winner: handData.winners.some((w) => w.playerId === p.id),
        final_hand: handData.winners.find((w) => w.playerId === p.id)?.hand || null,
      }));

      if (playerRows.length > 0) {
        await supabase.from('hand_players').insert(playerRows);
      }

      // 3. Insert hand_actions
      const actionRows = handData.actions.map((a, idx) => {
        const player = handData.players.find((p) => p.seat === a.seat);
        return {
          hand_id: handId,
          player_id: player?.id || '',
          action: a.action,
          amount: a.amount || 0,
          street: a.street,
          created_at: new Date(Date.now() + idx).toISOString(), // Preserve ordering
        };
      });

      if (actionRows.length > 0) {
        await supabase.from('hand_actions').insert(actionRows);
      }

      console.debug(`[HandHistory] Saved hand #${handData.handNumber} to Supabase (id: ${handId})`);
    } catch (err: unknown) {
      // Non-critical — localStorage is the primary store
      reportError(err, 'HandHistoryService.saveHandToSupabase');
    }
  }

  private getPositionOrder(
    playerCount: number
  ): ('BTN' | 'SB' | 'BB' | 'UTG' | 'UTG+1' | 'UTG+2' | 'MP' | 'MP+1' | 'HJ' | 'CO')[] {
    if (playerCount <= 2) return ['BTN', 'BB'];
    if (playerCount <= 3) return ['BTN', 'SB', 'BB'];
    if (playerCount <= 6) return ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'];
    return ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'MP+1', 'HJ', 'CO'];
  }
}

export const handHistoryService = new HandHistoryServiceClass();
export const HandHistoryService = handHistoryService;
export default handHistoryService;
