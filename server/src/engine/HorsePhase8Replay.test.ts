import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { calculatePots, calculateContestablePot } from './PokerEngine.js';
import { horseVariantRulesFor } from './VariantRules.js';
import type { ActionRecord, Card, HandStage, SeatPlayer } from '../types.js';

interface CapturedHand {
  reviewId: number;
  variant: string;
  bigBlind: number;
  heroSeat: number;
  holeCards: Card[];
  board: Card[];
  actions: Array<{
    seat: number;
    stage: HandStage;
    action: string;
    amount: number;
    isFullRaise?: boolean;
    dead?: boolean;
  }>;
}
const hands: CapturedHand[] = JSON.parse(
  readFileSync(new URL('./fixtures/phase8-production-hands.json', import.meta.url), 'utf8')
);

/** Real public line and hero cards, with an explicitly reconstructed test field.
 * The hand-review table does not preserve the historical full tournament field.
 * No invented field is described as an exact production decision replay.
 */
function reconstruct(hand: CapturedHand): {
  hero: SeatPlayer;
  gs: HorseGameStateV2;
  recorded: string;
} {
  const numbers = [...new Set(hand.actions.map((a) => a.seat))].sort((a, b) => a - b);
  let stage: HandStage = 'preflop';
  const invested = new Map<number, number>();
  const bets = new Map<number, number>();
  const peak = new Map<number, number>();
  for (const a of hand.actions) {
    if (a.stage !== stage) {
      bets.clear();
      stage = a.stage;
    }
    const delta = ['bet', 'raise', 'all_in'].includes(a.action)
      ? a.amount - (bets.get(a.seat) ?? 0)
      : a.action === 'return'
        ? -a.amount
        : ['call', 'sb', 'bb', 'ante'].includes(a.action)
          ? a.amount
          : 0;
    invested.set(a.seat, (invested.get(a.seat) ?? 0) + delta);
    if (!a.dead) bets.set(a.seat, (bets.get(a.seat) ?? 0) + delta);
    peak.set(a.seat, Math.max(peak.get(a.seat) ?? 0, invested.get(a.seat)!));
  }
  const heroStart = peak.get(hand.heroSeat)!;
  const players: SeatPlayer[] = numbers.map((n) => ({
    seat: n,
    user_id: `replay-seat-${n}`,
    username: `Seat ${n}`,
    stack: Math.max(heroStart, peak.get(n) ?? 0),
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const starts = Object.fromEntries(players.map((p) => [p.user_id, p.stack]));
  const target = hand.reviewId === 400615 ? 'bet' : null;
  const last = hand.actions
    .map((a, i) => ({ a, i }))
    .filter(
      ({ a }) =>
        a.seat === hand.heroSeat &&
        a.stage !== 'preflop' &&
        (target
          ? a.stage === 'river' && a.action === target
          : ['call', 'raise', 'all_in', 'bet'].includes(a.action))
    )
    .at(-1)!.i;
  const history: ActionRecord[] = [];
  stage = 'preflop';
  let currentBet = 0;
  let lastRaise = hand.bigBlind;
  for (let i = 0; i < last; i++) {
    const a = hand.actions[i];
    const p = players.find((p) => p.seat === a.seat)!;
    if (a.stage !== stage) {
      for (const q of players) q.bet = 0;
      stage = a.stage;
      currentBet = 0;
      lastRaise = hand.bigBlind;
    }
    const delta = ['bet', 'raise', 'all_in'].includes(a.action)
      ? a.amount - p.bet
      : ['call', 'sb', 'bb', 'ante'].includes(a.action)
        ? a.amount
        : 0;
    if (a.action === 'fold') p.is_folded = true;
    p.stack -= delta;
    p.totalInvested += delta;
    if (!a.dead) p.bet += delta;
    if (p.bet > currentBet) {
      if (a.isFullRaise !== false) lastRaise = Math.max(hand.bigBlind, p.bet - currentBet);
      currentBet = p.bet;
    }
    p.is_all_in = p.stack <= 0;
    history.push({
      ...a,
      action: a.action as ActionRecord['action'],
      userId: p.user_id,
      timestamp: i + 1,
    });
  }
  const at = hand.actions[last];
  if (at.stage !== stage) {
    for (const p of players) p.bet = 0;
    stage = at.stage;
    currentBet = 0;
    lastRaise = hand.bigBlind;
  }
  const hero = { ...players.find((p) => p.seat === hand.heroSeat)!, cards: hand.holeCards };
  const pot = players.reduce((s, p) => s + p.totalInvested, 0);
  const toCall = Math.min(hero.stack, Math.max(0, currentBet - hero.bet));
  const canRaise = hero.bet + hero.stack >= currentBet + lastRaise;
  const legalActions: HorseGameStateV2['legalActions'] = toCall > 0 ? ['fold', 'call'] : ['check'];
  if (canRaise) legalActions.push(currentBet > 0 ? 'raise' : 'bet');
  legalActions.push('all_in');
  const gs: HorseGameStateV2 = {
    players,
    communityCards: hand.board.slice(0, stage === 'flop' ? 3 : stage === 'turn' ? 4 : 5),
    pot,
    pots: calculatePots(players),
    currentBet,
    minRaise: lastRaise,
    lastRaise,
    stage,
    gameVariant: hand.variant,
    bigBlind: hand.bigBlind,
    gameMode: 'tournament',
    format: 'mtt',
    stateSchemaVersion: 1,
    heroSeat: hero.seat,
    currentPlayerSeat: hero.seat,
    dealerSeat: numbers[0],
    actionHistory: history,
    legalActions,
    toCall,
    bettingStructure: 'no_limit',
    minRaiseTo: canRaise ? currentBet + lastRaise : null,
    maxRaiseTo: canRaise ? hero.bet + hero.stack : null,
    contestablePot: calculateContestablePot(players, hero.user_id, toCall),
    variantRules: horseVariantRulesFor('nlh'),
    tournament: {
      schemaVersion: 1,
      contextStatus: 'complete',
      contextIssues: [],
      playersLeft: players.length,
      spotsPaid: 2,
      payoutPct: [65, 35],
      stacks: Object.values(starts),
      stackByUser: starts,
      currentSmallBlind: hand.bigBlind / 2,
      currentBigBlind: hand.bigBlind,
      currentAnte: 0,
      anteType: 'none',
      nextSmallBlind: hand.bigBlind,
      nextBigBlind: hand.bigBlind * 2,
      nextAnte: 0,
      nextBlindInMin: 5,
      prizePoolCents: 100000,
      bountyPoolCents: 0,
      reentryOpen: false,
      rebuyOpen: false,
      addOnPeriodOpen: false,
      reloadsUsed: 0,
      addOnTaken: false,
      rebuyAffordable: false,
      addOnAffordable: false,
    },
  };
  return { hero, gs, recorded: at.action };
}
describe('Phase 8 captured public-line reconstruction', () => {
  it.each(hands)('review $reviewId remains legal and private', (hand) => {
    const { hero, gs, recorded } = reconstruct(hand);
    seedFastRandom(hand.reviewId);
    const baseline = HorseLogic.decide(
      hero,
      gs,
      'balanced',
      {},
      { phase8Postflop: 'off', mind: false, decisionTimeMs: 0 }
    );
    seedFastRandom(hand.reviewId);
    // Semantic replay is clock-independent. The league separately measures
    // real elapsed budgets; no synthetic zero is reported as latency proof.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let candidate: ReturnType<typeof HorseLogic.decide>;
    try {
      candidate = HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        { phase8Postflop: 'candidate', mind: false, decisionTimeMs: 0 }
      );
    } finally {
      clock.mockRestore();
    }
    expect(gs.players.every((p) => p.cards.length === 0)).toBe(true);
    expect(gs.legalActions).toContain(baseline.action);
    expect(gs.legalActions).toContain(candidate.action);
    expect(['call', 'all_in', 'bet']).toContain(recorded);
    expect(candidate.tournamentPostflop).toBeDefined();
    expect(['all_in', 'bet', 'raise']).toContain(baseline.action);
    expect(candidate.action).toBe(hand.reviewId === 400615 ? 'check' : 'fold');
    console.info(
      JSON.stringify({
        reviewId: hand.reviewId,
        context: 'reconstructed_field',
        recorded,
        baseline: baseline.action,
        candidate: candidate.action,
        reason: candidate.tournamentPostflop?.reason,
        features: candidate.tournamentPostflop?.reasons,
        eligible: candidate.tournamentPostflop?.eligible,
        fired: candidate.tournamentPostflop?.fired,
        latency: 'measured_separately_in_league',
      })
    );
  });
});
