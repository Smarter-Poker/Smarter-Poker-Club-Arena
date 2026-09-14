import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  validateScopedOpponentHoldout as validate,
  type ScopedHoldoutInput,
} from './HorseScopedOpponentHoldout.js';
import { buildScopedOpponentModel, SCOPED_MODEL_ACTIONS } from './HorseScopedOpponentModel.js';
import type {
  QualifiedAdaptiveObservation,
  AdaptivePartition,
  AdaptiveAction,
} from './HorseAdaptiveObservation.js';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const now = Date.UTC(2026, 8, 14),
  actor = digest('opponent'),
  observer = digest('observer'),
  scope = digest('node');
const prior = {
  version: 'fixture-prior-1',
  probabilities: { fold: 0.2, check: 0.2, call: 0.2, bet: 0.2, raise: 0.2 },
};
function population(
  partition: AdaptivePartition,
  action: AdaptiveAction = 'fold',
  sessions = 400
): QualifiedAdaptiveObservation[] {
  return Array.from({ length: sessions * 4 }, (_, n) => {
    const handId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n + (partition === 'holdout' ? 100000 : 0)).padStart(12, '0')}`;
    const session = Math.floor(n / 4),
      prefix = (session * 5 + (partition === 'training' ? 1 : 0)).toString(16).padStart(8, '0');
    return {
      version: 1,
      observationId: handId + ':0',
      handId,
      actorKey: actor,
      sessionKey: prefix + digest(String(session)).slice(8),
      observedAtMs: now - 1000,
      partition,
      scopeKey: scope,
      scope: [],
      action,
      facedBet: true,
      origin: 'player',
    };
  });
}
function input(
  training = population('training'),
  heldout = population('holdout')
): ScopedHoldoutInput {
  return {
    observations: [...training, ...heldout],
    scopeKey: scope,
    opponentKey: actor,
    observerKey: observer,
    cohort: 'human',
    window: { fromMs: now - 86400000, toMs: now, complete: true },
    prior,
  };
}
function result(i: ScopedHoldoutInput) {
  const r = validate(i);
  if (r.status === 'unavailable') throw Error(r.reason);
  return r;
}

describe('scoped independent-session predictive holdout', () => {
  it('scores withheld actions against the trained forecast, never the shrunk holdout point', () => {
    const i = input(),
      r = result(i),
      candidate = buildScopedOpponentModel({ ...i, partition: 'training' });
    if (candidate.status === 'unavailable') throw Error(candidate.reason);
    const loss = (p: typeof prior.probabilities, a: AdaptiveAction) =>
      SCOPED_MODEL_ACTIONS.reduce((v, k) => v + (p[k] - (k === a ? 1 : 0)) ** 2, 0);
    const independentGain =
      loss(prior.probabilities, 'fold') - loss(candidate.probabilities, 'fold');
    expect(r.brierImprovement).toBeCloseTo(independentGain, 12);
    expect(r.status).toBe('predictive_improvement');
    expect(r.interval[0]).toBeGreaterThan(0);
    expect(r.interval[0]).toBeLessThanOrEqual(independentGain);
    expect(r.interval[1]).toBeGreaterThanOrEqual(independentGain);
    expect(r.causalEvEstablished).toBe(false);
    expect(r.activationAuthorized).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.interval)).toBe(true);
  });
  it('detects a model that fits training and predicts the independent population worse', () => {
    const r = result(input(population('training'), population('holdout', 'raise')));
    expect(r.status).toBe('predictive_regression');
    expect(r.brierImprovement).toBeLessThan(0);
    expect(r.interval[1]).toBeLessThan(0);
    expect(r.activationAuthorized).toBe(false);
  });
  it('holdout changes the score but cannot change the candidate identity', () => {
    const a = result(input()),
      b = result(input(population('training'), population('holdout', 'call')));
    expect(a.trainingModelId).toBe(b.trainingModelId);
    expect(a.trainingEvidenceDigest).toBe(b.trainingEvidenceDigest);
    expect(a.heldoutEvidenceDigest).not.toBe(b.heldoutEvidenceDigest);
    expect(a.validationId).not.toBe(b.validationId);
  });
  it('replays exactly after restart, input reordering and duplicate delivery', () => {
    const i = input(),
      r = result(i);
    expect(validate(JSON.parse(JSON.stringify(i)))).toEqual(r);
    expect(validate({ ...i, observations: [...i.observations].reverse() })).toEqual(r);
    expect(validate({ ...i, observations: [...i.observations, ...i.observations] })).toEqual(r);
  });
  it.each(['training', 'holdout'] as const)(
    'one long %s session cannot establish support',
    (partition) => {
      const pop = population(partition),
        long = pop.map((o) => ({ ...o, sessionKey: pop[0].sessionKey }));
      const r = result(
        partition === 'training'
          ? input(long, population('holdout'))
          : input(population('training'), long)
      );
      expect(r.status).toBe('insufficient_evidence');
    }
  );
  it('caps one oversized heldout outlier session instead of grading every action as independent', () => {
    const baseline = population('holdout'),
      outlier = population('holdout', 'raise', 2000).map((o, n) => ({
        ...o,
        handId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`,
        observationId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}:0`,
        sessionKey: '00002710' + digest('outlier').slice(8),
      }));
    const a = result(input()),
      b = result(input(population('training'), [...baseline, ...outlier]));
    expect(b.heldoutSessions).toBe(401);
    expect(Math.abs(b.brierImprovement! - a.brierImprovement!)).toBeLessThan(0.01);
    expect(b.status).toBe('predictive_improvement');
  });
  it('refuses one physical hand relabeled into the other partition', () => {
    const t = population('training'),
      h = population('holdout');
    h[0] = { ...h[0], handId: t[0].handId, observationId: t[0].handId + ':1' };
    expect(validate(input(t, h))).toEqual({ status: 'unavailable', reason: 'partition_overlap' });
  });
  it('never converts incomplete source coverage into a validation verdict', () => {
    const i = input();
    expect(validate({ ...i, window: { ...i.window, complete: false } })).toEqual({
      status: 'unavailable',
      reason: 'incomplete_window',
    });
  });
  it('keeps absent and insufficient heldout populations unsupported', () => {
    const none = result(input(population('training'), []));
    expect(none.status).toBe('insufficient_evidence');
    expect(none.brierImprovement).toBeNull();
    expect(result(input(population('training'), population('holdout', 'fold', 19))).status).toBe(
      'insufficient_evidence'
    );
  });
  it('does not turn an unchanged uniform forecast into positive support through rounding', () => {
    const uniform = (p: AdaptivePartition) =>
      population(p).map((o, n) => ({ ...o, action: SCOPED_MODEL_ACTIONS[n % 5] }));
    const r = result(input(uniform('training'), uniform('holdout')));
    expect(r.status).toBe('inconclusive');
    expect(r.brierImprovement).toBeCloseTo(0, 12);
  });
  it('retains node, actor, cohort and policy identity boundaries', () => {
    const i = input(),
      r = result(i),
      excluded = population('holdout', 'raise').map((o) => ({
        ...o,
        scopeKey: digest('other node'),
      }));
    expect(validate({ ...i, observations: [...i.observations, ...excluded] })).toEqual(r);
    expect(result({ ...i, prior: { ...prior, version: 'fixture-prior-2' } }).validationId).not.toBe(
      r.validationId
    );
    expect(validate({ ...i, opponentKey: observer })).toEqual({
      status: 'unavailable',
      reason: 'self_observation',
    });
    expect(result({ ...i, cohort: 'horse_policy' }).status).toBe('insufficient_evidence');
  });
  it('refuses malformed or oversized source evidence', () => {
    expect(validate(null as unknown as ScopedHoldoutInput).status).toBe('unavailable');
    const i = input();
    expect(validate({ ...i, observations: Array(20001).fill(i.observations[0]) })).toEqual({
      status: 'unavailable',
      reason: 'input_budget_exceeded',
    });
    const t = population('training'),
      h = population('holdout');
    h[0] = { ...h[0], sessionKey: t[0].sessionKey };
    expect(validate(input(t, h))).toEqual({ status: 'unavailable', reason: 'invalid_observation' });
  });
});
