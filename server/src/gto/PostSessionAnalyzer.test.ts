import { describe, it, expect } from 'vitest';
import {
  analyzeSession,
  buildHeroScenario,
  extractHeroDecisions,
  heroHoleClass,
  boardKey,
  matchChosenAction,
} from './PostSessionAnalyzer.js';
import {
  StubGtoSolverClient,
  computeScenarioHash,
  type SolverStrategy,
} from './GtoSolverClient.js';
import type { NormalizedAction, NormalizedHand } from '../integrity/types.js';

let seq = 0;
function a(
  userId: string,
  seat: number,
  action: NormalizedAction['action'],
  amount: number,
  street: NormalizedAction['street'],
  forced = false
): NormalizedAction {
  seq++;
  return {
    handId: '',
    tableId: 't1',
    userId,
    seat,
    street,
    action,
    amount,
    timestamp: seq,
    latencyMs: 500,
    forced,
  };
}

function mkHand(
  id: string,
  heroCards: string[],
  actions: NormalizedAction[],
  community: string[] = []
): NormalizedHand {
  return {
    handId: id,
    tableId: 't1',
    gameVariant: 'nlhe',
    smallBlind: 5,
    bigBlind: 10,
    potSize: 15,
    rake: 0,
    communityCards: community,
    startedAt: 0,
    endedAt: 0,
    players: [
      { userId: 'hero', seat: 0, startingStack: 1000, cards: heroCards },
      { userId: 'vil', seat: 1, startingStack: 1000, cards: [] },
    ],
    winners: [],
    actions: actions.map((x) => ({ ...x, handId: id })),
  };
}

// Hand A: hero open-raises preflop (optimal).
const handA = mkHand(
  'A',
  ['Ah', 'Kh'],
  [
    a('hero', 0, 'post_blind', 5, 'preflop', true),
    a('vil', 1, 'post_blind', 10, 'preflop', true),
    a('hero', 0, 'raise', 30, 'preflop'),
    a('vil', 1, 'fold', 0, 'preflop'),
  ]
);

// Hand B: hero folds facing a raise (mistake — solver prefers call).
const handB = mkHand(
  'B',
  ['Qs', 'Jd'],
  [
    a('hero', 0, 'post_blind', 5, 'preflop', true),
    a('vil', 1, 'post_blind', 10, 'preflop', true),
    a('vil', 1, 'raise', 40, 'preflop'),
    a('hero', 0, 'fold', 0, 'preflop'),
  ]
);

function buildSolver(): StubGtoSolverClient {
  const client = new StubGtoSolverClient();
  // Hand A hero decision is action index 2 (the raise)
  const scenA = buildHeroScenario(handA, 2);
  const stratA: SolverStrategy = {
    scenarioHash: computeScenarioHash(scenA),
    actions: [
      { action: 'raise', frequency: 0.85, ev: 2.0 },
      { action: 'call', frequency: 0.15, ev: 1.0 },
      { action: 'fold', frequency: 0, ev: 0 },
    ],
  };
  // Hand B hero decision is action index 3 (the fold)
  const scenB = buildHeroScenario(handB, 3);
  const stratB: SolverStrategy = {
    scenarioHash: computeScenarioHash(scenB),
    actions: [
      { action: 'call', frequency: 0.7, ev: 1.5 },
      { action: 'raise', frequency: 0.2, ev: 1.2 },
      { action: 'fold', frequency: 0.1, ev: 0.0 },
    ],
  };
  client.register(stratA);
  client.register(stratB);
  return client;
}

describe('canonicalization helpers', () => {
  it('heroHoleClass', () => {
    expect(heroHoleClass(['Ah', 'Kh'])).toBe('AKs');
    expect(heroHoleClass(['Kd', 'Ah'])).toBe('AKo');
    expect(heroHoleClass(['Qs', 'Qd'])).toBe('QQ');
    expect(heroHoleClass(['??'])).toBe('unknown');
  });
  it('boardKey collapses order + suit count', () => {
    expect(boardKey(['7c', 'Ah', 'Kd'])).toBe('AK7-3s');
    expect(boardKey([])).toBe('');
  });
});

describe('extractHeroDecisions / scenario', () => {
  it('excludes forced blinds', () => {
    const d = extractHeroDecisions(handA, 'hero');
    expect(d).toHaveLength(1);
    expect(d[0].action.action).toBe('raise');
  });
  it('detects facing_raise', () => {
    const scen = buildHeroScenario(handB, 3);
    expect(scen.facing).toBe('facing_raise');
    expect(scen.heroHoleClass).toBe('QJo');
    expect(scen.stackBucket).toBe('100bb');
  });
});

describe('matchChosenAction', () => {
  it('matches by group when exact action absent', () => {
    const strat: SolverStrategy = {
      scenarioHash: 'h',
      actions: [{ action: 'raise', frequency: 1, ev: 2 }],
    };
    const m = matchChosenAction('all_in', strat); // all_in ~ aggressive ~ raise
    expect(m.offTree).toBe(false);
    expect(m.matched!.action).toBe('raise');
  });
  it('flags off-tree when no group matches', () => {
    const strat: SolverStrategy = {
      scenarioHash: 'h',
      actions: [{ action: 'fold', frequency: 1, ev: 0 }],
    };
    const m = matchChosenAction('raise', strat);
    expect(m.offTree).toBe(true);
    expect(m.matched).toBeNull();
  });
});

describe('analyzeSession', () => {
  it('scores EV loss and ranks leaks', async () => {
    const report = await analyzeSession([handA, handB], 'hero', buildSolver());
    expect(report.handsAnalyzed).toBe(2);
    expect(report.decisionsAnalyzed).toBe(2);
    expect(report.decisionsScored).toBe(2);
    expect(report.coverage).toBe(1);
    // Hand A optimal (0 loss), Hand B fold vs call best => loss 1.5
    expect(report.totalEvLostBb).toBeCloseTo(1.5);
    expect(report.accuracy).toBe(0.5);
    expect(report.evLostPer100Hands).toBeCloseTo(75);
    // top leak is the fold category
    expect(report.leaks[0].category).toContain('fold');
    expect(report.leaks[0].totalEvLostBb).toBeCloseTo(1.5);
    expect(report.leaks[0].mistakeCount).toBe(1);
    expect(report.topMistakes[0].evLossBb).toBeCloseTo(1.5);
    expect(report.topMistakes[0].gtoBestAction).toBe('call');
  });

  it('skips decisions with no solver coverage', async () => {
    const emptySolver = new StubGtoSolverClient();
    const report = await analyzeSession([handA, handB], 'hero', emptySolver);
    expect(report.decisionsAnalyzed).toBe(2);
    expect(report.decisionsScored).toBe(0);
    expect(report.coverage).toBe(0);
    expect(report.leaks).toHaveLength(0);
  });

  it('treats off-tree choices as worst-case EV loss', async () => {
    // hero shoves all_in where solver only models fold(ev0)/call(ev1)/... best call
    const hand = mkHand(
      'C',
      ['2c', '7d'],
      [
        a('hero', 0, 'post_blind', 5, 'preflop', true),
        a('vil', 1, 'post_blind', 10, 'preflop', true),
        a('vil', 1, 'bet', 20, 'flop'),
        a('hero', 0, 'all_in', 500, 'flop'),
      ],
      ['2h', '7s', 'Kd']
    );
    const scen = buildHeroScenario(hand, 3);
    const solver = new StubGtoSolverClient([
      {
        scenarioHash: computeScenarioHash(scen),
        actions: [
          { action: 'fold', frequency: 0.6, ev: -0.5 },
          { action: 'call', frequency: 0.4, ev: 0.3 },
        ],
      },
    ]);
    const report = await analyzeSession([hand], 'hero', solver);
    const evl = report.topMistakes[0];
    expect(evl.offTree).toBe(true);
    // best ev 0.3, off-tree chosen => worst ev -0.5 => loss 0.8
    expect(evl.evLossBb).toBeCloseTo(0.8);
  });
});
