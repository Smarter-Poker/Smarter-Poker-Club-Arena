import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildScopedOpponentModel as build,
  SCOPED_MODEL_POLICY as policy,
  type ScopedOpponentModelInput,
  type ScopedOpponentEstimate,
} from './HorseScopedOpponentModel.js';
import type {
  QualifiedAdaptiveObservation,
  AdaptiveAction,
  AdaptivePartition,
} from './HorseAdaptiveObservation.js';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const NOW = Date.UTC(2026, 8, 12, 18),
  DAY = 86_400_000;
const scope = digest('scope'),
  opponent = digest('opponent'),
  observer = digest('observer');
const prior = {
  version: 'frozen-prior-v1',
  probabilities: { fold: 0.2, check: 0.2, call: 0.2, bet: 0.2, raise: 0.2 },
};
function observation(
  n: number,
  session: number,
  action: AdaptiveAction = 'fold',
  partition: AdaptivePartition = 'training'
): QualifiedAdaptiveObservation {
  const handId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  const prefix = (session * 5 + (partition === 'training' ? 1 : 0)).toString(16).padStart(8, '0');
  return {
    version: 1,
    observationId: handId + ':2',
    handId,
    actorKey: opponent,
    sessionKey: prefix + digest(String(session)).slice(8),
    observedAtMs: NOW - 1000,
    partition,
    scopeKey: scope,
    scope: [],
    action,
    facedBet: true,
    origin: 'player',
  };
}
function input(observations: QualifiedAdaptiveObservation[] = []): ScopedOpponentModelInput {
  return {
    observations,
    scopeKey: scope,
    opponentKey: opponent,
    observerKey: observer,
    cohort: 'human',
    partition: 'training',
    window: { fromMs: NOW - 30 * DAY, toMs: NOW, complete: true },
    prior,
  };
}
function population(sessions = 40, action: AdaptiveAction = 'fold') {
  return Array.from({ length: sessions * 4 }, (_, n) => observation(n, Math.floor(n / 4), action));
}
function estimate(value: ScopedOpponentModelInput): ScopedOpponentEstimate {
  const result = build(value);
  expect(result.status).not.toBe('unavailable');
  return result as ScopedOpponentEstimate;
}

describe('bounded scoped opponent reconstruction', () => {
  it('returns the frozen prior with full uncertainty when observations are sparse or absent', () => {
    const none = estimate(input());
    expect(none.status).toBe('insufficient_evidence');
    expect(none.probabilities).toEqual(prior.probabilities);
    expect(none.dataWeight).toBe(0);
    expect(none.intervals.fold).toEqual([0, 1]);
    const one = estimate(input([observation(1, 1)]));
    expect(one.status).toBe('insufficient_evidence');
    expect(one.probabilities.fold).toBeLessThan(0.3);
    expect(one.intervals.fold[1] - one.intervals.fold[0]).toBeGreaterThan(0.7);
  });
  it('contrasting public-node evidence changes probabilities and retains session-level uncertainty', () => {
    const fold = estimate(input(population())),
      raise = estimate(input(population(40, 'raise')));
    expect(fold.status).toBe('estimated');
    expect(raise.status).toBe('estimated');
    expect(fold.probabilities.fold).toBeGreaterThan(0.8);
    expect(raise.probabilities.fold).toBeLessThan(0.04);
    expect(fold.intervals.fold[0]).toBeLessThan(fold.probabilities.fold);
    expect(Object.values(fold.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
  it('reconstructs byte-identically after JSON restart, source reorder and identical duplicate delivery', () => {
    const observations = population(),
      original = estimate(input(observations));
    expect(build(JSON.parse(JSON.stringify(input(observations))))).toEqual(original);
    expect(build(input([...observations].reverse()))).toEqual(original);
    expect(build(input([...observations, ...observations]))).toEqual(original);
  });
  it('does not let held-out data, another scope, another opponent or horse-policy actions alter training', () => {
    const observations = population(),
      original = estimate(input(observations));
    const excluded = Array.from({ length: 20 }, (_, i) =>
      observation(i + 9000, i + 8000, 'raise', 'holdout')
    );
    excluded.push(...population().map((o) => ({ ...o, scopeKey: digest('other scope') })));
    excluded.push(...population().map((o) => ({ ...o, actorKey: observer })));
    excluded.push(...population().map((o) => ({ ...o, origin: 'horse_policy' as const })));
    expect(build(input([...observations, ...excluded]))).toEqual(original);
    const heldOut = build({ ...input(excluded.slice(0, 20)), partition: 'holdout' });
    expect(heldOut.status).not.toBe('unavailable');
    expect((heldOut as ScopedOpponentEstimate).partition).toBe('holdout');
  });
  it('keeps a horse-opponent cohort separate and refuses the observer as its own opponent', () => {
    const observations = population().map((o) => ({ ...o, origin: 'horse_policy' as const }));
    expect(estimate(input(observations)).observations).toBe(0);
    expect(estimate({ ...input(observations), cohort: 'horse_policy' }).observations).toBe(160);
    expect(build({ ...input(observations), opponentKey: observer })).toEqual({
      status: 'unavailable',
      reason: 'self_observation',
    });
  });
  it('cannot become confident from one long session or one hand with thousands of distinct action IDs', () => {
    const long = Array.from({ length: 2000 }, (_, n) => observation(n, 1));
    const a = estimate(input(long));
    expect(a.status).toBe('insufficient_evidence');
    expect(a.effectiveSessions).toBeLessThanOrEqual(1);
    expect(a.probabilities.fold).toBeLessThan(0.3);
    const one = observation(1, 1);
    const manyActions = Array.from({ length: 2000 }, (_, n) => ({
      ...one,
      observationId: one.handId + ':' + n,
    }));
    const b = estimate(input(manyActions));
    expect(b.hands).toBe(1);
    expect(b.status).toBe('insufficient_evidence');
    expect(b.probabilities.fold).toBeCloseTo(a.probabilities.fold, 12);
  });
  it('caps an outlier session even when it supplies most raw observations', () => {
    const baseline = population(),
      before = estimate(input(baseline));
    const outlier = Array.from({ length: 4000 }, (_, n) => observation(n + 10000, 999, 'raise'));
    const after = estimate(input([...baseline, ...outlier]));
    expect(after.probabilities.raise - before.probabilities.raise).toBeLessThan(0.022);
    expect(after.sessions).toBe(41);
  });
  it('decays old sessions, reduces their confidence and shrinks back to the prior', () => {
    const fresh = estimate(input(population()));
    const aged = estimate(input(population().map((o) => ({ ...o, observedAtMs: NOW - 28 * DAY }))));
    expect(aged.effectiveSessions).toBeCloseTo(2.5, 12);
    expect(aged.status).toBe('insufficient_evidence');
    expect(aged.probabilities.fold).toBeLessThan(fresh.probabilities.fold);
    expect(aged.intervals.fold[1] - aged.intervals.fold[0]).toBeGreaterThan(
      fresh.intervals.fold[1] - fresh.intervals.fold[0]
    );
    const expired = estimate(
      input(population().map((o) => ({ ...o, observedAtMs: NOW - 31 * DAY })))
    );
    expect(expired.probabilities).toEqual(prior.probabilities);
    expect(expired.observations).toBe(0);
  });
  it('excludes the upper window boundary and never uses future actions', () => {
    const a = observation(1, 1);
    expect(
      estimate(
        input([
          { ...a, observedAtMs: NOW },
          { ...a, observedAtMs: NOW + DAY },
        ])
      ).observations
    ).toBe(0);
    expect(estimate(input([{ ...a, observedAtMs: NOW - 30 * DAY }])).observations).toBe(1);
  });
  it.each(['action', 'sessionKey', 'observedAtMs', 'facedBet'] as const)(
    'refuses a conflicting duplicate %s independent of input ordering',
    (field) => {
      const a = observation(1, 1),
        values = {
          action: 'raise',
          sessionKey: observation(2, 2).sessionKey,
          observedAtMs: NOW - 2000,
          facedBet: false,
        },
        b = { ...a, [field]: values[field] } as QualifiedAdaptiveObservation;
      for (const rows of [
        [a, b],
        [b, a],
      ])
        expect(build(input(rows))).toEqual({
          status: 'unavailable',
          reason: 'conflicting_observation',
        });
    }
  );
  it('refuses inconsistent dealt sessions within one opponent hand', () => {
    const a = observation(1, 1),
      b = { ...a, observationId: a.handId + ':3', sessionKey: observation(2, 2).sessionKey };
    expect(build(input([a, b]))).toEqual({
      status: 'unavailable',
      reason: 'conflicting_observation',
    });
  });
  it('requires complete input and never silently truncates an oversized population', () => {
    expect(build({ ...input(), window: { ...input().window, complete: false } })).toEqual({
      status: 'unavailable',
      reason: 'incomplete_window',
    });
    expect(build(input(new Array(policy.maxInputObservations + 1)))).toEqual({
      status: 'unavailable',
      reason: 'input_budget_exceeded',
    });
  });
  it('validates fixed priors and rejects observations outside their supported actions', () => {
    expect(
      build({
        ...input(),
        prior: { ...prior, probabilities: { ...prior.probabilities, fold: NaN } },
      })
    ).toEqual({ status: 'unavailable', reason: 'invalid_input' });
    expect(
      build({
        ...input([observation(1, 1)]),
        prior: { ...prior, probabilities: { ...prior.probabilities, fold: 0, raise: 0.4 } },
      })
    ).toEqual({ status: 'unavailable', reason: 'prior_support_mismatch' });
  });
  it('binds the identity to prior version, probabilities, window, node and selected evidence', () => {
    const i = input(population()),
      base = estimate(i);
    expect(estimate({ ...i, prior: { ...prior, version: 'prior-v2' } }).modelId).not.toBe(
      base.modelId
    );
    expect(estimate({ ...i, window: { ...i.window, fromMs: NOW - 29 * DAY } }).modelId).not.toBe(
      base.modelId
    );
    expect(
      estimate({
        ...i,
        prior: { ...prior, probabilities: { ...prior.probabilities, fold: 0.1, call: 0.3 } },
      }).modelId
    ).not.toBe(base.modelId);
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.probabilities)).toBe(true);
    expect(Object.isFrozen(base.intervals.fold)).toBe(true);
  });
  it('preserves conservative interval coverage in frozen independent-session Bernoulli populations', () => {
    let seed = 4171,
      covered = 0;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 200; trial++) {
      const p = [0.05, 0.2, 0.5, 0.8, 0.95][trial % 5];
      const rows = Array.from({ length: 60 }, (_, session) =>
        observation(session, session, random() < p ? 'fold' : 'call')
      );
      const result = estimate(input(rows)),
        [lower, upper] = result.intervals.fold;
      if (lower <= p && p <= upper) covered++;
    }
    expect(covered).toBeGreaterThanOrEqual(190);
  });
});
