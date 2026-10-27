import { readFileSync } from 'node:fs';
import { reconstructPhase8Hand, type CapturedPhase8Hand } from './HorsePhase8ReplayFixture.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom, saveFastRandom, restoreFastRandom } from './HorseEval.js';
import { expect, it } from 'vitest';
import { evaluateTournamentCatastropheGuard } from './HorseTournamentCatastropheGuard.js';
const card = (rank: string, suit: string) => ({ rank, suit });
function fixture() {
  const hero: any = {
    user_id: 'hero',
    seat: 0,
    cards: [card('A', 'h'), card('K', 'd')],
    stack: 300,
    totalInvested: 0,
    bet: 0,
  };
  const players = Array.from({ length: 6 }, (_, i) => ({
    user_id: i ? 'opp' + i : 'hero',
    seat: i,
    cards: [],
    stack: 300,
    totalInvested: 0,
    is_folded: false,
  }));
  const gs: any = {
    stage: 'flop',
    gameMode: 'tournament',
    gameVariant: 'nlh',
    stateSchemaVersion: 1,
    tournament: { contextStatus: 'complete' },
    communityCards: [card('A', 'c'), card('8', 's'), card('4', 'h')],
    players,
    bigBlind: 1,
    legalActions: ['fold', 'call'],
    actionHistory: [{ userId: 'opp1', stage: 'flop', action: 'raise' }],
  };
  const candidate = (action: string, investment: number) => ({
    id: action,
    action,
    amount: null,
    investment,
    stackConservationError: 0,
  });
  const baseline: any = {
    action: 'call',
    thinkTime: 1,
    tournamentUtility: {
      objective: 'mtt',
      overrodeBaseline: false,
      candidates: [candidate('call', 100), candidate('fold', 0)],
    },
  };
  return { hero, gs, baseline };
}
it('assesses the actual full-table baseline without future work', () => {
  const f = fixture();
  const r = evaluateTournamentCatastropheGuard(f.hero, f.gs, f.baseline, 'candidate', () => 1);
  expect(r.decision.action).toBe('fold');
  expect(r.ledger).toMatchObject({
    version: 'horse-tournament-catastrophe-guard-v1',
    policyFamily: 'catastrophe_guard_v1',
    workKind: 'phase7_candidate_guard',
    completed: true,
    applied: true,
    futureGame: null,
    simulationMs: 0,
  });
  expect(
    Object.values(r.ledger.work)
      .filter((x) => typeof x === 'number')
      .every((x) => x === 0)
  ).toBe(true);
});
it('retains an already safe actual baseline and confident Phase7 choice', () => {
  const f = fixture();
  f.baseline.tournamentUtility.candidates[0].investment = 1;
  expect(
    evaluateTournamentCatastropheGuard(f.hero, f.gs, f.baseline, 'candidate', () => 1).decision
  ).toBe(f.baseline);
  f.baseline.tournamentUtility.candidates[0].investment = 100;
  f.baseline.tournamentUtility.overrodeBaseline = true;
  expect(
    evaluateTournamentCatastropheGuard(f.hero, f.gs, f.baseline, 'candidate', () => 1).ledger.reason
  ).toBe('phase7_choice_retained');
});
it('refuses unmodeled, illegal, private or nonconserving alternatives', () => {
  for (const mode of ['unmodeled', 'illegal', 'private', 'conservation']) {
    const f = fixture();
    if (mode === 'unmodeled') f.baseline.tournamentUtility.candidates.pop();
    if (mode === 'illegal') f.gs.legalActions = ['call'];
    if (mode === 'private') f.gs.players[1].cards = [card('Q', 'c')];
    if (mode === 'conservation')
      f.baseline.tournamentUtility.candidates[1].stackConservationError = 1;
    expect(
      evaluateTournamentCatastropheGuard(f.hero, f.gs, f.baseline, 'candidate', () => 1).ledger
        .applied
    ).toBe(false);
  }
});
it('shadow records an assessment without applying', () => {
  const f = fixture();
  const r = evaluateTournamentCatastropheGuard(f.hero, f.gs, f.baseline, 'shadow', () => 1);
  expect(r.decision).toBe(f.baseline);
  expect(r.ledger.changed).toBe(true);
  expect(r.ledger.applied).toBe(false);
});
it('bounds candidate assessment and never labels guard work as continuation', () => {
  for (const mode of ['empty', 'oversized', 'unmodeled', 'negative']) {
    const f = fixture();
    if (mode === 'empty') f.baseline.tournamentUtility.candidates = [];
    if (mode === 'oversized')
      f.baseline.tournamentUtility.candidates = Array(17).fill(
        f.baseline.tournamentUtility.candidates[0]
      );
    if (mode === 'unmodeled') f.baseline.action = 'raise';
    if (mode === 'negative') f.baseline.tournamentUtility.candidates[1].stackConservationError = -1;
    const r = evaluateTournamentCatastropheGuard(f.hero, f.gs, f.baseline, 'candidate', () => 1);
    expect(r.ledger.applied).toBe(false);
    expect(r.ledger.guardWork.candidateCount).toBeLessThanOrEqual(16);
    expect(r.ledger).not.toHaveProperty('continuationPolicy');
    expect(r.ledger).not.toHaveProperty('boundaries');
    expect(r.ledger.guardPolicy).not.toHaveProperty('maxFutureHandSeats');
  }
});
it('uses original full-table public lines and their actual Phase7 baseline', () => {
  const hands: CapturedPhase8Hand[] = JSON.parse(
    readFileSync(new URL('./fixtures/phase8-production-hands.json', import.meta.url), 'utf8')
  );
  const seen = [];
  const savedRandom = saveFastRandom();
  try {
    for (const hand of hands) {
      const { hero, gs } = reconstructPhase8Hand(hand);
      seedFastRandom(hand.reviewId);
      const baseline = HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        { phase8Postflop: 'off', mind: false, decisionTimeMs: 0, telemetry: false }
      );
      const r = evaluateTournamentCatastropheGuard(hero, gs, baseline, 'candidate', () => 1);
      seen.push({
        id: hand.reviewId,
        seats: gs.players.length,
        baseline: baseline.action,
        result: r.decision.action,
        reason: r.ledger.reason,
      });
      expect(gs.players.length).toBeGreaterThan(3);
      expect(gs.players.every((p) => p.cards.length === 0)).toBe(true);
      expect(gs.legalActions).toContain(r.decision.action);
    }
  } finally {
    restoreFastRandom(savedRandom);
  }
  expect(seen.some((x) => x.result === 'fold' && x.baseline !== 'fold')).toBe(true);
});
