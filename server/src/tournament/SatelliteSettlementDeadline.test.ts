import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Actual SDK and bounded fetch; receipt contents have their own exhaustive suite.
vi.mock('../services/supabase.js', async () => import('../services/supabase/client.js'));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./satelliteSettlementReceipt.js', () => ({
  verifySatelliteSettlementReceipt: (value: unknown) =>
    value && typeof value === 'object' && 'stored' in value ? value : null,
}));
vi.mock('./satelliteQualifierReceipt.js', () => ({
  verifySatelliteQualifierReceipt: (value: unknown) =>
    value && typeof value === 'object' && 'stored' in value ? value : null,
}));
const tournamentId = '00000000-0000-4000-8000-000000000001';
const winnerId = '00000000-0000-4000-8000-000000000002';
const stored = { stored: true };
let request: typeof import('./satelliteSettlementRpc.js').requestSatelliteSettlementReceipt;
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('SUPABASE_TIMEOUT_MS', '15000');
  vi.stubEnv('MAINTENANCE_SUPABASE_TIMEOUT_MS', '50000');
  vi.stubEnv('SUPABASE_URL', 'https://supabase.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'unit-test-placeholder-key');
  ({ requestSatelliteSettlementReceipt: request } = await import('./satelliteSettlementRpc.js'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function delayed(value: unknown, ms: number): Promise<Response> {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve(
          new Response(JSON.stringify(value), {
            headers: { 'content-type': 'application/json' },
          })
        ),
      ms
    )
  );
}
function observe() {
  return request(tournamentId, winnerId, { attempts: 1 }).then(
    (value) => ({ value, error: null }),
    (error: Error) => ({ value: null, error })
  );
}
describe('satellite transport outlasts the database statement budget', () => {
  it('receives a 20-second settlement without abandoning it at 15 seconds', async () => {
    const transport = vi.fn(() => delayed(stored, 20_000));
    vi.stubGlobal('fetch', transport);
    const outcome = observe();
    await vi.advanceTimersByTimeAsync(20_001);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await outcome).toEqual({ value: stored, error: null });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for a 40-second serialized resolver after a lost write response', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockImplementation(() =>
        delayed(
          {
            ok: true,
            satellite_committed: true,
            definitively_not_committed: false,
            status: 'COMPLETED',
            tournament_id: tournamentId,
            winner_id: winnerId,
            receipt: stored,
          },
          40_000
        )
      );
    vi.stubGlobal('fetch', transport);
    const outcome = observe();
    await vi.advanceTimersByTimeAsync(40_001);
    expect(await outcome).toEqual({ value: stored, error: null });
    expect(transport).toHaveBeenCalledTimes(2);
    const calls = transport.mock.calls;
    expect(String(calls[1][0])).toContain('/rpc/fn_resolve_satellite_settlement_outcome');
    expect(calls[1][1].body).toBe(calls[0][1].body);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds an uncooperative transport and preserves unknown outcome', async () => {
    const transport = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', transport);
    const outcome = observe();
    await vi.advanceTimersByTimeAsync(100_001);
    expect((await outcome).error?.name).toBe('SatelliteSettlementOutcomeUnknownError');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('multi-qualifier satellite transport has the same authority budget', () => {
  it('receives the 20-second qualifier settlement', async () => {
    const { requestSatelliteQualifierReceipt } = await import('./satelliteQualifierRpc.js');
    const transport = vi.fn(() => delayed(stored, 20_000));
    vi.stubGlobal('fetch', transport);
    const outcome = requestSatelliteQualifierReceipt(tournamentId, [winnerId], {
      resolverAttempts: 1,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await outcome).toEqual(stored);
  });
  it('receives a serialized qualifier outcome after 25 seconds', async () => {
    const { requestSatelliteQualifierReceipt } = await import('./satelliteQualifierRpc.js');
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockImplementation(() =>
        delayed(
          {
            ok: true,
            satellite_committed: true,
            definitively_not_committed: false,
            status: 'COMPLETED',
            tournament_id: tournamentId,
            qualifier_ids: [winnerId],
            receipt: stored,
          },
          25_000
        )
      );
    vi.stubGlobal('fetch', transport);
    const outcome = requestSatelliteQualifierReceipt(tournamentId, [winnerId], {
      resolverAttempts: 1,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25_001);
    expect(await outcome).toEqual(stored);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body);
  });
  it('receives the serialized eligibility answer after 20 seconds', async () => {
    const { readSatelliteQualifierState } = await import('./satelliteQualifierRpc.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => delayed({ ok: true, tournament_id: tournamentId, state: 'entry_open' }, 20_000))
    );
    const outcome = readSatelliteQualifierState(tournamentId).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await outcome).toEqual({ state: 'entry_open' });
  });
});
