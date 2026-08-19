/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SERVER TABLE ENGINE — Server-Side Dealer for a Single Table
 * ═══════════════════════════════════════════════════════════════════════════════
 * Runs the complete dealing pipeline for one table on the SERVER.
 * NO browser. NO React. NO window. Pure Node.js.
 *
 * - Loads table config, seated players, and horses from Supabase
 * - Manages HandController lifecycle
 * - Executes horse AI decisions with millisecond-level think times
 * - Auto-rebuys busted horses from Player Wallet
 * - Broadcasts hand state via Supabase Realtime
 * - Multiple instances run simultaneously (one per table)
 */

/**
 * ServerTableEngine, layer 8/8 — state broadcast and public state snapshots.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import * as EngineMetrics from '../observability/engineInstruments.js';
import { ServerTableEngineHandEvents } from './ServerTableEngineHandEvents.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER TABLE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export class ServerTableEngine extends ServerTableEngineHandEvents {
  // ═════════════════════════════════════════════════════════════════════════════
  // Bible V8 §6.15: OBSERVER PERMISSIONS
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * GET /state/:tableId for observers — Bible V8 §6.15: Scrubbed state with no hole cards.
   * Observers see community cards, pot, actions, but NEVER other players' hole cards.
   */
  public getObserverState(): Record<string, any> | null {
    if (!this.handController || !this.tableInfo) return null;
    const state = this.handController.getState();
    const showCards = this.tableInfo.observer_show_cards ?? false;
    return {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: state.pot ?? 0,
      community_cards: state.communityCards ?? [],
      current_bet: state.currentBet ?? 0,
      stage: state.stage ?? 'preflop',
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      players: state.players.map((p) => ({
        seat: p.seat,
        user_id: p.user_id,
        username: p.username,
        stack: p.stack,
        bet: p.bet,
        is_folded: p.is_folded,
        is_all_in: p.is_all_in,
        position: p.position,
        // Bible V8 §6.15: Only show cards if table allows AND it's showdown
        cards: showCards && state.stage === 'showdown' ? p.cards : [],
      })),
      is_observer: true,
      admin_paused: this.adminPauseLock,
      maintenance_lock: this.maintenanceLock,
    };
  }

  /**
   * GET /state/:tableId — Bible V8 §2.4: Get current hand state (scrubbed for requesting player)
   */
  public getTableState(requestingUserId: string): Record<string, any> | null {
    if (!this.handController || !this.tableInfo) return null;

    const state = this.handController.getState();
    const currentSeatPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);

    return {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: state.pot ?? 0,
      community_cards: state.communityCards ?? [],
      current_bet: state.currentBet ?? 0,
      current_player: currentSeatPlayer?.user_id ?? null,
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      stage: state.stage ?? 'preflop',
      min_raise: state.minRaise ?? 0,
      last_raise: state.lastRaise ?? 0,
      // Bible V8 §2.4: Timer fields required for client-side countdown
      turn_start_time_ms: this.playerTurnStartTime,
      turn_duration_ms: this.playerTurnDuration * 1000, // Convert seconds → milliseconds
      pots: (state.pots ?? []).map((p) => ({
        amount: p.amount,
        eligible: p.eligiblePlayers ?? [],
      })),
      // Bible V8 §2.5: Action Record — seat, userId, action, amount, timestamp, stage
      action_history: (state.actionHistory ?? []).map((a) => ({
        seat: a.seat,
        userId: a.userId ?? '',
        action: a.action,
        amount: a.amount,
        timestamp: a.timestamp ?? 0,
        stage: a.stage,
      })),
      players: (() => {
        const positionLabels = this.getPositionLabels(
          state.dealerSeat ?? this.currentHandDealerSeat,
          state.players ?? []
        );
        return (state.players ?? []).map((p) => {
          let showCards = false;
          if (p.user_id === requestingUserId) {
            showCards = true;
          } else if (state.stage === 'showdown' && !p.is_folded) {
            const isWinner = this.currentHandWinnerIds.includes(p.user_id);
            const voluntarilyShowing = this.showHandPlayers?.has(p.user_id) ?? false;
            const autoMuckEnabled = this.tableInfo?.auto_muck_enabled ?? true;
            showCards = isWinner || voluntarilyShowing || !autoMuckEnabled;
          }
          return {
            seat: p.seat,
            user_id: p.user_id,
            username: p.username,
            stack: p.stack,
            bet: p.bet ?? 0,
            totalInvested: p.totalInvested ?? 0,
            cards: showCards ? (p.cards ?? []) : [],
            is_folded: p.is_folded ?? false,
            is_all_in: p.is_all_in ?? false,
            is_sitting_out: p.is_sitting_out ?? false,
            is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id),
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
            position: positionLabels.get(p.seat) ?? '',
            avatar_url: p.avatar_url ?? '', // Bible V8 §2.3
            is_horse: p.is_horse ?? false, // Bible V8 §2.3
          };
        });
      })(),
    };
  }

  /**
   * Broadcast current hand state to all table viewers.
   * FIX-217: Now returns Promise so critical paths can await delivery.
   * Bible V8 §1.2.3: "Broadcast must confirm before next turn begins"
   */
  protected broadcastCurrentState(): Promise<void> {
    if (!this.handController || !this.tableInfo) return Promise.resolve();

    // ── ADDITIVE observability (#5): observe action→broadcast latency (cheap, always) ──
    if (this.lastActionAcceptedAtMs > 0) {
      try {
        EngineMetrics.actToBroadcastLatency.observe(Date.now() - this.lastActionAcceptedAtMs, {
          table_id: this.tableId,
        });
      } catch {
        /* metrics must never affect gameplay */
      }
      this.lastActionAcceptedAtMs = 0;
    }

    const state = this.handController.getState();
    const currentSeatPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);

    // Phase 1.1 PR-2: Build the payload once, publish to both the authoritative
    // WebSocket hub (direct to browser) AND the legacy Supabase Realtime
    // channel. PR-5 removes the Supabase leg once WS is verified in prod.
    const payload = {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: state.pot ?? 0,
      community_cards: state.communityCards ?? [],
      current_bet: state.currentBet ?? 0,
      current_player: currentSeatPlayer?.user_id ?? null,
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      stage: state.stage ?? 'preflop',
      // Bible V8 §5.1: Winner IDs for client-side winner highlighting + sound
      winner_ids: this.currentHandWinnerIds.length > 0 ? this.currentHandWinnerIds : [],
      // Bible V8 §2.7: Winner amounts for pot distribution display
      winners: this.currentHandWinners.length > 0 ? this.currentHandWinners : [],
      // Bible V8 §2.4: Required betting state fields
      min_raise: state.minRaise ?? 0,
      last_raise: state.lastRaise ?? 0,
      turn_start_time_ms: this.playerTurnStartTime,
      turn_duration_ms: this.playerTurnDuration * 1000, // Convert seconds → milliseconds
      // Phase 1.2 PR-F: absolute wall-clock deadline. Client reads this
      // directly rather than computing start+duration locally, eliminating
      // client/server clock skew for the countdown.
      turn_deadline_ms:
        this.playerTurnStartTime > 0
          ? this.playerTurnStartTime + this.playerTurnDuration * 1000
          : 0,
      // Phase 1.2 PR-F: per-user disconnect FSM map for client UI toasts
      // (MISSING / DISCONNECTED). Same shape the DB stores.
      disconnect_states: this.disconnectEngine.getFsmStatesForTable(this.tableId),
      // Bible V8 §4.2 — Wait-for-BB user-id list. Walkthrough Step 4 fix
      // 2026-04-29. Players who joined mid-hand are flagged here until the
      // BB rotates to them OR they call POST /post-bb. Frontend reads this
      // to render the "Post BB to enter" button on the hero seat.
      waiting_for_bb_user_ids: Array.from(this.waitingForBB),
      // Bible V8 §2.4: Side pot information for multi-way all-ins
      pots: (state.pots ?? []).map((p) => ({
        amount: p.amount,
        eligible: p.eligiblePlayers ?? [],
      })),
      // Bible V8 §2.4: Action history for the current hand
      // Bible V8 §2.5: Action Record — seat, userId, action, amount, timestamp, stage
      action_history: (state.actionHistory ?? []).map((a) => ({
        seat: a.seat,
        userId: a.userId ?? '',
        action: a.action,
        amount: a.amount,
        timestamp: a.timestamp ?? 0,
        stage: a.stage,
      })),
      // Bible V8 §2.3: Complete player objects with all required fields
      // CARD SECURITY: Scrub hole cards from public broadcast.
      // Players receive their own cards via RLS-protected table_hole_cards channel.
      // Bible V8 §4.21: Auto-muck — at showdown, only show:
      //   - Winners (must always show)
      //   - Players who voluntarily chose to show (showHandPlayers set)
      //   - All non-folded players if auto_muck is DISABLED
      players: (() => {
        const positionLabels = this.getPositionLabels(
          state.dealerSeat ?? this.currentHandDealerSeat,
          state.players ?? []
        );
        return (state.players ?? []).map((p) => {
          // ── Dan 2026-08-18: at showdown every hand still in it is face up ──
          //
          // This is the path that actually puts opponents' cards on the table:
          // mapEngineSnapshot turns `cards` into the seat's holeCards. (The
          // separate `showdown_cards_revealed` event is re-emitted onto
          // MasterBus by TablePage but has no subscriber, so it renders
          // nothing - this snapshot is the whole story.)
          //
          // It used to apply the auto-muck gate: winner, or voluntary shower,
          // or auto_muck disabled. Every one of the 56,052 tables has
          // auto_muck_enabled true, so only the winner's cards were ever sent.
          // Measured over 10,165 hands that reached a full five-card board:
          // 1.08 holdings shown on average.
          //
          // The `!p.is_folded` guard is what keeps this safe and it stays. A
          // player who folded is never included, so a fold is never exposed;
          // only players who took the hand to showdown are turned over.
          const showCards = state.stage === 'showdown' && !p.is_folded;
          return {
            seat: p.seat,
            user_id: p.user_id,
            username: p.username,
            stack: p.stack,
            bet: p.bet ?? 0,
            totalInvested: p.totalInvested ?? 0, // Bible V8 §2.3
            cards: showCards ? (p.cards ?? []) : [],
            is_folded: p.is_folded ?? false,
            is_all_in: p.is_all_in ?? false,
            is_sitting_out: p.is_sitting_out ?? false,
            is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id), // Bible V8 §2.3
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id), // Bible V8 §2.3
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id), // Bible V8 §2.3
            position: positionLabels.get(p.seat) ?? '', // Bible V8 §2.3, Appendix B
            avatar_url: p.avatar_url ?? '', // Bible V8 §2.3
            is_horse: p.is_horse ?? false, // Bible V8 §2.3
            // Bible V8 §4.2 — Wait-for-BB flag exposed to clients so the
            // post-BB UI button can render. Walkthrough Step 4 fix
            // 2026-04-29: previously the engine tracked this internally but
            // never published it; frontend had no way to know the player was
            // waiting and no way to call POST /post-bb to skip the wait.
            is_waiting_for_bb: this.waitingForBB.has(p.user_id),
            // Bible V8 §5.1 + §2.7: Hand name at showdown for winner label display
            hand_name: showCards
              ? (this.currentHandShowdownResults.find((r) => r.userId === p.user_id)?.handName ??
                '')
              : '',
          };
        });
      })(),
    };

    // Phase 1.1 PR-5: Publish ONLY to the authoritative WebSocket hub.
    // The legacy Supabase Realtime broadcast path has been deleted.
    // All game-state delivery now flows through the native WS hub.
    if (this.hub) {
      this.hub.publish(this.tableId, payload);
    } else {
      console.warn(
        `[ServerTableEngine:${this.tableId}] No hub attached — state not delivered to clients`
      );
    }
    return Promise.resolve();
  }
}
