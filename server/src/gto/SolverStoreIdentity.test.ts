/**
 * Phase 6C G4: a solver store is identified by its content, never by its
 * size. The planted-red cases are two stores with the same number of entries
 * and one different frequency: a row count cannot tell them apart, and before
 * 2026-09-27 the replay compared nothing else.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SOLVER_STORE_IDENTITY_VERSION,
  isHorseSolverStoreIdentity,
  latestRevision,
  sameSolverStoreIdentity,
  solverStoreIdentity,
} from './SolverStoreIdentity.js';
import { _clearGtoCharts, gtoChartStoreIdentity, setGtoCharts } from '../engine/GtoCharts.js';
import {
  _clearGtoPostflop,
  gtoPostflopStoreIdentity,
  replaceGtoPostflop,
  setGtoPostflop,
} from '../engine/GtoPostflop.js';
import { _clearSolverPolicyArtifactsForTests } from './SolverPolicyArtifactLoader.js';

const cell = (over: Record<string, unknown> = {}) => ({
  street: 'flop',
  game_family: 'cash',
  position: 'BTN',
  depth_bucket: 40,
  texture_class: 'Btuc',
  facing: 'open',
  hand_matrix: { AKs: { check: 0.4, bet_small: 0.6 }, QQ: { check: 1 } },
  ...over,
});
const chart = (over: Record<string, unknown> = {}) => ({
  game_type: 'Tournament',
  hero_position: 'BTN',
  stack_depth: 10,
  villain_action: 'fold_to_hero',
  hand_matrix: { AA: { push: 1, fold: 0 }, A5s: { push: 0.964, fold: 0.036 } },
  created_at: '2026-07-19T15:11:46.133718+00:00',
  ...over,
});

beforeEach(() => {
  _clearGtoCharts();
  _clearGtoPostflop();
  _clearSolverPolicyArtifactsForTests();
});

describe('solver store identity is content, not size', () => {
  it('ignores insertion order and object key order, and names the empty store', () => {
    const a = new Map<string, unknown>([
      ['x', { b: 1, a: 2 }],
      ['y', { c: 3 }],
    ]);
    const b = new Map<string, unknown>([
      ['y', { c: 3 }],
      ['x', { a: 2, b: 1 }],
    ]);
    expect(solverStoreIdentity(a, null)).toEqual(solverStoreIdentity(b, null));
    const empty = solverStoreIdentity(new Map(), null);
    expect(empty.rows).toBe(0);
    expect(empty.version).toBe(SOLVER_STORE_IDENTITY_VERSION);
    expect(empty.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('planted red: the same count with one moved frequency is a different store', () => {
    const a = solverStoreIdentity(new Map([['k', { AKs: { check: 0.4, bet_small: 0.6 } }]]), null);
    const b = solverStoreIdentity(
      new Map([['k', { AKs: { check: 0.395, bet_small: 0.605 } }]]),
      null
    );
    expect(a.rows).toBe(b.rows);
    expect(a.digest).not.toBe(b.digest);
    expect(sameSolverStoreIdentity(a, b)).toBe(false);
  });

  it('compares revision only when both sides know it', () => {
    const map = new Map([['k', 1]]);
    const r1 = solverStoreIdentity(map, '2026-09-03 18:18:13.594197+00');
    const r2 = solverStoreIdentity(map, '2026-09-04 00:00:00+00');
    expect(sameSolverStoreIdentity(r1, solverStoreIdentity(map, null))).toBe(true);
    expect(sameSolverStoreIdentity(r1, r2)).toBe(false);
  });

  it('takes the latest instant as the revision, not the latest string', () => {
    expect(
      latestRevision(['2026-07-19T15:11:48.5+00:00', '2026-07-19T10:11:49-06:00', null, 'x'])
    ).toBe('2026-07-19T10:11:49-06:00');
    expect(latestRevision([])).toBeNull();
  });

  it('refuses a malformed identity shape', () => {
    const ok = solverStoreIdentity(new Map(), null);
    expect(isHorseSolverStoreIdentity({ charts: ok, postflop: ok })).toBe(true);
    expect(isHorseSolverStoreIdentity({ charts: ok })).toBe(false);
    expect(isHorseSolverStoreIdentity({ charts: { ...ok, digest: 'abc' }, postflop: ok })).toBe(
      false
    );
    expect(isHorseSolverStoreIdentity({ charts: { ...ok, rows: -1 }, postflop: ok })).toBe(false);
  });
});

describe('the store modules compute the identity of what they swap in', () => {
  it('the chart store identity follows the rows setGtoCharts accepted, with their revision', () => {
    expect(gtoChartStoreIdentity().rows).toBe(0);
    setGtoCharts([
      chart(),
      chart({ hero_position: 'SB', created_at: '2026-07-19T15:11:48.555537+00:00' }),
    ] as never);
    const first = gtoChartStoreIdentity();
    expect(first.rows).toBe(2);
    expect(first.revision).toBe('2026-07-19T15:11:48.555537+00:00');
    // Same two charts, one frequency moved: same count, different identity.
    setGtoCharts([
      chart({ hand_matrix: { AA: { push: 1, fold: 0 }, A5s: { push: 0.954, fold: 0.046 } } }),
      chart({ hero_position: 'SB', created_at: '2026-07-19T15:11:48.555537+00:00' }),
    ] as never);
    expect(gtoChartStoreIdentity().rows).toBe(2);
    expect(gtoChartStoreIdentity().digest).not.toBe(first.digest);
  });

  it('a rejected chart refresh keeps the last good identity', () => {
    setGtoCharts([chart()] as never);
    const good = gtoChartStoreIdentity();
    expect(() => setGtoCharts([chart(), chart()] as never)).toThrow();
    expect(gtoChartStoreIdentity()).toEqual(good);
  });

  it('the postflop store identity carries the loader revision and changes with content', () => {
    replaceGtoPostflop(
      [cell(), cell({ street: 'turn' })] as never,
      '2026-09-03 18:18:13.594197+00'
    );
    const first = gtoPostflopStoreIdentity();
    expect(first).toMatchObject({ rows: 2, revision: '2026-09-03 18:18:13.594197+00' });
    replaceGtoPostflop(
      [
        cell({ hand_matrix: { AKs: { check: 0.41, bet_small: 0.59 }, QQ: { check: 1 } } }),
        cell({ street: 'turn' }),
      ] as never,
      '2026-09-03 18:18:13.594197+00'
    );
    expect(gtoPostflopStoreIdentity().rows).toBe(2);
    expect(gtoPostflopStoreIdentity().digest).not.toBe(first.digest);
    expect(() => replaceGtoPostflop([cell({ facing: 'bet' })] as never)).toThrow();
    expect(gtoPostflopStoreIdentity().rows).toBe(2);
  });

  it('an additive test write is re-digested and carries no revision', () => {
    replaceGtoPostflop([cell()] as never, 'r1');
    setGtoPostflop([cell({ street: 'river' })] as never);
    const id = gtoPostflopStoreIdentity();
    expect(id.rows).toBe(2);
    expect(id.revision).toBeNull();
    replaceGtoPostflop([cell(), cell({ street: 'river' })] as never, null);
    expect(gtoPostflopStoreIdentity().digest).toBe(id.digest);
  });
});
