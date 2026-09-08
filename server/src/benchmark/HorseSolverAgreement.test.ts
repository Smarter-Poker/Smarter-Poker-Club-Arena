/**
 * V47 (2026-09-05) - the absolute score the league cannot produce.
 *
 * The league measures a DIFFERENCE between two configs of the same brain.
 * This scores the brain against the hold'em push/fold charts: the mean solver
 * frequency of the action the horse actually chose.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildSpots,
  cardsForHandKey,
  stateForSpot,
  actionLabel,
  solverAdvice,
  scoreSolverAgreement,
} from './HorseSolverAgreement.js';
import { setGtoCharts, _clearGtoCharts, gtoChartCount } from '../engine/GtoCharts.js';
import { HorseMind } from '../engine/HorseMind.js';
import { saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';

beforeEach(() => {
  _clearGtoCharts();
  HorseMind.reset();
});
afterEach(() => _clearGtoCharts());

/** A tiny chart: UTG at 10bb jams AA always and 72o never. */
function loadTinyChart(): void {
  setGtoCharts([
    {
      game_type: 'Tournament',
      stack_depth: 10,
      hero_position: 'UTG',
      villain_action: 'fold_to_hero',
      hand_matrix: { AA: { push: 1, fold: 0 }, '72o': { push: 0, fold: 1 } },
    },
    {
      game_type: 'Tournament',
      stack_depth: 8,
      hero_position: 'UTG',
      villain_action: 'fold_to_hero',
      hand_matrix: { AA: { push: 1, fold: 0 }, '72o': { push: 0, fold: 1 } },
    },
  ]);
}

describe('V47 spot construction', () => {
  it('turns a chart hand key into real cards', () => {
    expect(cardsForHandKey('AA')).toHaveLength(2);
    const aks = cardsForHandKey('AKs')!;
    expect(aks[0].suit).toBe(aks[1].suit);
    const ako = cardsForHandKey('AKo')!;
    expect(ako[0].suit).not.toBe(ako[1].suit);
    const pair = cardsForHandKey('QQ')!;
    expect(pair[0].suit).not.toBe(pair[1].suit);
    expect(cardsForHandKey('')).toBeNull();
    expect(cardsForHandKey('XY')).toBeNull();
  });

  it('the spot set covers both references, several depths and both kinds', () => {
    const spots = buildSpots();
    expect(spots.length).toBeGreaterThan(500);
    expect(spots.some((s) => s.isTournament)).toBe(true);
    expect(spots.some((s) => !s.isTournament)).toBe(true);
    expect(spots.some((s) => s.kind === 'open_jam')).toBe(true);
    expect(spots.some((s) => s.kind === 'bb_defend')).toBe(true);
    expect(new Set(spots.map((s) => s.stackBB)).size).toBeGreaterThanOrEqual(3);
  });

  it('an open-jam state puts hero first in with the right depth', () => {
    const { hero, gs } = stateForSpot({
      kind: 'open_jam',
      position: 'BTN',
      stackBB: 10,
      hand: 'AA',
      isTournament: true,
    });
    expect(hero.cards).toHaveLength(2);
    expect(hero.stack).toBe(20); // 10bb at bb=2
    expect(gs.gameVariant).toBe('nlh');
    expect(gs.stage).toBe('preflop');
    // nobody has raised: hero is first in
    expect(gs.currentBet).toBe(gs.bigBlind);
  });

  it('a bb-defend state faces an all-in', () => {
    const { hero, gs } = stateForSpot({
      kind: 'bb_defend',
      position: 'BB',
      stackBB: 12,
      hand: 'AKs',
      isTournament: false,
    });
    expect(gs.currentBet).toBeGreaterThan(gs.bigBlind);
    expect(gs.players.some((p) => p.is_all_in)).toBe(true);
    expect(hero.bet).toBe(gs.bigBlind);
  });

  it('maps a decision onto the solver vocabulary', () => {
    expect(actionLabel('open_jam', 'all_in')).toBe('push');
    expect(actionLabel('open_jam', 'raise')).toBe('push');
    expect(actionLabel('open_jam', 'fold')).toBe('fold');
    expect(actionLabel('open_jam', 'call')).toBe('fold');
    expect(actionLabel('bb_defend', 'call')).toBe('call');
    expect(actionLabel('bb_defend', 'all_in')).toBe('call');
    expect(actionLabel('bb_defend', 'fold')).toBe('fold');
  });
});

describe('V47 scoring', () => {
  it('with no chart store there is no reference and no score', () => {
    expect(gtoChartCount()).toBe(0);
    const r = scoreSolverAgreement(50);
    expect(r.reference).toBeNull();
    expect(r.spots).toBe(0);
    expect(r.agreement).toBe(0);
    expect(r.decisions).toEqual([]);
    expect(r.decisionChecksum).toBeNull();
  });

  it('with a chart it scores, stays in range, and does not move the live RNG', () => {
    loadTinyChart();
    seedFastRandom(12345);
    const before = saveFastRandom();
    const r = scoreSolverAgreement(2000);
    expect(r.reference).toBe('gto_charts');
    expect(r.agreement).toBeGreaterThanOrEqual(0);
    expect(r.agreement).toBeLessThanOrEqual(1);
    expect(r.pureMisses).toBeGreaterThanOrEqual(0);
    expect(r.eligibleSpots).toBe(r.spots);
    expect(r.reconciledSpots).toBe(r.decisions.length);
    expect(r.decisionChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(r.decisions[0]).toMatchObject({
      stateKey: expect.any(String),
      decisionState: {
        schemaVersion: 1,
        stage: 'preflop',
        gameVariant: 'nlh',
        gameType: 'Tournament',
        format: 'mtt',
        kind: 'open_jam',
        position: 'UTG',
        stackBb: 8,
        hand: expect.any(String),
        chart: 'Tournament|fold_to_hero|UTG|8',
        villainAction: 'fold_to_hero',
        legalActions: ['push', 'fold'],
      },
      finalAction: expect.any(String),
      referenceDistribution: expect.any(Object),
      chosenProbability: expect.any(Number),
      sourceSeal: {
        qualitySeal: 'CHART_AUDITED',
        policyChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        provenanceComplete: true,
      },
    });
    // the probe runs inside the live engine process: the stream must resume
    // exactly where it was (the same bracket the league uses).
    expect(saveFastRandom()).toBe(before);
  });

  it('is deterministic - two runs of the same store give the same score', () => {
    loadTinyChart();
    const a = scoreSolverAgreement(2000);
    const b = scoreSolverAgreement(2000);
    expect(b).toEqual(a);
  });

  it('the solver lookup answers only where the chart has a cell', () => {
    loadTinyChart();
    expect(
      solverAdvice({
        kind: 'open_jam',
        position: 'UTG',
        stackBB: 10,
        hand: 'AA',
        isTournament: true,
      })
    ).not.toBeNull();
    // A HAND ABSENT FROM A PRESENT CHART IS A FOLD, not a gap: the solver
    // lists only the hands with a non-fold branch, and GtoCharts.lookup says
    // so deliberately. That is what makes the probe cover the whole grid once
    // a chart exists, rather than only the hands somebody jams.
    const absent = solverAdvice({
      kind: 'open_jam',
      position: 'UTG',
      stackBB: 10,
      hand: 'J4o',
      isTournament: true,
    });
    expect(absent).toMatchObject({
      action: 'fold',
      freq: 1,
      chart: expect.any(String),
      distribution: { push: 0, fold: 1 },
      sourceSeal: { qualitySeal: 'CHART_AUDITED', provenanceComplete: true },
    });
    // a cash spot has no CHART in a tournament-only store, and that is a gap
    expect(
      solverAdvice({
        kind: 'open_jam',
        position: 'UTG',
        stackBB: 10,
        hand: 'AA',
        isTournament: false,
      })
    ).toBeNull();
  });
});
