import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildJournaledOpponentReport,
  processJournaledOpponentModels,
} from './HorseJournaledOpponentModels.js';
import {
  buildJournaledOpponentModel,
  buildScopedOpponentModel,
} from '../engine/HorseScopedOpponentModel.js';
import {
  decodeAdaptiveJournalObservation,
  decodeScopedAdaptiveJournalObservations,
} from './HorseAdaptiveObservationJournal.js';
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mock.rpc } }));
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const NOW = Date.UTC(2026, 8, 14, 11),
  token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  source = 'a'.repeat(40);
const scope = JSON.stringify(['adaptive-public-node-v1', ...Array(28).fill(null)]);
function row(
  i: number,
  arm: 'training' | 'holdout' = 'training',
  origin = 'player',
  action = 'fold'
) {
  const hand = 'bbbbbbbb-bbbb-4bbb-8bbb-' + i.toString().padStart(12, '0');
  const session =
    (Math.floor(i / 4) * 5 + (arm === 'training' ? 1 : 0)).toString(16).padStart(8, '0') +
    'c'.repeat(56);
  return JSON.stringify([
    1,
    hand + ':0',
    hand,
    hash('actor'),
    session,
    NOW - 1000,
    arm,
    hash(scope),
    scope,
    action,
    true,
    origin,
  ]);
}
function claim(rows = Array.from({ length: 160 }, (_, i) => row(i))) {
  rows = [...rows].sort();
  return {
    version: 1,
    status: 'claimed',
    leaseToken: token,
    actorKey: hash('actor'),
    scopeKey: hash(scope),
    fromMs: NOW - 2592000000,
    toMs: NOW,
    snapshotId: '1:2:',
    populationStatus: 'snapshot',
    rows,
    observations: rows.length,
    bytes: rows.reduce((n, r) => n + Buffer.byteLength(r), 0),
    evidenceDigest: hash(rows.join('\n')),
  };
}
function report(c = claim()) {
  const r = buildJournaledOpponentReport(c, token, source);
  expect(r.status).toBe('prepared');
  if (r.status !== 'prepared' || !('cohorts' in r.report)) throw Error('missing computed report');
  return r.report;
}
beforeEach(() => {
  vi.stubEnv('GIT_COMMIT_SHA', source);
  mock.rpc.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe('journal population model consumer', () => {
  it('shares only the exact frozen scope while validating every subsequent row', () => {
    const c = claim(),
      observations = decodeScopedAdaptiveJournalObservations(c.rows, c.scopeKey);
    expect(observations[0].scope).toBe(observations[1].scope);
    expect(Object.isFrozen(observations[0].scope)).toBe(true);
    const changed = JSON.parse(c.rows[1]);
    changed[8] = changed[8].replace('null', 'true');
    expect(() =>
      decodeScopedAdaptiveJournalObservations([c.rows[0], JSON.stringify(changed)], c.scopeKey)
    ).toThrow();
    changed[7] = hash(changed[8]);
    expect(() =>
      decodeScopedAdaptiveJournalObservations([c.rows[0], JSON.stringify(changed)], c.scopeKey)
    ).toThrow();
  });
  it('fits naturally scoped journal rows and records a usable observational estimate without source authority', () => {
    const r = report();
    expect(r).toMatchObject({
      sourceRelease: source,
      sourceCoverage: 'not_established',
      activationAuthorized: false,
      causalEvEstablished: false,
    });
    expect(r.cohorts[0].training.model).toMatchObject({
      status: 'estimated',
      observations: 160,
      sessions: 40,
      hands: 160,
    });
    const m = r.cohorts[0].training.model;
    if (m.status === 'unavailable') throw Error('unexpected refusal');
    expect(m.probabilities.fold).toBeGreaterThan(0.86);
    expect(m.intervals.fold[0]).toBeLessThan(m.probabilities.fold);
    expect(r.cohorts[1].training.model).toMatchObject({
      status: 'insufficient_evidence',
      observations: 0,
    });
    expect(r.cohorts[0].predictiveDiagnostic.validation).toMatchObject({
      status: 'insufficient_evidence',
      activationAuthorized: false,
    });
  });
  it('is reproducible from serialized evidence and isolates heldout and policy-self cohorts', () => {
    const baseline = report();
    expect(report(JSON.parse(JSON.stringify(claim())))).toEqual(baseline);
    const extended = report(
      claim([
        ...claim().rows,
        ...Array.from({ length: 160 }, (_, i) => row(i + 1000, 'holdout', 'player', 'raise')),
        ...Array.from({ length: 160 }, (_, i) => row(i + 2000, 'training', 'horse_policy', 'call')),
      ])
    );
    expect(extended.cohorts[0].training).toEqual(baseline.cohorts[0].training);
    expect(extended.cohorts[0].holdout).not.toEqual(baseline.cohorts[0].holdout);
    expect(extended.cohorts[1].training.model).toMatchObject({
      status: 'estimated',
      observations: 160,
    });
    expect(extended.cohorts[0].predictiveDiagnostic.validation).toMatchObject({
      activationAuthorized: false,
      causalEvEstablished: false,
    });
  });
  it('binds distinct population identities without making the complete-source builder accept a journal', () => {
    const c = claim(),
      observations = c.rows.map(decodeAdaptiveJournalObservation);
    const common = {
      observations,
      scopeKey: c.scopeKey,
      opponentKey: c.actorKey,
      cohort: 'human' as const,
      partition: 'training' as const,
      prior: {
        version: 'prior-v1',
        probabilities: { fold: 0.2, check: 0.2, call: 0.2, bet: 0.2, raise: 0.2 },
      },
    };
    const journal = buildJournaledOpponentModel({
      ...common,
      window: { fromMs: c.fromMs, toMs: c.toMs, journalComplete: true },
    });
    const full = buildScopedOpponentModel({
      ...common,
      observerKey: hash('observer'),
      window: { fromMs: c.fromMs, toMs: c.toMs, complete: true },
    });
    if (journal.model.status === 'unavailable' || full.status === 'unavailable')
      throw Error('missing model');
    expect(journal.model.probabilities).toEqual(full.probabilities);
    expect(journal.model.modelId).not.toBe(full.modelId);
    expect(
      buildScopedOpponentModel({
        ...common,
        observerKey: hash('observer'),
        window: { fromMs: c.fromMs, toMs: c.toMs, complete: false },
      })
    ).toEqual({ status: 'unavailable', reason: 'incomplete_window' });
    expect(
      buildJournaledOpponentModel({
        ...common,
        window: { fromMs: c.fromMs, toMs: c.toMs, journalComplete: false },
      }).model
    ).toMatchObject({ reason: 'incomplete_window' });
  });
  it.each([
    'actorKey',
    'scopeKey',
    'evidenceDigest',
    'leaseToken',
    'fromMs',
    'toMs',
    'snapshotId',
    'bytes',
    'observations',
    'populationStatus',
  ])('refuses a malformed or substituted %s before publishing a fit', (key) => {
    expect(buildJournaledOpponentReport({ ...claim(), [key]: 'invalid' }, token, source)).toEqual({
      status: 'unavailable',
      reason: 'invalid_claim',
    });
  });
  it.each([
    'duplicate',
    'foreign_actor',
    'foreign_scope',
    'future',
    'stale',
    'noncanonical',
    'unsorted',
  ])('rejects %s evidence even when the transport digest matches', (kind) => {
    const rows = claim().rows,
      value = JSON.parse(rows[0]);
    if (kind === 'duplicate') rows.push(rows[0]);
    else if (kind === 'foreign_actor') {
      value[3] = hash('foreign');
      rows[0] = JSON.stringify(value);
    } else if (kind === 'foreign_scope') {
      value[7] = hash('foreign');
      rows[0] = JSON.stringify(value);
    } else if (kind === 'future') {
      value[5] = NOW;
      rows[0] = JSON.stringify(value);
    } else if (kind === 'stale') {
      value[5] = NOW - 2592000001;
      rows[0] = JSON.stringify(value);
    } else if (kind === 'noncanonical') rows[0] += ' ';
    const c = claim(rows);
    if (kind === 'unsorted') {
      c.rows.reverse();
      c.evidenceDigest = hash(c.rows.join('\n'));
    }
    expect(buildJournaledOpponentReport(c, token, source)).toMatchObject({ status: 'unavailable' });
  });
  it.each(['observation_budget_exceeded', 'byte_budget_exceeded'])(
    'stores an explicit %s refusal without fitting truncated data',
    (reason) => {
      const c = {
        ...claim([]),
        populationStatus: reason,
        observations: reason.startsWith('observation') ? 20001 : 1,
        bytes: reason.startsWith('byte') ? 16777217 : 0,
      };
      const r = buildJournaledOpponentReport(c, token, source);
      expect(r).toMatchObject({
        status: 'prepared',
        report: { status: 'refused', reason, activationAuthorized: false },
      });
      expect(r).not.toHaveProperty('report.cohorts');
      expect(buildJournaledOpponentReport({ ...c, rows: [row(1)] }, token, source)).toMatchObject({
        status: 'unavailable',
      });
    }
  );
  it('does not infer sample sufficiency from empty or repeated-session evidence', () => {
    expect(report(claim([])).cohorts[0].training.model).toMatchObject({
      status: 'insufficient_evidence',
      sessions: 0,
    });
    const rows = Array.from({ length: 500 }, (_, i) => {
      const r = JSON.parse(row(i));
      r[4] = '00000001' + 'c'.repeat(56);
      return JSON.stringify(r);
    });
    expect(report(claim(rows)).cohorts[0].training.model).toMatchObject({
      status: 'insufficient_evidence',
      sessions: 1,
      observations: 500,
    });
  });
  it('reaches the real claim-fit-finish service path and checks the exact write acknowledgment', async () => {
    mock.rpc.mockImplementation((name, args) => ({
      abortSignal: vi.fn(async () =>
        name.includes('claim')
          ? { data: { ...claim(), leaseToken: args.p_lease_token }, error: null }
          : {
              data: { version: 1, status: 'recorded', reportDigest: hash(args.p_report) },
              error: null,
            }
      ),
    }));
    expect(await processJournaledOpponentModels()).toBe('recorded');
    expect(mock.rpc.mock.calls.map((c) => c[0])).toEqual([
      'fn_claim_horse_journaled_model',
      'fn_finish_horse_journaled_model',
    ]);
    const submitted = JSON.parse(mock.rpc.mock.calls[1][1].p_report);
    expect(submitted).toMatchObject({
      sourceRelease: source,
      sourceCoverage: 'not_established',
      activationAuthorized: false,
    });
    expect(JSON.stringify(submitted)).not.toContain('cards');
  });
  it.each(['lease_lost', 'capacity_full', 'wrong_digest', 'transport_error', 'throw'])(
    'retains %s as unsuccessful publication',
    async (mode) => {
      mock.rpc.mockImplementation((name, args) => ({
        abortSignal: async () => {
          if (name.includes('claim'))
            return { data: { ...claim(), leaseToken: args.p_lease_token }, error: null };
          if (mode === 'throw') throw Error('network');
          return {
            data: {
              version: 1,
              status: mode === 'wrong_digest' ? 'recorded' : mode,
              reportDigest: hash('wrong'),
            },
            error: mode === 'transport_error' ? 'fail' : null,
          };
        },
      }));
      expect(await processJournaledOpponentModels()).toBe(
        ['lease_lost', 'capacity_full'].includes(mode) ? mode : 'unknown'
      );
    }
  );
  it('requires a full release identity and makes no transport call without one', async () => {
    vi.stubEnv('GIT_COMMIT_SHA', 'shortsha');
    expect(await processJournaledOpponentModels()).toBe('unknown');
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['off', 'disabled'],
    ['invalid', 'unknown'],
  ] as const)(
    'does not claim or publish while the independent model control is %s',
    async (setting, status) => {
      vi.stubEnv('HORSE_JOURNALED_MODELS', setting);
      expect(await processJournaledOpponentModels()).toBe(status);
      expect(mock.rpc).not.toHaveBeenCalled();
    }
  );
});
