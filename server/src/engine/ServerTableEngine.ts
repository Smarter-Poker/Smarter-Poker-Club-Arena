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
import {
  bettingStructureFor,
  fixedLimitBetSize,
  fixedLimitStreetBounds,
  potLimitBettingPot,
  isFixedLimitCapped,
} from './BettingStructure.js';
import type { GameState } from '../types.js';
import { projectLiveHandState, projectResyncHandState } from './presentation/projectHandState.js';

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
          // Tabled hands during an all-in runout are public too (2026-09-04).
          (state.stage === 'showdown' || this.runoutRevealActive) &&
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
    equipped_frame?: string;
    equipped_aura?: string;
  }): {
    username: string;
    avatar_url: string;
    equipped_frame: string;
    equipped_aura: string;
  } {
    /* COSMETICS ARE IDENTITY (2026-08-25). The equipped frame and aura are
       returned here rather than beside the call sites precisely because of the
       anonymous-table rule above: they are worn ON the avatar, they are rare,
       and they are stable across sessions. A table where every name reads
       "Player 4" but exactly one seat burns with `frame-hellfire` every night
       is not anonymous - it has one anonymous player and one signature. They
       are scrubbed with the name and the picture, on the same branch, so a
       future field cannot be added to one and forgotten in the other. */
    if (!this.tableInfo?.is_anonymous) {
      return {
        username: p.username ?? '',
        avatar_url: p.avatar_url ?? '',
        equipped_frame: p.equipped_frame ?? '',
        equipped_aura: p.equipped_aura ?? '',
      };
    }
    const seat = p.seat ?? p.seat_number ?? 0;
    return {
      username: seat > 0 ? `Player ${seat}` : 'Player',
      avatar_url: '',
      equipped_frame: '',
      equipped_aura: '',
    };
  }

  /**
   * The table's regular ante, for the felt. `ante` is the per-posting amount
   * in chips (0 = none); `ante_mode` says who posts it - every seat, or the
   * big blind once for the table.
   */
  private anteSnapshotFields(): { ante: number; ante_mode: 'per_player' | 'big_blind' | null } {
    const info = this.tableInfo;
    if (!info) return { ante: 0, ante_mode: null };
    const on = info.tournament_id ? true : (info.ante_enabled ?? true);
    const ante = on ? Number(info.ante ?? 0) : 0;
    if (!(ante > 0)) return { ante: 0, ante_mode: null };
    return { ante, ante_mode: info.big_blind_ante_enabled === true ? 'big_blind' : 'per_player' };
  }

  private bettingStructureFields(state: GameState): {
    betting_structure: 'no_limit' | 'pot_limit' | 'fixed_limit';
    pot_limit_pot?: number;
    fixed_bet_size?: number;
    fixed_raise_size?: number;
    wagers_capped?: boolean;
  } {
    // VARIANT OVERRIDE 2026-08-28: the LIVE hand's variant, not the table's —
    // a PLO bomb hand at an NLH table must publish pot_limit or the client
    // draws a no-limit slider and has every drag rejected.
    const variant = this.activeHandVariant();
    const structure = bettingStructureFor(variant);
    if (structure === 'pot_limit') {
      return { betting_structure: structure, pot_limit_pot: potLimitBettingPot(state) };
    }
    if (structure !== 'fixed_limit') return { betting_structure: structure };
    const stage = state.stage ?? 'preflop';
    // KILL POT (kill-v1): the HAND's effective small bet, never the table
    // row's big blind - on a kill hand those differ, and the client must draw
    // the same bet the controller will accept.
    const streetBet = fixedLimitBetSize(
      this.handController?.getFixedLimitSmallBet?.() ?? this.tableInfo?.big_blind ?? 2,
      stage
    );
    return {
      betting_structure: structure,
      fixed_bet_size: streetBet,
      fixed_raise_size: fixedLimitStreetBounds(
        state.actionHistory ?? [],
        stage,
        streetBet,
        state.currentBet
      ).raiseSize,
      wagers_capped: isFixedLimitCapped(state.actionHistory ?? [], stage, streetBet),
    };
  }

  /**
   * GET /state/:tableId — Bible V8 §2.4: Get current hand state (scrubbed for requesting player)
   */
  /**
   * The discard clock, as the engine knows it (2026-08-31).
   *
   * `discard_deadlines` is keyed by user_id so a client picks out its OWN
   * deadline; `discard_deadline_ms` is the unextended round deadline, which is
   * what a spectator or a seat that has already discarded should see. Both are
   * absolute epoch ms and both are null outside the round, so a client can
   * never keep counting down a clock that has stopped.
   *
   * Deadlines are not secret - they are on everybody's screen already - so
   * publishing the map on the shared broadcast leaks nothing.
   */
  protected pineappleDiscardSnapshotFields(): Record<string, unknown> {
    if (
      this.pineappleDiscardBaseDeadlineMs === null ||
      this.handController?.getState().stage !== 'pineapple_discard'
    ) {
      return { discard_deadline_ms: null, discard_deadlines: {}, discard_duration_ms: 0 };
    }
    /* Never announce a deadline for a seat that has already settled its round.
       A horse discards through performDiscard and an all-in seat through
       resolvePendingPineappleDiscards, so the map is reconciled here too. */
    this.pruneSettledPineappleDeadlines();
    const byUser: Record<string, number> = {};
    for (const [seat, at] of this.pineappleDiscardDeadlines) {
      const p = this.seatedPlayers.find((sp) => sp.seat_number === seat);
      if (p) byUser[p.user_id] = at;
    }
    return {
      discard_deadline_ms: this.pineappleDiscardBaseDeadlineMs,
      discard_deadlines: byUser,
      discard_duration_ms: this.pineappleDiscardDurationMs,
    };
  }

  /**
   * CHIP CONTINUITY: the stack the stay clock is judged on. Between hands the
   * roster and the hand agree; mid-hand the hand's copy is net of the current
   * bets, which would flip `leave_locked` off every time the hero opened for
   * more than their profit. The roster stack is what the seat holds.
   */
  private continuityStack(userId: string, fallback: number): number {
    const seated = this.seatedPlayers.find((sp) => sp.user_id === userId);
    return seated ? seated.stack : fallback;
  }

  public getTableState(requestingUserId: string): Record<string, any> | null {
    if (!this.handController || !this.tableInfo) return null;

    const state = this.handController.getState();
    /* THE PROJECTION IS SHARED (Lightning Phase 6, 2026-09-27). The payload is
       built by projectResyncHandState, the same pure function a Lightning hand
       host publishes through, so the two dealers cannot drift apart. Every
       fact below is this engine's and is read exactly where it always was; the
       reveal gates (the requester's own cards, the showdown / all-in runout
       rule with the muck, the per-card show once the hand is over) live in
       src/engine/presentation/projectHandState.ts. */
    return projectResyncHandState(
      state,
      {
        table_id: this.tableId,
        hand_number: this.handCount,
        dealerSeatFallback: this.currentHandDealerSeat,
        // VARIANT OVERRIDE 2026-08-28 (spec §10.1): what game THIS hand is.
        hand_variant: this.activeHandVariant(),
        // Bomb pot countdown, kill pots, and THE REGULAR ANTE (Dan 2026-09-04).
        boardExtras: {
          ...this.bombPotSnapshotFields(),
          ...this.killPotSnapshotFields(),
          ...this.anteSnapshotFields(),
        },
        bettingStructure: this.bettingStructureFields(state),
        action_context: this.getActionContext(),
        turn_start_time_ms: this.playerTurnStartTime,
        turnDurationSeconds: this.playerTurnDuration,
        // Dan 2026-08-18: the server's own "now", so the client can subtract its skew.
        server_time_ms: Date.now(),
        pineappleFields: this.pineappleDiscardSnapshotFields(),
        /* THE THIRD PAYLOAD, AND THE ONE THAT MATTERS MOST (2026-08-31 audit):
           the resync must say how wide the table is, from the table row. */
        max_seats: Number(this.tableInfo?.max_players) || 0,
        is_anonymous: this.tableInfo?.is_anonymous === true,
        seats: {
          seatIdentity: (p) => ({ ...this.seatIdentity(p) }),
          /* THE ENGINE, NOT THE ROSTER (2026-08-28): the hand roster's copy of
             is_sitting_out is deliberately always false. */
          seatPresence: (p) => ({
            is_sitting_out: this.disconnectEngine.isSittingOut(this.tableId, p.user_id),
            is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id),
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
          }),
          // CHIP CONTINUITY: the stay clock, judged on the ROSTER stack.
          seatContinuity: (p) => ({
            ...this.chipContinuity.seatFields(p.user_id, this.continuityStack(p.user_id, p.stack)),
          }),
        },
        reveal: {
          runoutRevealActive: this.runoutRevealActive,
          isMuckedAtShowdown: (userId) => this.isMuckedAtShowdown(userId),
          showHandCards: this.showHandCards,
          handHasWinners: this.currentHandWinnerIds.length > 0,
        },
      },
      requestingUserId
    );
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
      // Phase 1 (2026-09-04), measured on production: the first 33 human
      // samples included four over 5 s. They were not slow broadcasts - they
      // were the LAST action of a hand: the hand ended, this branch published
      // idle without observing, the clock stayed armed, and the next hand's
      // first broadcast observed the whole gap between hands. That is not
      // act-to-broadcast latency. Disarm the clock here; the sample is void.
      this.lastActionAcceptedAtMs = 0;
      this.publishIdleState();
      return Promise.resolve();
    }

    // ── ADDITIVE observability (#5): observe action→broadcast latency (cheap, always) ──
    if (this.lastActionAcceptedAtMs > 0) {
      try {
        const actMs = Date.now() - this.lastActionAcceptedAtMs;
        EngineMetrics.actToBroadcastLatency.observe(actMs, {
          table_id: this.tableId,
        });
        // Phase 1 (2026-09-04): the always-on, low-cardinality twin. The
        // per-table series above is gated off in production; this one is
        // what the ActionLatency alerts read.
        EngineMetrics.actToBroadcastFleet.observe(actMs, {
          audience: this.humansSeated() > 0 ? 'human' : 'horse',
          format: this.tableFormat(),
        });
      } catch {
        /* metrics must never affect gameplay */
      }
      this.lastActionAcceptedAtMs = 0;
    }

    const state = this.handController.getState();

    // Phase 1.1 PR-2: Build the payload once and publish it to the
    // authoritative WebSocket hub. Lightning Phase 6 (2026-09-27): built by
    // projectLiveHandState, the one projection both dealers share
    // (src/engine/presentation/projectHandState.ts). ONE payload for every
    // subscriber, so it carries no hole card before showdown.
    const payload = projectLiveHandState(state, {
      table_id: this.tableId,
      hand_number: this.handCount,
      dealerSeatFallback: this.currentHandDealerSeat,
      hand_variant: this.activeHandVariant(),
      boardExtras: {
        ...this.bombPotSnapshotFields(),
        ...this.killPotSnapshotFields(),
        ...this.anteSnapshotFields(),
      },
      winnerIds: this.currentHandWinnerIds,
      winners: this.currentHandWinners,
      bettingStructure: this.bettingStructureFields(state),
      action_context: this.getActionContext(),
      turn_start_time_ms: this.playerTurnStartTime,
      turnDurationSeconds: this.playerTurnDuration,
      server_time_ms: Date.now(),
      pineappleFields: this.pineappleDiscardSnapshotFields(),
      time_bank_active: this.timeBankActivatedThisTurn,
      disconnect_states: this.disconnectEngine.getFsmStatesForTable(this.tableId),
      /* HOW MANY SEATS THIS TABLE HAS — FROM THE ONLY PARTY THAT KNOWS
         (Dan 2026-08-31, phase 1 of the seat-truth contract): the table row,
         never the roster. */
      max_seats: Number(this.tableInfo?.max_players) || 0,
      is_anonymous: this.tableInfo?.is_anonymous === true,
      waitingForBB: this.waitingForBB,
      postBBWhenClear: this.postBBWhenClear,
      postingBBToEnter: this.postingBBToEnter,
      showdownResults: this.currentHandShowdownResults,
      seats: {
        seatIdentity: (p) => ({ ...this.seatIdentity(p) }),
        /* THE ENGINE, NOT THE ROSTER (2026-08-28): the hand roster's copy of
           is_sitting_out is deliberately always false. */
        seatPresence: (p) => ({
          is_sitting_out: this.disconnectEngine.isSittingOut(this.tableId, p.user_id),
          is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id),
          time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
          time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
        }),
        // CHIP CONTINUITY: the stay clock, judged on the ROSTER stack.
        seatContinuity: (p) => ({
          ...this.chipContinuity.seatFields(p.user_id, this.continuityStack(p.user_id, p.stack)),
        }),
      },
      reveal: {
        runoutRevealActive: this.runoutRevealActive,
        isMuckedAtShowdown: (userId) => this.isMuckedAtShowdown(userId),
        showHandCards: this.showHandCards,
        handHasWinners: this.currentHandWinnerIds.length > 0,
      },
    });

    // Phase 1.1 PR-5: Publish ONLY to the authoritative WebSocket hub.
    // The legacy Supabase Realtime broadcast path has been deleted.
    // All game-state delivery now flows through the native WS hub.
    if (this.hub) {
      this.hub.publish(this.tableId, payload);
    } else {
      console.warn(
        `[ServerTableEngine:${this.tableId}] No hub attached - state not delivered to clients`
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
      community_cards3: [],
      hand_variant: this.activeHandVariant(),
      ...this.bombPotSnapshotFields(),
      // KILL POTS (kill-v1): this hand's kill and the next hand's pending kill.
      ...this.killPotSnapshotFields(),
      ...this.anteSnapshotFields(),
      current_bet: 0,
      current_player: null,
      dealer_seat: this.currentHandDealerSeat,
      stage: 'waiting',
      admin_paused: this.adminPauseLock,
      maintenance_lock: this.maintenanceLock,
      winner_ids: [],
      winners: [],
      min_raise: 0,
      last_raise: 0,
      turn_start_time_ms: 0,
      turn_duration_ms: 0,
      server_time_ms: Date.now(),
      turn_deadline_ms: 0,
      /* Explicit, not omitted: an idle snapshot must actively CLEAR the discard
         clock. Leaving the key out would let the client hold the last live
         deadline and keep a dead countdown on the felt between hands. */
      discard_deadline_ms: null,
      discard_deadlines: {},
      discard_duration_ms: 0,
      time_bank_active: false,
      disconnect_states: this.disconnectEngine.getFsmStatesForTable(this.tableId),
      /* HOW MANY SEATS THIS TABLE HAS — FROM THE ONLY PARTY THAT KNOWS
         (Dan 2026-08-31, phase 1 of the seat-truth contract).

         The client used to GUESS. `tableState.maxPlayers` is seeded to 6 and
         corrected only when its own `tables` row query lands, so for the first
         seconds of every mount — and indefinitely if that query failed or was
         RLS denied — a 9-max table was drawn as a 6-max one. On 2026-08-31
         that erased a player seated in seat 7 from his own screen for ten
         minutes while the engine dealt him in, took his big blind, timed out
         his turns and finally evicted him (table 08746c1a). The mapper now
         infers a floor from the highest OCCUPIED seat, which rescues a seated
         hero but still under-draws a table whose high seats happen to be empty.

         The engine holds `tableInfo.max_players` and always has. One field
         ends the guessing: published on the live payload and on the idle one,
         so every snapshot a client can receive carries the true capacity.
         Clients older than this field fall back to the inference and are no
         worse off than they are today. */
      max_seats: Number(this.tableInfo?.max_players) || 0,
      // 2026-09-07: published beside max_seats on every payload so the client
      // knows when seatIdentity() has scrubbed the roster and must not paint
      // a real face over it from its own profile sync (an-avatar-change-
      // stays-changed changelog). Absent on an older engine = not anonymous.
      is_anonymous: this.tableInfo?.is_anonymous === true,
      waiting_for_bb_user_ids: Array.from(this.waitingForBB),
      post_bb_deferred_user_ids: Array.from(this.postBBWhenClear),
      posting_bb_user_ids: Array.from(this.postingBBToEnter),
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
        is_waiting_for_bb: this.waitingForBB.has(p.user_id),
        hand_name: '',
        // CHIP CONTINUITY: the stay clock keeps counting between hands, so the
        // idle payload carries it too - the third of the three that must agree.
        ...this.chipContinuity.seatFields(p.user_id, p.stack),
      })),
    };
    this.hub.publish(this.tableId, payload);
  }
}
