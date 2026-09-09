/**
 * V32 wiring — the facing-defence consult reaches decide() (2026-08-30).
 *
 * Phase 1's audit found five defects in already-merged code, one of which was
 * a layer that existed but was never consulted. This suite exists so V32
 * cannot be that: it drives the FULL decide() path with a stocked store and
 * asserts the decision came from the solver range, then ablates the flag and
 * asserts the store stops mattering.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { setGtoPostflop, _clearGtoPostflop, textureClass } from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

const BOARD = cards('Ks9d7c2h');

/** Heads-up: dealer seat 2 bet 50 into a 100 pot (50%, bet_small); hero faces it. */
function state(hole: string) {
  const players = [
    {
      seat: 1,
      user_id: 'hero',
      stack: 8000,
      bet: 0,
      is_folded: false,
      is_sitting_out: false,
      cards: cards(hole),
    },
    {
      seat: 2,
      user_id: 'villain',
      stack: 8000,
      bet: 50,
      is_folded: false,
      is_sitting_out: false,
      cards: [],
    },
  ];
  return {
    players,
    communityCards: BOARD,
    pot: 150, // 100 before + villain's 50 = a 50%-pot bet, bucket bet_small
    currentBet: 50,
    minRaise: 50,
    stage: 'turn',
    gameVariant: 'nlh',
    // explicit: without it the legacy bb>=10 heuristic reads 100bb CASH as a
    // tournament and the family lookup misses the 'cash' cell
    gameMode: 'cash',
    bigBlind: 100,
    smallBlind: 50,
    dealerSeat: 2,
    actionHistory: [{ stage: 'turn', seat: 2, userId: 'villain', action: 'bet', amount: 50 }],
  };
}

function stock() {
  const tex = textureClass(BOARD)!;
  setGtoPostflop([
    {
      street: 'turn',
      game_family: 'cash',
      position: 'SB', // heads-up the dealer is the SB — the BETTOR's cell
      depth_bucket: 80,
      texture_class: tex,
      facing: 'open',
      hand_matrix: {
        KK: { bet_small: 1.0 },
        '99': { bet_small: 1.0 },
        '77': { bet_small: 1.0 },
        A5s: { bet_small: 1.0 },
        '54s': { bet_small: 1.0 },
        '65s': { bet_small: 1.0 },
      },
    } as never,
  ]);
}

function decide(hole: string, opts: Record<string, unknown> = {}) {
  const st = state(hole);
  // opts is the FIFTH argument; the fourth is the profile mods. Passing it
  // fourth silently discards every flag — including `telemetry` — which is
  // exactly the sort of wiring slip this suite exists to catch in the code
  // under test, so it does not get to live in the test either.
  return HorseLogic.decide(st.players[0] as never, st as never, 'balanced', {}, opts as never);
}

beforeEach(() => {
  _clearGtoPostflop();
  _clearGtoPostflopV31();
});

describe('the consult is WIRED', () => {
  it('air facing a 50%-pot turn bet folds from the solver range', () => {
    stock();
    let folds = 0;
    for (let i = 0; i < 30; i++) if (decide('3c4d').action === 'fold') folds++;
    expect(folds).toBe(30);
  });

  /**
   * THE MUTATION THAT EXPOSED THE FIRST VERSION OF THIS TEST. Unwiring the
   * consult entirely (M5: the flag never read) passed the original suite,
   * because air folds under the heuristics too — a decision that AGREES with
   * the solver proves nothing about who made it. The counter does: it fires
   * only inside the consult. Assert on the counter, not the verdict.
   */
  it("the decision is attributably the SOLVER'S - the counter fires", () => {
    stock();
    enableBrainTelemetry();
    drainFires();
    for (let i = 0; i < 10; i++) decide('3c4d', { telemetry: true });
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires['v32_defend_fold'] ?? 0).toBe(10);
  });

  it('with the flag ablated the counter goes SILENT', () => {
    stock();
    enableBrainTelemetry();
    drainFires();
    for (let i = 0; i < 10; i++) decide('3c4d', { telemetry: true, v32FacingDefense: false });
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires['v32_defend_fold'] ?? 0).toBe(0);
    expect(fires['v32_defend_no_range'] ?? 0).toBe(0);
  });

  it('pass_strong is attributable too', () => {
    stock();
    enableBrainTelemetry();
    drainFires();
    for (let i = 0; i < 10; i++) decide('KhKc', { telemetry: true });
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires['v32_defend_pass_strong'] ?? 0).toBe(10);
  });

  it('an empty store leaves the heuristics in charge - no synthetic fold', () => {
    // No stock(). A strong hand facing a small bet must not auto-fold.
    let folds = 0;
    for (let i = 0; i < 30; i++) if (decide('KhKc').action === 'fold') folds++;
    expect(folds).toBe(0);
  });

  it('a monster with the store stocked is NOT flatted to death by the layer', () => {
    stock();
    // KhKc = top set. pass_strong -> aggression layers -> raise/call mix,
    // never a fold.
    for (let i = 0; i < 30; i++) {
      expect(decide('KhKc').action).not.toBe('fold');
    }
  });
});

describe("a raise of hero's own bet is refused - no open-node cell models it", () => {
  it('hero bet, villain raised: the counters stay silent', () => {
    stock();
    enableBrainTelemetry();
    drainFires();
    const st = state('3c4d');
    // hero already bet 30 this street; villain raised to 90
    (st.players[0] as { bet: number }).bet = 30;
    (st.players[1] as { bet: number }).bet = 90;
    st.currentBet = 90;
    st.pot = 220;
    st.actionHistory = [
      { stage: 'turn', seat: 1, userId: 'hero', action: 'bet', amount: 30 },
      { stage: 'turn', seat: 2, userId: 'villain', action: 'raise', amount: 90 },
    ];
    for (let i = 0; i < 10; i++)
      HorseLogic.decide(st.players[0] as never, st as never, 'balanced', {}, {
        telemetry: true,
      } as never);
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(fires['v32_defend_fold'] ?? 0).toBe(0);
    expect(fires['v32_defend_call'] ?? 0).toBe(0);
    expect(fires['v32_defend_pass_strong'] ?? 0).toBe(0);
    expect(fires['v32_defend_no_range'] ?? 0).toBe(0);
  });
});
