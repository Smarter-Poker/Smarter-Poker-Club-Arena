/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HAND, AS A CLIENT MAY SEE IT (extracted 2026-09-27, Lightning Phase 6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The public-state projection that ServerTableEngine's `broadcastCurrentState`
 * (the live hub payload) and `getTableState` (GET /state/:id, the resync a
 * client pulls after a sequence gap) used to build inline. It is PURE: every
 * fact that lives on a dealer rather than on the hand - a seat's presence and
 * time bank, the stay clock, the muck ruling, the voluntary per-card show, the
 * blind waiters - arrives in the context the caller builds, and the functions
 * here read nothing else.
 *
 * WHY IT MOVED. Lightning deals hands whose players sit at different physical
 * anchor tables, through `LightningHandHost`, which is not a ServerTableEngine
 * and must not be one. Both dealers publish through this one projection, so a
 * Lightning client and a physical-table client receive payloads built by the
 * same code: the Animation Law's "client events must be identical" is true by
 * construction, not by two copies kept in step.
 *
 * BEHAVIOUR IS UNCHANGED. The payload shapes, their key order, every reveal
 * gate and every default are the ones the engine had, moved and not
 * rewritten; `projectHandState.equivalence.test.ts` compares the engine's
 * output against a frozen copy of the inline code these functions replaced.
 *
 * THE CARD RULE, WHICH THIS FILE EXISTS TO KEEP. A player's hole cards reach
 * the wire in exactly three ways: to that player (the resync payload, and the
 * private `hole_cards` frame the dealer sends separately); face up at showdown
 * or during an all-in runout for a hand that is neither folded nor mucked; and
 * the cards a player picked to show once the hand is over. The live payload
 * carries nobody's cards before showdown, not even the viewer's own: it is ONE
 * payload for every subscriber of a room.
 */
import type { GameState, SeatPlayer } from '../../types.js';

/** The four identity fields a seat carries (see ServerTableEngine.seatIdentity). */
export interface SeatIdentityFields {
  username: string;
  avatar_url: string;
  equipped_frame: string;
  equipped_aura: string;
}

/** What the seat map needs to know that the hand state does not carry. */
export interface HandSeatContext {
  /** Name, picture and cosmetics, already scrubbed at an anonymous table. */
  seatIdentity(p: SeatPlayer): SeatIdentityFields;
  /** is_sitting_out, is_disconnected, time_bank_remaining, time_bank_uses_remaining. */
  seatPresence(p: SeatPlayer): {
    is_sitting_out: boolean;
    is_disconnected: boolean;
    time_bank_remaining: number;
    time_bank_uses_remaining: number;
  };
  /** The stay clock's fields for this seat (ChipContinuityTracker.seatFields). */
  seatContinuity(p: SeatPlayer): Record<string, unknown>;
}

/** The facts every reveal gate asks. */
export interface HandRevealContext {
  /** Tabled hands during a paced all-in runout are public, as at showdown. */
  runoutRevealActive: boolean;
  /** Mucked at showdown and not voluntarily shown whole. */
  isMuckedAtShowdown(userId: string): boolean;
  /** Voluntary per-card shows, by user id: indices of the cards picked. */
  showHandCards: ReadonlyMap<string, ReadonlySet<number>> | null | undefined;
  /** The hand's winners are known (currentHandWinnerIds.length > 0). */
  handHasWinners: boolean;
}

/** The payload fields that sit above the seat map and come from the dealer. */
export interface HandStateHeader {
  table_id: string;
  hand_number: number;
  /** The dealer seat to publish when the hand state carries none. */
  dealerSeatFallback: number;
  hand_variant: string;
  /** Bomb pot, kill pot and ante snapshot fields, spread in that order. */
  boardExtras: Record<string, unknown>;
  /** bettingStructureFields(state). */
  bettingStructure: Record<string, unknown>;
  action_context: string | null;
  turn_start_time_ms: number;
  /** The decision clock, in SECONDS (published as milliseconds). */
  turnDurationSeconds: number;
  server_time_ms: number;
  /** The Pineapple discard clock fields. */
  pineappleFields: Record<string, unknown>;
  max_seats: number;
  is_anonymous: boolean;
}

/** The live (hub) payload's context. */
export interface LiveHandStateContext extends HandStateHeader {
  seats: HandSeatContext;
  reveal: HandRevealContext;
  winnerIds: readonly string[];
  winners: ReadonlyArray<{ userId: string; amount: number; potIndex?: number }>;
  time_bank_active: boolean;
  disconnect_states: Record<string, unknown>;
  waitingForBB: ReadonlySet<string>;
  postBBWhenClear: ReadonlySet<string>;
  postingBBToEnter: ReadonlySet<string>;
  showdownResults: ReadonlyArray<{ userId: string; handName: string }>;
}

/** The resync payload's context. */
export interface ResyncHandStateContext extends HandStateHeader {
  seats: HandSeatContext;
  reveal: HandRevealContext;
}

/**
 * Seat position labels for the felt: BTN, SB, BB, then the named positions.
 * Moved verbatim from ServerTableEngineBase.getPositionLabels, which delegates here.
 */
export function positionLabelsFor(dealerSeat: number, players: SeatPlayer[]): Map<number, string> {
  const labels = new Map<number, string>();
  const seats = players.map((p) => p.seat).sort((a, b) => a - b);
  const n = seats.length;
  if (n === 0) return labels;

  // Find dealer seat index in sorted seats
  let dealerIdx = seats.indexOf(dealerSeat);
  if (dealerIdx === -1) {
    // Dealer seat not found in active players — use first seat
    dealerIdx = 0;
  }

  if (n === 2) {
    // FIX 177: Bible V8 §4.2 + Appendix B: Heads-up → dealer=BTN (is also SB), other=BB
    labels.set(seats[dealerIdx], 'BTN');
    labels.set(seats[(dealerIdx + 1) % n], 'BB');
  } else if (n === 3) {
    // AUDIT FIX 2026-07-19: 3-handed is BTN, SB, BB — the button is NOT the SB
    // (that's heads-up only). postBlinds posts SB at dealer+1 and BB at
    // dealer+2, so the previous BTN/BB/UTG labels mislabeled the SB as BB and
    // the BB as UTG on every 3-handed hand.
    labels.set(seats[dealerIdx], 'BTN');
    labels.set(seats[(dealerIdx + 1) % n], 'SB');
    labels.set(seats[(dealerIdx + 2) % n], 'BB');
  } else {
    // 4+ players — BTN, SB, BB, then positional names
    labels.set(seats[dealerIdx], 'BTN');
    labels.set(seats[(dealerIdx + 1) % n], 'SB');
    labels.set(seats[(dealerIdx + 2) % n], 'BB');

    // Bible V8 Appendix B position names
    const positionNames: Record<number, string[]> = {
      4: ['UTG'],
      5: ['UTG', 'CO'],
      6: ['UTG', 'MP', 'CO'],
      7: ['UTG', 'UTG+1', 'MP', 'CO'],
      8: ['UTG', 'UTG+1', 'MP', 'MP+1', 'CO'],
      9: ['UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'],
    };
    const names = positionNames[n] || positionNames[9] || [];
    for (let i = 0; i < n - 3 && i < names.length; i++) {
      labels.set(seats[(dealerIdx + 3 + i) % n], names[i]);
    }
  }
  return labels;
}

/** Bible V8 §2.5: Action Record — seat, userId, action, amount, timestamp, stage. */
function projectActionHistory(state: GameState) {
  return (state.actionHistory ?? []).map((a) => ({
    seat: a.seat,
    userId: a.userId ?? '',
    action: a.action,
    amount: a.amount,
    timestamp: a.timestamp ?? 0,
    stage: a.stage,
  }));
}

function projectPots(state: GameState) {
  return (state.pots ?? []).map((p) => ({
    amount: p.amount,
    eligible: p.eligiblePlayers ?? [],
  }));
}

/**
 * THE LIVE HUB PAYLOAD. One payload for every subscriber of a room, so it
 * carries no hole card before showdown - not even the viewer's own, which
 * travels in the private `hole_cards` frame.
 */
export function projectLiveHandState(
  state: GameState,
  ctx: LiveHandStateContext
): Record<string, unknown> {
  const currentSeatPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);
  return {
    table_id: ctx.table_id,
    hand_number: ctx.hand_number,
    pot: state.pot ?? 0,
    community_cards: state.communityCards ?? [],
    community_cards2: state.communityCards2 ?? [],
    community_cards3: state.communityCards3 ?? [],
    hand_variant: ctx.hand_variant,
    ...ctx.boardExtras,
    current_bet: state.currentBet ?? 0,
    current_player: currentSeatPlayer?.user_id ?? null,
    dealer_seat: state.dealerSeat ?? ctx.dealerSeatFallback,
    stage: state.stage ?? 'preflop',
    winner_ids: ctx.winnerIds.length > 0 ? ctx.winnerIds : [],
    winners:
      ctx.winners.length > 0
        ? ctx.winners.map((w) => ({
            user_id: w.userId,
            amount: w.amount,
            pot_index: w.potIndex ?? 0,
          }))
        : [],
    min_raise: state.minRaise ?? 0,
    last_raise: state.lastRaise ?? 0,
    ...ctx.bettingStructure,
    action_context: ctx.action_context,
    turn_start_time_ms: ctx.turn_start_time_ms,
    turn_duration_ms: ctx.turnDurationSeconds * 1000, // Convert seconds → milliseconds
    server_time_ms: ctx.server_time_ms,
    ...ctx.pineappleFields,
    turn_deadline_ms:
      ctx.turn_start_time_ms > 0 ? ctx.turn_start_time_ms + ctx.turnDurationSeconds * 1000 : 0,
    time_bank_active: ctx.time_bank_active,
    disconnect_states: ctx.disconnect_states,
    max_seats: ctx.max_seats,
    is_anonymous: ctx.is_anonymous,
    waiting_for_bb_user_ids: Array.from(ctx.waitingForBB),
    post_bb_deferred_user_ids: Array.from(ctx.postBBWhenClear),
    posting_bb_user_ids: Array.from(ctx.postingBBToEnter),
    pots: projectPots(state),
    action_history: projectActionHistory(state),
    players: (() => {
      const positionLabels = positionLabelsFor(
        state.dealerSeat ?? ctx.dealerSeatFallback,
        state.players ?? []
      );
      const reveal = ctx.reveal;
      return (state.players ?? []).map((p) => {
        // SHOWDOWN SYSTEM 2026-08-25: a hand mucked at showdown stays private.
        const muckedHere = reveal.isMuckedAtShowdown(p.user_id);
        // Tabled hands during an all-in runout are public too (2026-08-19).
        const showCards =
          (state.stage === 'showdown' || reveal.runoutRevealActive) && !p.is_folded && !muckedHere;

        // A voluntary per-card show: only the picked cards, only once the hand is over.
        const picked = reveal.showHandCards?.get(p.user_id);
        const handIsOver = state.stage === 'showdown' || reveal.handHasWinners;
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
          ...ctx.seats.seatIdentity(p),
          stack: p.stack,
          bet: p.bet ?? 0,
          totalInvested: p.totalInvested ?? 0, // Bible V8 §2.3
          cards: cardsOut,
          is_folded: p.is_folded ?? false,
          is_all_in: p.is_all_in ?? false,
          ...ctx.seats.seatPresence(p), // Bible V8 §2.3
          position: positionLabels.get(p.seat) ?? '', // Bible V8 §2.3, Appendix B
          ...ctx.seats.seatContinuity(p),
          is_waiting_for_bb: ctx.waitingForBB.has(p.user_id),
          is_mucked: state.stage === 'showdown' && !p.is_folded && muckedHere,
          hand_name: showCards
            ? (ctx.showdownResults.find((r) => r.userId === p.user_id)?.handName ?? '')
            : '',
        };
      });
    })(),
  };
}

/**
 * THE RESYNC PAYLOAD (GET /state/:id), scrubbed for one requesting player:
 * their own cards, and otherwise exactly what the live payload reveals.
 */
export function projectResyncHandState(
  state: GameState,
  ctx: ResyncHandStateContext,
  requestingUserId: string
): Record<string, unknown> {
  const currentSeatPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);
  return {
    table_id: ctx.table_id,
    hand_number: ctx.hand_number,
    pot: state.pot ?? 0,
    community_cards: state.communityCards ?? [],
    community_cards2: state.communityCards2 ?? [],
    // TRIPLE-BOARD BOMB POT 2026-08-27: third board (empty unless active).
    community_cards3: state.communityCards3 ?? [],
    hand_variant: ctx.hand_variant,
    ...ctx.boardExtras,
    current_bet: state.currentBet ?? 0,
    current_player: currentSeatPlayer?.user_id ?? null,
    dealer_seat: state.dealerSeat ?? ctx.dealerSeatFallback,
    stage: state.stage ?? 'preflop',
    max_seats: ctx.max_seats,
    is_anonymous: ctx.is_anonymous,
    min_raise: state.minRaise ?? 0,
    last_raise: state.lastRaise ?? 0,
    ...ctx.bettingStructure,
    // Bible V8 §2.4: Timer fields required for client-side countdown
    action_context: ctx.action_context,
    turn_start_time_ms: ctx.turn_start_time_ms,
    turn_duration_ms: ctx.turnDurationSeconds * 1000, // Convert seconds → milliseconds
    server_time_ms: ctx.server_time_ms,
    ...ctx.pineappleFields,
    pots: projectPots(state),
    action_history: projectActionHistory(state),
    players: (() => {
      const positionLabels = positionLabelsFor(
        state.dealerSeat ?? ctx.dealerSeatFallback,
        state.players ?? []
      );
      const reveal = ctx.reveal;
      return (state.players ?? []).map((p) => {
        let showCards = false;
        if (p.user_id === requestingUserId) {
          showCards = true;
        } else if (
          (state.stage === 'showdown' || reveal.runoutRevealActive) &&
          !p.is_folded &&
          !reveal.isMuckedAtShowdown(p.user_id)
        ) {
          // The same reveal gate as the live payload, so a reconnect during
          // a showdown or an all-in runout sees what everyone connected sees.
          showCards = true;
        }
        // A voluntary per-card show survives HTTP resync just as it does the
        // live snapshot. Unselected cards remain null, and no pick is public
        // before the hand ends. Owners still receive their own hand.
        const picked = reveal.showHandCards?.get(p.user_id);
        const handIsOver = state.stage === 'showdown' || reveal.handHasWinners;
        const partialReveal = !showCards && handIsOver && !!picked && picked.size > 0;
        const cardsOut = showCards
          ? (p.cards ?? [])
          : partialReveal
            ? (p.cards ?? []).map((card, index) => (picked!.has(index) ? card : null))
            : [];
        const presence = ctx.seats.seatPresence(p);
        return {
          seat: p.seat,
          user_id: p.user_id,
          ...ctx.seats.seatIdentity(p),
          stack: p.stack,
          bet: p.bet ?? 0,
          totalInvested: p.totalInvested ?? 0,
          cards: cardsOut,
          is_folded: p.is_folded ?? false,
          is_all_in: p.is_all_in ?? false,
          is_sitting_out: presence.is_sitting_out,
          // SHOWDOWN SYSTEM 2026-08-25: resync parity with the broadcast.
          is_mucked:
            state.stage === 'showdown' && !p.is_folded && reveal.isMuckedAtShowdown(p.user_id),
          is_disconnected: presence.is_disconnected,
          time_bank_remaining: presence.time_bank_remaining,
          time_bank_uses_remaining: presence.time_bank_uses_remaining,
          position: positionLabels.get(p.seat) ?? '',
          ...ctx.seats.seatContinuity(p),
        };
      });
    })(),
  };
}
