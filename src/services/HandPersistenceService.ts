/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND PERSISTENCE SERVICE — Persists HandController events to database
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE:
 * Each table gets its OWN HandPersistence instance (created by HeadlessTableEngine).
 *
 * CRITICAL: All events are serialized through a promise queue. This prevents
 * the race condition where HAND_START for hand N+1 fires before the DB insert
 * for hand N returns. Without serialization, 62% of hands were getting stuck
 * as "active/preflop" because the completion update was lost.
 *
 * Event flow: HandController → onEvent callback → eventQueue → handleEvent
 * Each event waits for the previous event to fully resolve before processing.
 */

import { supabase } from '../lib/supabase';
import type { HandController, HandEvent } from '../engine/HandController';

interface HandRecord {
  id?: string;
  table_id: string;
  club_id: string;
  hand_number: number;
  game_variant: string;
  stakes: string;
  pot: number;
  rake: number;
  community_cards: string[];
  winner_ids: string[];
  players: Record<string, unknown>;
  actions: Record<string, unknown>[];
  started_at: string;
  ended_at?: string;
}

export interface PersistenceConfig {
  tableId: string;
  clubId: string;
  stakes: string;
  gameVariant: 'nlh' | 'plo4' | 'plo5' | 'plo6';
  smallBlind?: number;
  bigBlind?: number;
  ante?: number;
  dealerSeat?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-TABLE HAND PERSISTENCE (used by HeadlessTableEngine)
// ═══════════════════════════════════════════════════════════════════════════════

export class HandPersistence {
  private currentHand: HandRecord | null = null;
  private handActions: Record<string, unknown>[] = [];
  private handWinners: { userId: string; amount: number }[] = [];
  private unsubscribe: (() => void) | null = null;
  private tableId: string;

  /**
   * Promise chain that serializes all event processing.
   * Every event handler appends to this chain so they execute one at a time.
   * This prevents HAND_START(N+1) from running before HAND_COMPLETE(N) + DB insert finish.
   */
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(tableId: string) {
    this.tableId = tableId;
  }

  /**
   * Clean up orphaned "active" hands for this table from a previous session.
   * These are hands that were inserted but never completed (engine crashed/reloaded).
   * Mark them as 'aborted' so they don't pollute hand history queries.
   */
  async cleanupOrphanedHands(): Promise<void> {
    try {
      // Only clean up recent orphans (last 24 hours) to avoid timeout on massive tables
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { error, count } = await supabase
        .from('hands')
        .update({ status: 'completed', ended_at: new Date().toISOString(), street: 'aborted' })
        .eq('table_id', this.tableId)
        .eq('status', 'active')
        .gt('started_at', oneDayAgo)
        .lt('started_at', tenMinutesAgo);

      if (error) {
        // Silently ignore — this is best-effort cleanup
      } else if (count && count > 0) {
        console.debug(
          `[HandPersistence:${this.tableId}] Cleaned up ${count} orphaned active hands`
        );
      }
    } catch (err) {
      console.error('[HandPersistenceService] Error:', err);
      // Silently ignore — cleanup is non-critical
    }
  }

  /**
   * Wire a HandController to persist its events to the database
   */
  wireToHandController(controller: HandController, config: PersistenceConfig): () => void {
    // Clean up previous subscription (same table, new hand)
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Subscribe to all hand events — queue them for serial processing
    this.unsubscribe = controller.onEvent((event: HandEvent) => {
      this.enqueueEvent(event, config);
    });

    return () => {
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    };
  }

  /** Get the current persisted hand UUID (if available) */
  getCurrentHandId(): string | null {
    return this.currentHand?.id || null;
  }

  /** Clean up when engine stops */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.currentHand = null;
    this.handActions = [];
    this.handWinners = [];
  }

  /**
   * Enqueue an event for serial processing.
   * Each event waits for the previous one to complete before executing.
   * This is the KEY fix — without this, async events (DB inserts) would
   * interleave and corrupt state.
   */
  private enqueueEvent(event: HandEvent, config: PersistenceConfig): void {
    this.eventQueue = this.eventQueue.then(async () => {
      try {
        await this.handleEvent(event, config);
      } catch (err: unknown) {
        console.error(
          `[HandPersistence:${this.tableId}] Event handler error for ${event.type}:`,
          err
        );
      }
    });
  }

  private async handleEvent(event: HandEvent, config: PersistenceConfig): Promise<void> {
    switch (event.type) {
      case 'HAND_START':
        await this.onHandStart(event.handNumber, event.players, config);
        break;
      case 'PLAYER_ACTION':
        this.onPlayerAction(event.seat, event.action, event.amount);
        break;
      case 'COMMUNITY_CARDS':
        this.onCommunityCards(event.cards, (event as any).stage);
        break;
      case 'HAND_COMPLETE':
        await this.onHandComplete(event.handNumber, event.rake);
        break;
      case 'WINNERS':
        this.onWinners(event.winners);
        break;
      case 'POT_UPDATE':
        this.onPotUpdate(event.pot);
        break;
      default:
        break;
    }
  }

  private async onHandStart(
    handNumber: number,
    players: { seat: number; user_id: string; username: string; stack: number }[],
    config: PersistenceConfig
  ): Promise<void> {
    // Guard: if a previous hand is still in progress, finalize it first.
    // With serialized events this should be rare, but handle it defensively.
    if (this.currentHand) {
      console.error(
        `[HandPersistence:${this.tableId}] Previous hand #${this.currentHand.hand_number} still open — finalizing before hand #${handNumber}`
      );
      await this.onHandComplete(this.currentHand.hand_number, 0);
    }

    // Initialize hand record
    this.currentHand = {
      table_id: config.tableId,
      club_id: config.clubId,
      hand_number: handNumber,
      game_variant: config.gameVariant,
      stakes: config.stakes,
      pot: 0,
      rake: 0,
      community_cards: [],
      winner_ids: [],
      players: Object.fromEntries(
        players.map((p) => [p.user_id, { seat: p.seat, username: p.username, stack: p.stack }])
      ),
      actions: [],
      started_at: new Date().toISOString(),
    };
    this.handActions = [];
    this.handWinners = [];

    // Insert initial hand record — since events are serialized,
    // no other event can run until this insert completes.
    // MUST match actual DB columns exactly — no extra columns allowed
    // Actual columns: id, table_id, club_id, hand_number, game_variant, stakes,
    // pot, rake, community_cards, board, winner_ids, players, actions,
    // current_player_id, player_cards, player_bets, current_bet, min_raise,
    // street, status, dealer_position, started_at, ended_at, created_at
    const insertPayload: Record<string, unknown> = {
      table_id: this.currentHand.table_id,
      club_id: this.currentHand.club_id,
      hand_number: this.currentHand.hand_number,
      game_variant: this.currentHand.game_variant,
      stakes: this.currentHand.stakes,
      dealer_position: config.dealerSeat || 0,
      pot: 0,
      rake: 0,
      community_cards: [] as string[],
      board: null,
      winner_ids: [] as string[],
      status: 'active',
      street: 'preflop',
      current_bet: 0,
      min_raise: 0,
      players: this.currentHand.players,
      actions: [] as Record<string, unknown>[],
      started_at: this.currentHand.started_at,
    };

    const { data, error } = await supabase
      .from('hands')
      .insert(insertPayload)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error(
        `[HandPersistence:${this.tableId}] Failed to insert hand #${handNumber}:`,
        error
      );
      // Retry once
      try {
        const { data: retryData, error: retryError } = await supabase
          .from('hands')
          .insert(insertPayload)
          .select('id')
          .maybeSingle();

        if (!retryError && retryData) {
          if (this.currentHand) this.currentHand.id = retryData.id;
        } else {
          console.error(`[HandPersistence:${this.tableId}] Retry also failed:`, retryError);
          // Mark as local-only so we don't try to update a non-existent DB row
          if (this.currentHand) {
            this.currentHand.id = crypto.randomUUID();
            (this.currentHand as any)._localOnly = true;
          }
        }
      } catch (e: unknown) {
        console.error(`[HandPersistence:${this.tableId}] Retry exception:`, e);
        if (this.currentHand) {
          this.currentHand.id = crypto.randomUUID();
          (this.currentHand as any)._localOnly = true;
        }
      }
    } else if (data && this.currentHand) {
      this.currentHand.id = data.id;
    }
  }

  private onPlayerAction(seat: number, action: string, amount: number): void {
    if (!this.currentHand) return;
    this.handActions.push({
      seat,
      action,
      amount: amount || 0,
      timestamp: new Date().toISOString(),
    });
  }

  private onCommunityCards(cards: { rank: string; suit: string }[], stage?: string): void {
    if (!this.currentHand) return;
    const formatted = cards.map((c) => `${c.rank}${c.suit[0]}`);
    this.currentHand.community_cards.push(...formatted);
    if (stage) {
      (this.currentHand as any)._currentStreet = stage;
    }
  }

  private onWinners(winners: { userId: string; amount: number }[]): void {
    if (!this.currentHand) return;
    this.currentHand.winner_ids = winners.map((w) => w.userId);
    this.handWinners = winners;
  }

  private onPotUpdate(pot: number): void {
    if (!this.currentHand) return;
    this.currentHand.pot = pot;
  }

  private async onHandComplete(handNumber: number, rake: number): Promise<void> {
    if (!this.currentHand) {
      console.error(
        `[HandPersistence:${this.tableId}] HAND_COMPLETE for #${handNumber} but no currentHand`
      );
      return;
    }

    const ccCount = this.currentHand.community_cards.length;
    const finalStreet =
      ccCount >= 5 ? 'river' : ccCount >= 4 ? 'turn' : ccCount >= 3 ? 'flop' : 'preflop';

    // With event serialization, the insert should always have completed by now.
    // But handle the edge case defensively.
    if (!this.currentHand.id) {
      console.error(
        `[HandPersistence:${this.tableId}] HAND_COMPLETE for #${handNumber} but no DB id — should not happen with serialization`
      );
      this.currentHand = null;
      this.handActions = [];
      return;
    }

    // Update the DB record with completion data
    if (!(this.currentHand as any)._localOnly) {
      const now = new Date().toISOString();
      const updatePayload = {
        pot: this.currentHand.pot,
        rake,
        community_cards: this.currentHand.community_cards,
        board:
          this.currentHand.community_cards.length > 0 ? this.currentHand.community_cards : null,
        winner_ids: this.currentHand.winner_ids,
        actions: this.handActions,
        status: 'completed',
        street: finalStreet,
        ended_at: now,
      };

      const { error } = await supabase
        .from('hands')
        .update(updatePayload)
        .eq('id', this.currentHand.id);

      if (error) {
        console.error(
          `[HandPersistence:${this.tableId}] Failed to update hand #${handNumber}: ${error.message || error.code || JSON.stringify(error)}`
        );
        // Retry once
        try {
          const { error: retryErr } = await supabase
            .from('hands')
            .update(updatePayload)
            .eq('id', this.currentHand.id);
          if (retryErr) {
            console.error(
              `[HandPersistence:${this.tableId}] Retry update also failed: ${retryErr.message || retryErr.code}`
            );
          }
        } catch (e: unknown) {
          console.error(`[HandPersistence:${this.tableId}] Retry update exception:`, e);
        }
      }
    }

    // ── Insert hand_players rows ──────────────────────────────────────────
    // Each player who was dealt into this hand gets a row for analytics/history
    if (!(this.currentHand as any)._localOnly && this.currentHand.id) {
      const handId = this.currentHand.id;
      const playersObj = this.currentHand.players as Record<
        string,
        { seat: number; username: string; stack: number }
      >;
      const winnerSet = new Set(this.currentHand.winner_ids);
      const winnerAmounts = new Map(this.handWinners.map((w) => [w.userId, w.amount]));

      const handPlayerRows = Object.entries(playersObj).map(([userId, info]) => {
        const isWinner = winnerSet.has(userId);
        const chipsWon = winnerAmounts.get(userId) || 0;
        // Find this player's actions from the recorded actions
        const playerActions = this.handActions.filter((a: any) => a.seat === info.seat);
        // Total invested is sum of all bet amounts from actions for this player
        const totalInvested = playerActions.reduce(
          (sum: number, a: any) => sum + (a.amount || 0),
          0
        );

        return {
          hand_id: handId,
          user_id: userId,
          seat_number: info.seat,
          hole_cards: [], // Cards are private — filled in separately if needed
          final_hand: null, // Best 5-card hand — computed post-showdown
          chips_won: isWinner ? chipsWon : 0,
          chips_lost: isWinner ? 0 : totalInvested,
          is_winner: isWinner,
          actions: playerActions,
        };
      });

      if (handPlayerRows.length > 0) {
        const { error: hpError } = await supabase.from('hand_players').insert(handPlayerRows);

        if (hpError) {
          console.error(
            `[HandPersistence:${this.tableId}] Failed to insert hand_players for hand #${handNumber}:`,
            hpError
          );
        }
      }

      // NOTE: rake_records insertion is handled by RakeService.executePotDrops()
      // in the executeRakeWaterfall flow (HeadlessTableEngine). Do NOT insert here
      // to avoid duplicate records and incorrect bbj_contribution (always 0 here).
    }

    // Reset state — ready for next hand
    this.currentHand = null;
    this.handActions = [];
    this.handWinners = [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY SINGLETON (kept for backward compatibility with TablePage)
// ═══════════════════════════════════════════════════════════════════════════════

class HandPersistenceServiceClass extends HandPersistence {
  constructor() {
    super('singleton');
  }

  /**
   * Load hand history for a table
   */
  async getTableHandHistory(tableId: string, limit = 20): Promise<HandRecord[]> {
    const { data, error } = await supabase
      .from('hands')
      .select(
        'id, table_id, club_id, hand_number, game_variant, stakes, pot, rake, community_cards, board, winner_ids, players, actions, street, status, dealer_position, started_at, ended_at, created_at'
      )
      .eq('table_id', tableId)
      .order('ended_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[HandPersistence] Failed to load hand history:', error);
      return [];
    }
    return data || [];
  }

  /**
   * Load hand history for a player
   */
  async getPlayerHandHistory(playerId: string, limit = 50): Promise<HandRecord[]> {
    const { data, error } = await supabase
      .from('hands')
      .select(
        'id, table_id, club_id, hand_number, game_variant, stakes, pot, rake, community_cards, board, winner_ids, players, actions, street, status, dealer_position, started_at, ended_at, created_at'
      )
      .contains('players', { [playerId]: {} })
      .order('ended_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[HandPersistence] Failed to load player hands:', error);
      return [];
    }
    return data || [];
  }
}

export const handPersistenceService = new HandPersistenceServiceClass();
export default handPersistenceService;
