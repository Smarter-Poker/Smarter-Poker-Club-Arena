import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  buildJournaledOpponentModel,
  buildScopedOpponentModel,
  SCOPED_MODEL_ACTIONS,
} from './HorseScopedOpponentModel.js';
import { buildJournaledOpponentStudy } from './HorseScopedOpponentHoldout.js';
import {
  adaptiveHandDigest,
  decodeAdaptiveStatistic,
  statisticTuple,
  type AdaptiveStatistic,
} from './HorseAdaptiveStatistics.js';
import type { QualifiedAdaptiveObservation } from './HorseAdaptiveObservation.js';
const now = 1800000000000,
  day = 86400000;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const actor = hash('actor'),
  scope = hash('scope');
function observations(): QualifiedAdaptiveObservation[] {
  return Array.from({ length: 120 }, (_, i) =>
    Array.from({ length: (i % 3) + 1 }, (_, j) => {
      const hand = 'bbbbbbbb-bbbb-4bbb-8bbb-' + i.toString().padStart(12, '0');
      const arm = i % 2 ? 'training' : 'holdout';
      const session =
        (Math.floor(i / 4) * 5 + (arm === 'training' ? 1 : 0)).toString(16).padStart(8, '0') +
        'c'.repeat(56);
      return {
        version: 1,
        observationId: hand + ':' + j,
        handId: hand,
        actorKey: actor,
        sessionKey: session,
        observedAtMs: now - (9 + (i % 10)) * day - j * 700,
        partition: arm,
        scopeKey: scope,
        scope: [],
        action: SCOPED_MODEL_ACTIONS[(i + j) % 5],
        facedBet: true,
        origin: 'horse_policy',
      } as QualifiedAdaptiveObservation;
    })
  ).flat();
}
function compact(raw: readonly QualifiedAdaptiveObservation[]): AdaptiveStatistic[] {
  const groups = new Map<string, AdaptiveStatistic>();
  for (const o of raw) {
    const s: AdaptiveStatistic = {
      handDigest: adaptiveHandDigest(o.handId),
      actorKey: o.actorKey,
      sessionKey: o.sessionKey,
      partition: o.partition,
      scopeKey: o.scopeKey,
      origin: o.origin,
      observedAtMs: o.observedAtMs,
      action: o.action,
      observations: 1,
    };
    const key = JSON.stringify(statisticTuple(s).slice(0, 9)),
      old = groups.get(key);
    groups.set(key, { ...s, observations: (old?.observations ?? 0) + 1 });
  }
  return [...groups.values()];
}
const input = {
  opponentKey: actor,
  scopeKey: scope,
  cohort: 'horse_policy' as const,
  window: { fromMs: now - 30 * day, toMs: now, journalComplete: true },
  prior: {
    version: 'fixed',
    probabilities: { fold: 0.2, check: 0.2, call: 0.2, bet: 0.2, raise: 0.2 },
  },
};
describe('disposed adaptive sufficient statistics', () => {
  it('preserves hand means, session maxima, counts, bounds and holdout diagnostics without original tuples', () => {
    const raw = observations(),
      stats = compact(raw);
    expect(JSON.stringify(stats)).not.toContain(raw[0].handId);
    expect(JSON.stringify(stats)).not.toContain('adaptive-public-node');
    const before = buildJournaledOpponentStudy({ ...input, observations: raw });
    const after = buildJournaledOpponentStudy({ ...input, observations: [], statistics: stats });
    for (const arm of ['training', 'holdout'] as const) {
      const b = before[arm].model,
        a = after[arm].model;
      if (a.status === 'unavailable' || b.status === 'unavailable') throw Error('fit refused');
      expect(a.observations).toBe(b.observations);
      expect(a.hands).toBe(b.hands);
      expect(a.sessions).toBe(b.sessions);
      expect(a.effectiveSessions).toBeCloseTo(b.effectiveSessions, 12);
      for (const action of SCOPED_MODEL_ACTIONS) {
        expect(a.probabilities[action]).toBeCloseTo(b.probabilities[action], 12);
        expect(a.intervals[action][0]).toBeCloseTo(b.intervals[action][0], 12);
        expect(a.intervals[action][1]).toBeCloseTo(b.intervals[action][1], 12);
      }
    }
    expect(after.predictiveDiagnostic.validation.status).toBe(
      before.predictiveDiagnostic.validation.status
    );
    expect(after.predictiveDiagnostic.population).toBe(
      'journaled_qualified_observations_and_disposed_statistics'
    );
  });
  it('preserves arbitrary exact cutoff inside one hand and combines disjoint young raw evidence', () => {
    const raw = observations(),
      first = raw[0];
    raw.push({
      ...first,
      observationId: first.handId + ':99',
      observedAtMs: now - 30 * day - 1,
      action: 'raise',
    });
    raw.push({
      ...first,
      observationId: first.handId + ':100',
      observedAtMs: now - 30 * day,
      action: 'call',
    });
    const aged = raw.filter((o) => o.handId !== raw[3].handId),
      young = raw.filter((o) => o.handId === raw[3].handId);
    const before = buildJournaledOpponentModel({
      ...input,
      partition: 'holdout',
      observations: raw,
    }).model;
    const after = buildJournaledOpponentModel({
      ...input,
      partition: 'holdout',
      observations: young,
      statistics: compact(aged),
    }).model;
    if (before.status === 'unavailable' || after.status === 'unavailable')
      throw Error('fit refused');
    expect(after.observations).toBe(before.observations);
    expect(after.effectiveSessions).toBeCloseTo(before.effectiveSessions, 12);
    expect(after.probabilities.call).toBeCloseTo(before.probabilities.call, 12);
  });
  it('rejects raw/compact overlap and duplicate compactgroups instead of counting twice', () => {
    const raw = observations(),
      stats = compact(raw);
    expect(
      buildJournaledOpponentModel({
        ...input,
        partition: 'holdout',
        observations: raw,
        statistics: stats,
      }).model
    ).toMatchObject({ status: 'unavailable', reason: 'conflicting_observation' });
    expect(
      buildJournaledOpponentModel({
        ...input,
        partition: 'holdout',
        observations: [],
        statistics: [stats[0], stats[0]],
      }).model
    ).toMatchObject({ status: 'unavailable', reason: 'conflicting_observation' });
  });
  it('keeps derived statistics out of a full-source model claim', () => {
    expect(
      buildScopedOpponentModel({
        ...input,
        observerKey: hash('observer'),
        partition: 'holdout',
        observations: [],
        statistics: compact(observations()),
        window: { fromMs: input.window.fromMs, toMs: input.window.toMs, complete: true },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'invalid_input' });
  });
  it('counts represented observations for the budget and refuses malformed statistics', () => {
    const s = compact(observations())[0];
    expect(() =>
      decodeAdaptiveStatistic(
        JSON.stringify([
          1,
          s.handDigest,
          s.actorKey,
          s.sessionKey,
          s.partition,
          s.scopeKey,
          s.origin,
          s.observedAtMs,
          s.action,
          0,
        ])
      )
    ).toThrow('invalid_statistic');
    expect(
      buildJournaledOpponentModel({
        ...input,
        partition: 'holdout',
        observations: [],
        statistics: Array.from({ length: 6 }, (_, i) => ({
          ...s,
          observedAtMs: s.observedAtMs + i,
          observations: 4096,
        })),
      }).model
    ).toMatchObject({ status: 'unavailable', reason: 'input_budget_exceeded' });
  });
});
