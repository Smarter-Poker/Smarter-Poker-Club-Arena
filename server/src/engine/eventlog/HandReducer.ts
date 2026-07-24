/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAND REDUCER — Pure, Deterministic Event Fold
 * ═══════════════════════════════════════════════════════════════════════════════
 * `apply(state, event) -> state` folds a single event into hand state.
 * `replay(events) -> finalState` folds a full stream.
 *
 * PURITY CONTRACT (do not break):
 *  - No I/O, no logging, no Date.now(), no Math.random().
 *  - The ONLY source of "randomness" is deriving the deck from the event's
 *    `seed` via a provided (injectable) shuffle function — itself deterministic.
 *  - `apply` never mutates its input; it returns a fresh state object.
 *
 * Given the same events (and same shuffle fn), replay produces byte-identical
 * state every time. This is what makes the engine replayable and auditable.
 */

import type { Card, CardRank, CardSuit } from '../../types.js';
import type { HandEvent, Street, Stakes, Payout, RevealedHand } from './events.js';

// ─────────────────────────────────────────────────────────────────────────────
// State shape
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatState {
  seat: number;
  userId: string;
  /** Chips behind (not committed). */
  stack: number;
  /** Live wager on the felt for the CURRENT street. */
  bet: number;
  /** Total chips committed across the whole hand (blinds + all streets). */
  totalInvested: number;
  folded: boolean;
  allIn: boolean;
  cards: Card[];
}

export type Phase = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export interface HandState {
  handId: string;
  handNumber: number;
  seed: number;
  buttonSeat: number;
  stakes: Stakes;
  phase: Phase;
  board: Card[];
  pot: number;
  currentBet: number;
  seats: SeatState[];
  /** Seat number whose action is expected next, or null. Best-effort. */
  toAct: number | null;
  /** Σ of all starting stacks — the conserved buy-in total. */
  initialChipTotal: number;
  /** Cumulative rake + fees removed from play (a documented chip sink). */
  rakeTaken: number;
  payouts: Payout[];
  reveals: RevealedHand[];
  complete: boolean;
  /** seq of the last applied event (-1 before any event). */
  lastSeq: number;
  // Deterministic deck derived from seed. Consumed as cards are dealt.
  deck: Card[];
  deckPos: number;
}

export type ShuffleFn = (deck: readonly Card[], seed: number) => Card[];

export interface ReducerDeps {
  /** Deterministic shuffle. Defaults to a seeded Fisher-Yates (mulberry32). */
  shuffle?: ShuffleFn;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic deck derivation (the sole "randomness", fully seeded)
// ─────────────────────────────────────────────────────────────────────────────

const RANKS: CardRank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: CardSuit[] = ['hearts', 'diamonds', 'clubs', 'spades'];

/** A fresh, ordered 52-card deck (rank-major, suit-minor). */
export function buildOrderedDeck(): Card[] {
  const deck: Card[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/** mulberry32 PRNG — tiny, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default deterministic shuffle — seeded Fisher-Yates over a copy. */
export const defaultShuffle: ShuffleFn = (deck, seed) => {
  const out = deck.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
};

/** Derive the full shuffled deck for a hand from its seed. Deterministic. */
export function deriveDeck(seed: number, shuffle: ShuffleFn = defaultShuffle): Card[] {
  return shuffle(buildOrderedDeck(), seed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (all pure)
// ─────────────────────────────────────────────────────────────────────────────

function cloneSeat(s: SeatState): SeatState {
  return { ...s, cards: s.cards.slice() };
}

function cloneState(s: HandState): HandState {
  return {
    ...s,
    stakes: { ...s.stakes },
    board: s.board.slice(),
    seats: s.seats.map(cloneSeat),
    payouts: s.payouts.map((p) => ({ ...p })),
    reveals: s.reveals.map((r) => ({ ...r, cards: r.cards.slice() })),
    deck: s.deck, // deck itself is never mutated after derivation
  };
}

function seatBy(state: HandState, seat: number): SeatState | undefined {
  return state.seats.find((s) => s.seat === seat);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Seats in clockwise order starting just after `fromSeat` (exclusive). */
function orderFrom(state: HandState, fromSeat: number): SeatState[] {
  const ordered = state.seats.slice().sort((a, b) => a.seat - b.seat);
  const startIdx = ordered.findIndex((s) => s.seat > fromSeat);
  if (startIdx === -1) return ordered;
  return [...ordered.slice(startIdx), ...ordered.slice(0, startIdx)];
}

function canAct(s: SeatState): boolean {
  return !s.folded && !s.allIn && s.stack > 0;
}

/** Best-effort next-to-act after a given seat (used for the toAct field). */
function nextToAct(state: HandState, afterSeat: number): number | null {
  for (const s of orderFrom(state, afterSeat)) {
    if (canAct(s)) return s.seat;
  }
  return null;
}

function firstToActPostflop(state: HandState): number | null {
  // First eligible seat clockwise from the button.
  for (const s of orderFrom(state, state.buttonSeat)) {
    if (canAct(s)) return s.seat;
  }
  return null;
}

/** Sweep all live bets on the felt into the pot (bets -> 0). */
function sweepBets(state: HandState): void {
  let swept = 0;
  for (const s of state.seats) {
    swept += s.bet;
    s.bet = 0;
  }
  state.pot = round2(state.pot + swept);
  state.currentBet = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The reducer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a single event into hand state. Pure: returns a NEW state, never mutates
 * `state`. The first event of a stream MUST be `HandStarted` (state may be
 * undefined for it); any other first event throws.
 */
export function apply(
  state: HandState | undefined,
  event: HandEvent,
  deps: ReducerDeps = {}
): HandState {
  const shuffle = deps.shuffle ?? defaultShuffle;

  if (event.type === 'HandStarted') {
    const seats: SeatState[] = event.players.map((p) => ({
      seat: p.seat,
      userId: p.userId,
      stack: p.stack,
      bet: 0,
      totalInvested: 0,
      folded: false,
      allIn: false,
      cards: [],
    }));
    const initialChipTotal = round2(seats.reduce((sum, s) => sum + s.stack, 0));
    return {
      handId: event.handId,
      handNumber: event.handNumber,
      seed: event.seed,
      buttonSeat: event.buttonSeat,
      stakes: { ...event.stakes },
      phase: 'preflop',
      board: [],
      pot: 0,
      currentBet: 0,
      seats,
      toAct: null,
      initialChipTotal,
      rakeTaken: 0,
      payouts: [],
      reveals: [],
      complete: false,
      lastSeq: event.seq,
      deck: deriveDeck(event.seed, shuffle),
      deckPos: 0,
    };
  }

  if (!state) {
    throw new Error(
      `HandReducer: first event must be HandStarted, got '${event.type}' (seq ${event.seq})`
    );
  }

  const next = cloneState(state);
  next.lastSeq = event.seq;

  switch (event.type) {
    case 'BlindsPosted': {
      for (const posting of event.postings) {
        const s = seatBy(next, posting.seat);
        if (!s) continue;
        const amt = Math.min(posting.amount, s.stack);
        s.stack = round2(s.stack - amt);
        s.bet = round2(s.bet + amt);
        s.totalInvested = round2(s.totalInvested + amt);
        if (s.stack <= 0) s.allIn = true;
        if (s.bet > next.currentBet) next.currentBet = s.bet;
      }
      // Preflop first-to-act is left of the big blind.
      const bb = event.postings.filter((p) => p.kind === 'big_blind').map((p) => p.seat);
      const anchor = bb.length > 0 ? Math.max(...bb) : next.buttonSeat;
      next.toAct = nextToAct(next, anchor);
      return next;
    }

    case 'HoleCardsDealt': {
      if (event.hands && event.hands.length > 0) {
        for (const dealt of event.hands) {
          const s = seatBy(next, dealt.seat);
          if (s) s.cards = dealt.cards.slice();
        }
      } else {
        // Deal deterministically from the seed-derived deck, seat order,
        // one card at a time round-robin (standard deal order).
        const receivers = next.seats
          .filter((s) => !s.folded)
          .slice()
          .sort((a, b) => a.seat - b.seat);
        for (let c = 0; c < event.cardsPerPlayer; c++) {
          for (const s of receivers) {
            s.cards.push(next.deck[next.deckPos++]);
          }
        }
      }
      return next;
    }

    case 'PlayerActed': {
      const s = seatBy(next, event.seat);
      if (!s) return next;
      switch (event.action) {
        case 'fold':
          s.folded = true;
          break;
        case 'check':
          break;
        case 'discard':
          // Pineapple discard — no chip movement; card removal handled elsewhere.
          break;
        case 'call': {
          const delta = round2(Math.min(next.currentBet - s.bet, s.stack));
          if (delta > 0) {
            s.stack = round2(s.stack - delta);
            s.bet = round2(s.bet + delta);
            s.totalInvested = round2(s.totalInvested + delta);
          }
          if (s.stack <= 0) s.allIn = true;
          break;
        }
        case 'bet':
        case 'raise': {
          // `amount` = new TOTAL bet level for this seat on this street.
          const target = event.amount;
          const delta = round2(Math.min(target - s.bet, s.stack));
          if (delta > 0) {
            s.stack = round2(s.stack - delta);
            s.bet = round2(s.bet + delta);
            s.totalInvested = round2(s.totalInvested + delta);
          }
          if (s.bet > next.currentBet) next.currentBet = s.bet;
          if (s.stack <= 0) s.allIn = true;
          break;
        }
        case 'all_in': {
          const delta = s.stack;
          if (delta > 0) {
            s.stack = 0;
            s.bet = round2(s.bet + delta);
            s.totalInvested = round2(s.totalInvested + delta);
          }
          s.allIn = true;
          if (s.bet > next.currentBet) next.currentBet = s.bet;
          break;
        }
      }
      next.toAct = nextToAct(next, event.seat);
      return next;
    }

    case 'StreetAdvanced': {
      sweepBets(next);
      next.phase = event.street as Phase;
      if (event.board && event.board.length > 0) {
        next.board = event.board.slice();
        // Keep the deck pointer consistent even when cards are supplied.
        const needed = event.board.length - state.board.length;
        if (needed > 0) next.deckPos += needed;
      } else {
        const targetLen = event.street === 'flop' ? 3 : event.street === 'turn' ? 4 : 5;
        while (next.board.length < targetLen) {
          next.board.push(next.deck[next.deckPos++]);
        }
      }
      next.toAct = firstToActPostflop(next);
      return next;
    }

    case 'ShowdownRevealed': {
      sweepBets(next);
      next.phase = 'showdown';
      next.reveals = event.reveals.map((r) => ({ ...r, cards: r.cards.slice() }));
      for (const r of event.reveals) {
        const s = seatBy(next, r.seat);
        if (s && (!s.cards || s.cards.length === 0)) s.cards = r.cards.slice();
      }
      next.toAct = null;
      return next;
    }

    case 'PotAwarded': {
      // Any residual bets (e.g. river action) settle into the pot first.
      sweepBets(next);
      const potBefore = next.pot;
      let paid = 0;
      for (const payout of event.payouts) {
        const s = seatBy(next, payout.seat);
        if (s) {
          s.stack = round2(s.stack + payout.amount);
          paid = round2(paid + payout.amount);
        }
      }
      // Rake defaults to whatever is left in the pot after payouts (a chip sink).
      // The pot is fully distributed here — it is NOT allowed to go negative. So
      // an OVERPAYMENT (payouts exceeding the pot) genuinely creates chips, which
      // then trips the ChipConservationVerifier on this exact event.
      const rake = event.rake ?? Math.max(0, round2(potBefore - paid));
      next.rakeTaken = round2(next.rakeTaken + rake);
      next.pot = 0;
      next.payouts = event.payouts.map((p) => ({ ...p }));
      next.toAct = null;
      return next;
    }

    case 'HandEnded': {
      next.phase = 'complete';
      next.complete = true;
      next.toAct = null;
      return next;
    }

    default: {
      // Exhaustiveness guard.
      const _never: never = event;
      return _never;
    }
  }
}

/**
 * Replay a full event stream into a final state. Pure and deterministic:
 * `replay(events)` twice yields structurally identical states.
 */
export function replay(events: HandEvent[], deps: ReducerDeps = {}): HandState {
  let state: HandState | undefined;
  for (const event of events) {
    state = apply(state, event, deps);
  }
  if (!state) {
    throw new Error('HandReducer.replay: empty event stream');
  }
  return state;
}

/** Convenience: total chips currently in play (should equal initialChipTotal). */
export function chipsInPlay(state: HandState): number {
  const stacks = state.seats.reduce((sum, s) => sum + s.stack, 0);
  const bets = state.seats.reduce((sum, s) => sum + s.bet, 0);
  return round2(stacks + bets + state.pot + state.rakeTaken);
}
