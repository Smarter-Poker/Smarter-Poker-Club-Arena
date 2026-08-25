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
import { bettingStructureFor, fixedLimitBetSize, isFixedLimitCapped } from './BettingStructure.js';
import type { GameState } from '../types.js';

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
      community_cards2: state.communityCards2 ?? [],
      current_bet: state.currentBet ?? 0,
      stage: state.stage ?? 'preflop',
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      players: state.players.map((p) => ({
        seat: p.seat,
        user_id: p.user_id,
        ...this.seatIdentity(p),
        stack: p.stack,
        bet: p.bet,
        is_folded: p.is_folded,
        is_all_in: p.is_all_in,
        position: p.position,
        // Bible V8 §6.15: Only show cards if table allows AND it's showdown
        // SHOWDOWN SYSTEM 2026-08-25: mucked hands stay private from
        // observers too — same gate as the player-facing surfaces.
        cards:
          showCards &&
          state.stage === 'showdown' &&
          !p.is_folded &&
          !this.isMuckedAtShowdown(p.user_id)
            ? p.cards
            : [],
      })),
      is_observer: true,
      admin_paused: this.adminPauseLock,
      maintenance_lock: this.maintenanceLock,
    };
  }

  /**
   * The betting-structure fields every broadcast carries (2026-08-23).
   *
   * The client used to decide this for itself with
   * `gameType.startsWith('plo')`, which treats everything that is not PLO as
   * no-limit — so a fixed-limit table would have rendered a no-limit bet slider
   * and had every drag rejected by the server. And `wagers_capped` is not
   * derivable client-side at all: the cap counts FULL raises, and
   * `action_history` is broadcast with its `isFullRaise` flag stripped.
   *
   * No-limit and pot-limit tables carry `fixed_bet_size`/`wagers_capped` as
   * undefined, which JSON drops.
   */

  /**
   * ── ANONYMOUS TABLE (Dan 2026-08-25) ────────────────────────────────────
   *
   * `is_anonymous` has been a toggle on the creation screen since February,
   * read by nothing. Seat names shipped as real usernames with no branch that
   * could hide them.
   *
   * The identity a seat carries is exactly two fields: `username` and
   * `avatar_url`. `user_id` MUST survive — the client keys the hero seat,
   * `current_player`, `winner_ids`, `disconnect_states` and
   * `waiting_for_bb_user_ids` off it, and scrubbing it would break the table
   * rather than anonymise it. A user id is not a name on screen.
   *
   * UNIFORM, not per-viewer, and that is deliberate: broadcastCurrentState
   * publishes ONE payload through TableStateHub to every subscriber
   * ("public-scrubbed shape - so there is nothing per-subscriber to
   * serialize"). Making the hero an exception would mean a payload per seat.
   * At an anonymous table nobody's name is shown, including your own, and you
   * find yourself by seat exactly as you would at a live table.
   *
   * Called by all FOUR serializers. They are byte-identical seat maps and the
   * file already carries a comment about a reveal gate that was missed in one
   * of them; one helper is what stops that happening again.
   */
  protected seatIdentity(p: {
    seat?: number;
    seat_number?: number;
    username?: string;
    avatar_url?: string;
  }): {
    username: string;
    avatar_url: string;
  } {
    if (!this.tableInfo?.is_anonymous) {
      return { username: p.username ?? '', avatar_url: p.avatar_url ?? '' };
    }
    const seat = p.seat ?? p.seat_number ?? 0;
    return { username: seat > 0 ? `Player ${seat}` : 'Player', avatar_url: '' };
  }

  private bettingStructureFields(state: GameState): {
    betting_structure: 'no_limit' | 'pot_limit' | 'fixed_limit';
    fixed_bet_size?: number;
    wagers_capped?: boolean;
  } {
    const variant = this.tableInfo?.game_variant;
    const structure = bettingStructureFor(variant);
    if (structure !== 'fixed_limit') return { betting_structure: structure };
    const stage = state.stage ?? 'preflop';
    return {
      betting_structure: structure,
      fixed_bet_size: fixedLimitBetSize(this.tableInfo?.big_blind ?? 2, stage),
      wagers_capped: isFixedLimitCapped(state.actionHistory ?? [], stage),
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
      community_cards2: state.communityCards2 ?? [],
      bomb_pot_in:
        this.tableInfo?.bomb_pot_enabled && (this.tableInfo?.bomb_pot_frequency ?? 0) > 0
          ? Math.max(1, (this.tableInfo!.bomb_pot_frequency ?? 0) - this.handsSinceBombPot)
          : null,
      current_bet: state.currentBet ?? 0,
      current_player: currentSeatPlayer?.user_id ?? null,
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      stage: state.stage ?? 'preflop',
      min_raise: state.minRaise ?? 0,
      last_raise: state.lastRaise ?? 0,
      // 2026-08-23: publish the betting structure rather than leaving the
      // client to guess it from the variant string. `wagers_capped` in
      // particular is NOT derivable client-side — the cap counts full raises,
      // and action_history is broadcast without its isFullRaise flag.
      ...this.bettingStructureFields(state),
      // Bible V8 §2.4: Timer fields required for client-side countdown
      turn_start_time_ms: this.playerTurnStartTime,
      turn_duration_ms: this.playerTurnDuration * 1000, // Convert seconds → milliseconds
      // ── Dan 2026-08-18: "make sure the yellow countdown actually takes 15
      // seconds." The engine was already right - action_time_seconds is 15 on
      // every table and turn_deadline_ms follows from it - but the CLIENT
      // measured elapsed as `Date.now() - turn_start_time_ms`, mixing its own
      // clock with a server timestamp. A device clock a few seconds fast made
      // the ring start part-drained and finish early; a slow one made it
      // overrun. Publishing the server's own "now" lets the client measure
      // that offset and subtract it, so the ring reflects the real remaining
      // time regardless of what the device clock says.
      server_time_ms: Date.now(),
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
          } else if (
            state.stage === 'showdown' &&
            !p.is_folded &&
            !this.isMuckedAtShowdown(p.user_id)
          ) {
            // ── Dan 2026-08-18: the THIRD reveal gate, found on re-audit ──
            //
            // broadcastCurrentState was changed to turn every showdown hand
            // face up, but this one was missed. getTableState serves
            // GET /state/:tableId, which is what a client pulls on reconnect
            // or resync - so a player who dropped and came back mid-showdown
            // got the old auto-muck view and saw only the winner's cards,
            // disagreeing with what everyone still connected could see.
            //
            // Same guard, same safety: `!p.is_folded` above means a folded
            // hand is still never exposed.
            //
            // SHOWDOWN SYSTEM 2026-08-25: the muck gate applies on resync
            // too, or a reconnecting client would see cards the rest of the
            // table was never shown.
            showCards = true;
          }
          return {
            seat: p.seat,
            user_id: p.user_id,
            ...this.seatIdentity(p),
            stack: p.stack,
            bet: p.bet ?? 0,
            totalInvested: p.totalInvested ?? 0,
            cards: showCards ? (p.cards ?? []) : [],
            is_folded: p.is_folded ?? false,
            is_all_in: p.is_all_in ?? false,
            is_sitting_out: p.is_sitting_out ?? false,
            // SHOWDOWN SYSTEM 2026-08-25: resync parity with the broadcast.
            is_mucked:
              state.stage === 'showdown' && !p.is_folded && this.isMuckedAtShowdown(p.user_id),
            is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id),
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
            position: positionLabels.get(p.seat) ?? '',
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
    if (!this.tableInfo) return Promise.resolve();
    // IDLE BROADCAST (2026-08-22): this used to hard-return when
    // handController was null — which made the "clean state" publish at the
    // end of every hand a silent no-op, and meant an idle table (waiting for
    // players, between hands after a restart) never published ANY snapshot:
    // a client joining such a table connected successfully and then stared at
    // a spinner because no SNAPSHOT ever arrived. Publish a real idle payload
    // instead: seats from seatedPlayers, no board, no clock, stage 'waiting'
    // (a first-class stage in the client contract - mapEngineSnapshot).
    if (!this.handController) {
      this.publishIdleState();
      return Promise.resolve();
    }

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
      // DOUBLE-BOARD BOMB POT 2026-08-20: second board (empty unless active).
      community_cards2: state.communityCards2 ?? [],
      // ROUND 3 (2026-08-20): hands until the next bomb pot (1 = next hand).
      // null when the table doesn't run bomb pots. Drives the felt countdown.
      bomb_pot_in:
        this.tableInfo?.bomb_pot_enabled && (this.tableInfo?.bomb_pot_frequency ?? 0) > 0
          ? Math.max(1, (this.tableInfo!.bomb_pot_frequency ?? 0) - this.handsSinceBombPot)
          : null,
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
      // 2026-08-23: publish the betting structure rather than leaving the
      // client to guess it from the variant string. `wagers_capped` in
      // particular is NOT derivable client-side — the cap counts full raises,
      // and action_history is broadcast without its isFullRaise flag.
      ...this.bettingStructureFields(state),
      turn_start_time_ms: this.playerTurnStartTime,
      turn_duration_ms: this.playerTurnDuration * 1000, // Convert seconds → milliseconds
      // ── Dan 2026-08-18: "make sure the yellow countdown actually takes 15
      // seconds." The engine was already right - action_time_seconds is 15 on
      // every table and turn_deadline_ms follows from it - but the CLIENT
      // measured elapsed as `Date.now() - turn_start_time_ms`, mixing its own
      // clock with a server timestamp. A device clock a few seconds fast made
      // the ring start part-drained and finish early; a slow one made it
      // overrun. Publishing the server's own "now" lets the client measure
      // that offset and subtract it, so the ring reflects the real remaining
      // time regardless of what the device clock says.
      server_time_ms: Date.now(),
      // Phase 1.2 PR-F: absolute wall-clock deadline. Client reads this
      // directly rather than computing start+duration locally, eliminating
      // client/server clock skew for the countdown.
      turn_deadline_ms:
        this.playerTurnStartTime > 0
          ? this.playerTurnStartTime + this.playerTurnDuration * 1000
          : 0,
      time_bank_active: this.timeBankActivatedThisTurn,
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
          // ANIMATION AUDIT 2026-08-19: also reveal during an all-in runout
          // (runoutRevealActive) — betting is complete, hands are tabled, and
          // the paced runout is unwatchable with the cards still face down.
          // The `!p.is_folded` guard stays: a fold is never exposed.
          //
          // SHOWDOWN SYSTEM 2026-08-25 (Dan spec section 4): a hand the
          // engine ruled muckable stays face-down in the public snapshot too
          // — this is the path that actually puts cards on the felt, so
          // without this gate the muck was decoration. Voluntary shows
          // override (isMuckedAtShowdown returns false for them). All-in
          // showdowns never produce mucked=true, so runout reveals are
          // untouched.
          const muckedHere = this.isMuckedAtShowdown(p.user_id);
          const showCards =
            (state.stage === 'showdown' || this.runoutRevealActive) && !p.is_folded && !muckedHere;

          // ── Dan 2026-08-18: per-card voluntary reveal ──
          //
          // "a user should be able to click on any card in their hand, and
          //  when clicked that card or cards always get shown after the hand
          //  is over."
          //
          // A player who clicked individual cards gets those - and only those -
          // turned over once the hand is done, even if they folded and even if
          // the hand never reached showdown. That is the whole point: it is how
          // you show a bluff after taking the pot uncontested.
          //
          // Unpicked slots are sent as null rather than dropped, so the client
          // still knows how many cards were held and renders a back in the
          // gaps. A real showdown (showCards) already reveals everything, so
          // this branch only ever ADDS to what is visible.
          const picked = this.showHandCards?.get(p.user_id);
          const handIsOver = state.stage === 'showdown' || this.currentHandWinnerIds.length > 0;
          const partialReveal =
            !showCards && handIsOver && !!picked && picked.size > 0 && (p.cards?.length ?? 0) > 0;

          const cardsOut = showCards
            ? (p.cards ?? [])
            : partialReveal
              ? (p.cards ?? []).map((c, i) => (picked!.has(i) ? c : null))
              : [];

          return {
            seat: p.seat,
            user_id: p.user_id,
            ...this.seatIdentity(p),
            stack: p.stack,
            bet: p.bet ?? 0,
            totalInvested: p.totalInvested ?? 0, // Bible V8 §2.3
            cards: cardsOut,
            is_folded: p.is_folded ?? false,
            is_all_in: p.is_all_in ?? false,
            is_sitting_out: p.is_sitting_out ?? false,
            is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id), // Bible V8 §2.3
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id), // Bible V8 §2.3
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id), // Bible V8 §2.3
            position: positionLabels.get(p.seat) ?? '', // Bible V8 §2.3, Appendix B
            is_horse: p.is_horse ?? false, // Bible V8 §2.3
            // Bible V8 §4.2 — Wait-for-BB flag exposed to clients so the
            // post-BB UI button can render. Walkthrough Step 4 fix
            // 2026-04-29: previously the engine tracked this internally but
            // never published it; frontend had no way to know the player was
            // waiting and no way to call POST /post-bb to skip the wait.
            is_waiting_for_bb: this.waitingForBB.has(p.user_id),
            // SHOWDOWN SYSTEM 2026-08-25: engine-decided muck flag. The seat
            // renders a MUCKED label instead of cards; the hole cards and the
            // hand identity are withheld from every public surface.
            is_mucked: state.stage === 'showdown' && !p.is_folded && muckedHere,
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

  /**
   * IDLE BROADCAST (2026-08-22): the between-hands / no-hand snapshot.
   * Field-for-field the same contract as the live payload with idle values,
   * so mapEngineSnapshot needs no special casing beyond its existing
   * 'waiting' stage handling.
   */
  protected publishIdleState(): void {
    if (!this.hub || !this.tableInfo) return;
    const payload = {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: 0,
      community_cards: [],
      community_cards2: [],
      bomb_pot_in:
        this.tableInfo?.bomb_pot_enabled && (this.tableInfo?.bomb_pot_frequency ?? 0) > 0
          ? Math.max(1, (this.tableInfo!.bomb_pot_frequency ?? 0) - this.handsSinceBombPot)
          : null,
      current_bet: 0,
      current_player: null,
      dealer_seat: this.currentHandDealerSeat,
      stage: 'waiting',
      winner_ids: [],
      winners: [],
      min_raise: 0,
      last_raise: 0,
      turn_start_time_ms: 0,
      turn_duration_ms: 0,
      server_time_ms: Date.now(),
      turn_deadline_ms: 0,
      time_bank_active: false,
      disconnect_states: this.disconnectEngine.getFsmStatesForTable(this.tableId),
      waiting_for_bb_user_ids: Array.from(this.waitingForBB),
      pots: [],
      action_history: [],
      players: (this.seatedPlayers ?? []).map((p) => ({
        seat: p.seat_number,
        user_id: p.user_id,
        ...this.seatIdentity(p),
        stack: p.stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: this.disconnectEngine.isSittingOut(this.tableId, p.user_id),
        is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id),
        time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
        time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
        position: '',
        is_horse: p.is_horse ?? false,
        is_waiting_for_bb: this.waitingForBB.has(p.user_id),
        hand_name: '',
      })),
    };
    this.hub.publish(this.tableId, payload);
  }
}
