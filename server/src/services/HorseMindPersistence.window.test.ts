import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  rows: new Map<string, Array<Record<string, unknown>>>(),
  requests: [] as Array<{ table: string; columns: string }>,
  fail: null as null | { code: string; message: string },
  legacy: false,
  rpc: vi.fn(),
  report: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  supabase: {
    rpc: transport.rpc,
    from: (table: string) => ({
      select: (columns: string) => {
        transport.requests.push({ table, columns });
        const read = async () => {
          const error =
            transport.fail ??
            (transport.legacy && columns.includes('source_window')
              ? { code: '42703', message: `column ${table}.source_window does not exist` }
              : null);
          return { error, data: error ? null : structuredClone(transport.rows.get(table) ?? []) };
        };
        const chain = { order: () => chain, limit: read, range: read };
        return chain;
      },
    }),
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: transport.report }));
import { HorseMind } from '../engine/HorseMind.js';
import {
  flushHorseMind,
  flushHorseMindScoped,
  hydrateHorseMindFromDb,
} from './HorseMindPersistence.js';

const complete = { version: 1, coverage: 'complete', fromMs: 100, toMs: 250 } as const;
const unknown = { version: 1, coverage: 'unknown', fromMs: null, toMs: null } as const;
const dbRow = (extra: Record<string, unknown> = {}) => ({
  user_id: 'same-actor',
  hands: 2,
  vpip: 1,
  pfr: 1,
  three_bet: 0,
  aggr: 1,
  passive: 1,
  folds: 0,
  faced_aggr: 1,
  r_hands: 2,
  r_folds: 0,
  r_faced_aggr: 1,
  r_aggr: 1,
  r_passive: 1,
  updated_at: '2026-09-30T23:00:00.000Z',
  ...extra,
});

beforeEach(() => {
  HorseMind.reset();
  transport.rows.clear();
  transport.requests.length = 0;
  transport.legacy = false;
  transport.fail = null;
  transport.report.mockReset();
  transport.rpc.mockReset().mockImplementation(async (name, { rows }) => {
    const table =
      name === 'upsert_horse_mind_stats' ? 'horse_mind_stats' : 'horse_mind_stats_scoped';
    transport.rows.set(table, structuredClone(rows));
    return { data: rows.length, error: null };
  });
});

describe('original observation-window service persistence', () => {
  it('carries original windows through actual pooled/scoped RPC mapping and restart hydration', async () => {
    HorseMind.importStats([{ user_id: 'same-actor', hands: 2, vpip: 1, sourceWindow: complete }]);
    HorseMind.importScoped([
      {
        user_id: 'same-actor',
        scope: 'omaha:short',
        hands: 3,
        sourceWindow: { ...complete, fromMs: 600, toMs: 700 },
      },
    ]);
    HorseMind.requeueDirty(['same-actor']);
    HorseMind.requeueDirtyScoped([{ user_id: 'same-actor', scope: 'omaha:short' }]);
    expect(await flushHorseMind()).toEqual({ flushed: 1, failed: 0 });
    expect(await flushHorseMindScoped()).toEqual({ flushed: 1, failed: 0 });
    expect(transport.rows.get('horse_mind_stats')?.[0]).toMatchObject({
      user_id: 'same-actor',
      hands: 2,
      source_window: complete,
    });
    expect(transport.rows.get('horse_mind_stats_scoped')?.[0]).toMatchObject({
      scope: 'omaha:short',
      hands: 3,
      source_window: { ...complete, fromMs: 600, toMs: 700 },
    });
    HorseMind.reset();
    await hydrateHorseMindFromDb();
    expect(HorseMind.getStats('same-actor')?.sourceWindow).toEqual(complete);
    expect(HorseMind.getScopedStats('same-actor', 'omaha:short')?.sourceWindow).toEqual({
      ...complete,
      fromMs: 600,
      toMs: 700,
    });
    expect(HorseMind.getScopedStats('same-actor', 'holdem:short')).toBeUndefined();
    expect(
      transport.requests
        .filter((r) => r.table !== 'horse_mind_pairs')
        .every((r) => r.columns.includes('source_window'))
    ).toBe(true);
    expect(transport.report).not.toHaveBeenCalled();
  });

  it('loads an old schema once with legacy projection and reports its history as unknown', async () => {
    transport.legacy = true;
    transport.rows.set('horse_mind_stats', [dbRow()]);
    transport.rows.set('horse_mind_stats_scoped', [dbRow({ scope: 'holdem:hu' })]);
    expect(await hydrateHorseMindFromDb()).toBe('2026-09-30T23:00:00.000Z');
    expect(HorseMind.getStats('same-actor')?.hands).toBe(2);
    expect(HorseMind.getStats('same-actor')?.sourceWindow).toEqual(unknown);
    expect(HorseMind.getScopedStats('same-actor', 'holdem:hu')?.sourceWindow).toEqual(unknown);
    for (const table of ['horse_mind_stats', 'horse_mind_stats_scoped']) {
      const requests = transport.requests.filter((r) => r.table === table);
      expect(requests).toHaveLength(2);
      expect(requests[0].columns).toContain('source_window');
      expect(requests[1].columns).not.toContain('source_window');
    }
    expect(transport.report).not.toHaveBeenCalled();
  });

  it.each([
    { code: '42501', message: 'permission denied for source_window' },
    { code: '42703', message: 'column hands does not exist' },
  ])('does not mask an unrelated hydrate failure: $message', async (error) => {
    transport.fail = error;
    expect(await hydrateHorseMindFromDb()).toBeNull();
    for (const table of ['horse_mind_stats', 'horse_mind_stats_scoped'])
      expect(transport.requests.filter((r) => r.table === table)).toHaveLength(1);
    expect(transport.report).toHaveBeenCalled();
  });

  it('normalizes malformed persisted times without using the flush timestamp as history', async () => {
    transport.rows.set('horse_mind_stats', [dbRow({ source_window: { ...complete, fromMs: -1 } })]);
    transport.rows.set('horse_mind_stats_scoped', [
      dbRow({ scope: 'holdem:hu', source_window: null }),
    ]);
    await hydrateHorseMindFromDb();
    expect(HorseMind.getStats('same-actor')?.sourceWindow).toEqual(unknown);
    expect(HorseMind.getScopedStats('same-actor', 'holdem:hu')?.sourceWindow).toEqual(unknown);
  });
});
