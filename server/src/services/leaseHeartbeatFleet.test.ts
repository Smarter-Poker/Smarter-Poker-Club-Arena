import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const generation = 'bbbbbbbb-0000-4000-8000-000000000001';
const id = (index: number) => `aaaaaaaa-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const successor = 'bbbbbbbb-0000-4000-8000-000000000002';
type RpcClaim = { tournament_id?: string; table_id?: string; lease_generation: string };
const capture = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    tournamentId: id(index),
    tableId: id(index),
    leaseGeneration: generation,
  }));
const kept = (claims: RpcClaim[]) => ({
  data: claims.slice(0, 1_000).map((claim) => ({ ...claim, state: 'kept' })),
  error: null,
});

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(['tournament', 'table'] as const)('%s heartbeat fleet', (scope) => {
  const lostKey = scope === 'tournament' ? 'lostTournamentIds' : 'lostTableIds';
  const inputKey = scope === 'tournament' ? 'tournamentId' : 'tableId';
  const rowKey = scope === 'tournament' ? 'tournament_id' : 'table_id';
  async function load() {
    if (scope === 'tournament') {
      const lease = await import('./tournamentLease.js');
      return {
        heartbeat: lease.heartbeatTournaments,
        setNow: lease._setTournamentLeaseMonotonicNowForTests,
      };
    }
    const lease = await import('./tableLease.js');
    return { heartbeat: lease.heartbeatTables, setNow: lease._setTableLeaseMonotonicNowForTests };
  }
  it.each([499, 500, 501, 1_000, 1_001, 1_008, 2_501])(
    'renews all %i leases through a 1,000-row cap',
    async (count) => {
      rpc.mockImplementation(async (_name, args) => ({
        data: args.p_claims.slice(0, 1_000).map((claim: object) => ({ ...claim, state: 'kept' })),
        error: null,
      }));
      const claims = Array.from({ length: count }, (_, index) => ({
        [`${scope}Id`]: id(index),
        leaseGeneration: generation,
      }));
      const result =
        scope === 'tournament'
          ? await (await import('./tournamentLease.js')).heartbeatTournaments(claims as never)
          : await (await import('./tableLease.js')).heartbeatTables(claims as never);
      expect(result.status).toBe('answered');
      if (result.status !== 'answered') throw new Error('expected exact answers');
      expect(result.proofs).toHaveLength(count);
      expect(rpc).toHaveBeenCalledTimes(Math.ceil(count / 500));
      expect(result).toHaveProperty(
        scope === 'tournament' ? 'lostTournamentIds' : 'lostTableIds',
        []
      );
      expect(rpc.mock.calls.every(([, args]) => args.p_claims.length <= 500)).toBe(true);
    }
  );

  it.each(['duplicate', 'case alias', 'invalid generation', 'invalid id'])(
    'rejects a cross-batch %s before renewing any lease',
    async (kind) => {
      const claims = capture(1_008);
      if (kind === 'duplicate') claims[1_000][inputKey] = claims[0][inputKey];
      if (kind === 'case alias') claims[1_000][inputKey] = claims[0][inputKey].toUpperCase();
      if (kind === 'invalid generation') claims[1_000].leaseGeneration = 'invalid';
      if (kind === 'invalid id') claims[1_000][inputKey] = 'invalid';
      expect(await (await load()).heartbeat(claims)).toEqual({
        status: 'answered',
        proofs: [],
        [lostKey]: claims.map((claim) => claim[inputKey]),
      });
      expect(rpc).not.toHaveBeenCalled();
    }
  );

  it.each(['rpc error', 'rpc throw', 'short', 'duplicate row', 'foreign row'])(
    'retains only independently proven answers beside one %s batch',
    async (kind) => {
      rpc.mockImplementation(async (_name, args) => {
        const result = kept(args.p_claims);
        if (args.p_claims[0][rowKey] !== id(500)) return result;
        if (kind === 'rpc error') return { data: null, error: { message: 'unavailable' } };
        if (kind === 'rpc throw') throw new Error('transport failed');
        if (kind === 'short') result.data.pop();
        if (kind === 'duplicate row') result.data[1] = { ...result.data[0] };
        if (kind === 'foreign row') result.data[1] = { ...result.data[1], [rowKey]: id(0) };
        return result;
      });
      const result = await (await load()).heartbeat(capture(1_008));
      expect(result.status).toBe('answered');
      if (result.status !== 'answered') throw new Error('expected independent answers');
      expect(result.proofs).toHaveLength(508);
      expect(result).toHaveProperty(
        lostKey,
        kind.startsWith('rpc')
          ? []
          : capture(1_000)
              .slice(500)
              .map((claim) => claim[inputKey])
      );
    }
  );

  it('keeps total transport failure uncertain without any invented proof', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    expect(await (await load()).heartbeat(capture(1_008))).toEqual({
      status: 'uncertain',
      reason: 'rpc_error',
    });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('bounds concurrent requests and captures later claims before dispatch', async () => {
    const requests: Array<{
      claims: RpcClaim[];
      resolve: (value: ReturnType<typeof kept>) => void;
    }> = [];
    rpc.mockImplementation(
      (_name, args) => new Promise((resolve) => requests.push({ claims: args.p_claims, resolve }))
    );
    const { heartbeat, setNow } = await load();
    setNow(() => 500);
    const claims = capture(2_501);
    const pending = heartbeat(claims);
    expect(requests).toHaveLength(4);
    claims[2_000].leaseGeneration = successor;
    claims[2_000][inputKey] = id(9_999);
    requests[1].resolve(kept(requests[1].claims));
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    expect(requests[4].claims[0]).toEqual({ [rowKey]: id(2_000), lease_generation: generation });
    requests[4].resolve(kept(requests[4].claims));
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    for (const index of [0, 2, 3, 5]) requests[index].resolve(kept(requests[index].claims));
    const result = await pending;
    expect(result.status).toBe('answered');
    if (result.status !== 'answered') throw new Error('expected exact answers');
    expect(result.proofs).toHaveLength(2_501);
    expect(result.proofs[2_000]).toMatchObject({
      [inputKey]: id(2_000),
      leaseGeneration: generation,
    });
  });

  it('does not dispatch expired queued work or return proofs aged out behind a slow batch', async () => {
    let now = 500;
    const requests: Array<{
      claims: RpcClaim[];
      resolve: (value: ReturnType<typeof kept>) => void;
    }> = [];
    rpc.mockImplementation(
      (_name, args) => new Promise((resolve) => requests.push({ claims: args.p_claims, resolve }))
    );
    const { heartbeat, setNow } = await load();
    setNow(() => now);
    const pending = heartbeat(capture(3_001));
    expect(requests).toHaveLength(4);
    requests[0].resolve(kept(requests[0].claims));
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    now = 20_500;
    for (const request of requests.slice(1)) request.resolve(kept(request.claims));
    const result = await pending;
    expect(rpc).toHaveBeenCalledTimes(5);
    expect(result).toEqual({
      status: 'answered',
      proofs: [],
      [lostKey]: capture(3_001).map((claim) => claim[inputKey]),
    });
  });

  it('anchors all waves before the pass instead of granting queued work more time', async () => {
    let now = 500;
    rpc.mockImplementation(async (_name, args) => {
      now += 1_000;
      return kept(args.p_claims);
    });
    const { heartbeat, setNow } = await load();
    setNow(() => now);
    const result = await heartbeat(capture(2_501));
    expect(result.status).toBe('answered');
    if (result.status !== 'answered') throw new Error('expected exact answers');
    expect(result.proofs).toHaveLength(2_501);
    expect(new Set(result.proofs.map((proof) => proof.proofDeadlineMonotonicMs))).toEqual(
      new Set([20_500])
    );
  });
});
