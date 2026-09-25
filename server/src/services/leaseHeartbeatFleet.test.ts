import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetainedLeaseHeartbeatBatches } from './leaseHeartbeatBatches.js';

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

it.each(['deadline', 'replacement'] as const)(
  'bounds retained queued identities under four never-settling transports and %s',
  async (expiry) => {
    const batches = new RetainedLeaseHeartbeatBatches<string, string>();
    let now = 0;
    let owner = 0;
    const held: Array<{ key: string; resolve: (value: string) => void }> = [];
    const deliver = vi.fn();
    for (let pass = 0; pass < 100; pass++) {
      now = pass * 5000;
      owner = pass;
      const deadline = now + 20000;
      const captured = owner;
      batches.dispatch(
        [String(pass)],
        (key) => key,
        () => now < deadline && (expiry === 'deadline' || owner === captured),
        ([key]) => new Promise((resolve) => held.push({ key, resolve })),
        deliver,
        () => {
          throw new Error('unexpected delivery error');
        }
      );
      expect(held.length).toBeLessThanOrEqual(4);
      // Four actual transports plus at most one 20s window of 5s dispatches.
      expect((batches as any).retained.size).toBeLessThanOrEqual(8);
      expect((batches as any).queued.length).toBeLessThanOrEqual(4);
    }
    for (const request of held.slice()) request.resolve(request.key);
    await new Promise((resolve) => setImmediate(resolve));
    expect(deliver).not.toHaveBeenCalled();
    const current = held.slice(4);
    expect(current.map(({ key }) => Number(key))).toEqual(
      expiry === 'deadline' ? [96, 97, 98, 99] : [99]
    );
    for (const request of current) request.resolve(request.key);
    await new Promise((resolve) => setImmediate(resolve));
    expect((batches as any).retained.size).toBe(0);
  }
);

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
    /* A PASS THAT RAN OUT OF TIME RENEWS NOTHING AND ACCUSES NOBODY.
       Every answer here said `kept`; they simply arrived after their own
       window, and the batches never sent were never asked about. Naming all
       3,001 as lost is what fenced live managers and discarded the hand each
       of their tables was committing - 403 tournament hands, 2026-09-08..18.
       Withholding the proofs is the real requirement, and it still holds. */
    expect(result).toEqual({
      status: 'answered',
      proofs: [],
      [lostKey]: [],
    });
  });

  /* ANCHORING EVERY WAVE TO THE PASS IS WHAT LOST THE LEASES (2026-09-21).
     One window was opened before the first request and shared by all six
     waves, so a wave that queued behind three others spent it waiting and its
     `kept` answer was discarded - and then named as a loss. The window belongs
     to the request that earned it: `heartbeat_at` is set by that statement, so
     a reading taken immediately before it is a conservative floor for it, and
     `+ WINDOW` stays inside the audited 30s takeover boundary for every wave
     exactly as it did for the first. */
  it('anchors each wave to its own request, never beyond the takeover boundary', async () => {
    let now = 500;
    const issuedAt: number[] = [];
    rpc.mockImplementation(async (_name, args) => {
      issuedAt.push(now);
      now += 1_000;
      return kept(args.p_claims);
    });
    const { heartbeat, setNow } = await load();
    setNow(() => now);
    const result = await heartbeat(capture(2_501));
    expect(result.status).toBe('answered');
    if (result.status !== 'answered') throw new Error('expected exact answers');
    // Every wave is renewed. Under the pass-wide anchor the later waves were
    // dropped for lateness and reported lost instead.
    expect(result.proofs).toHaveLength(2_501);
    expect(result).toHaveProperty(lostKey, []);
    const deadlines = new Set(result.proofs.map((proof) => proof.proofDeadlineMonotonicMs));
    // Six waves, six request times, six windows - not one shared window.
    expect(issuedAt).toHaveLength(6);
    expect(deadlines.size).toBe(6);
    // Each window opens at its own request and never outlives the 30s boundary
    // the database would let another instance take this lease at.
    const window = Math.min(...deadlines) - issuedAt[0];
    for (const deadline of deadlines) {
      const issued = deadline - window;
      expect(issuedAt).toContain(issued);
      expect(deadline - issued).toBeLessThan(30_000);
    }
  });

  it('keeps four transports across passes, releases completed claims, and expires queued generations', async () => {
    let now = 0;
    const requests: Array<{
      claims: RpcClaim[];
      resolve: (value: ReturnType<typeof kept>) => void;
    }> = [];
    rpc.mockImplementation(
      (_name, args) => new Promise((resolve) => requests.push({ claims: args.p_claims, resolve }))
    );
    const { heartbeat, setNow } = await load();
    setNow(() => now);
    const delivered = vi.fn();
    expect(await heartbeat(capture(2501), delivered)).toEqual({
      status: 'uncertain',
      reason: 'pending',
    });
    expect(requests).toHaveLength(4);
    for (let pass = 0; pass < 8; pass++) {
      now += 5000;
      await heartbeat(capture(2501), delivered);
      expect(requests).toHaveLength(4);
    }
    // Complete one old transport: its callback has expired. The queue now
    // contains the latest captured pass, not eight duplicate sets of claims.
    requests[0].resolve(kept(requests[0].claims));
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    expect(delivered).not.toHaveBeenCalled();
    expect(requests[4].claims[0][rowKey]).toBe(id(2000));
    requests[4].resolve(kept(requests[4].claims));
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    requests[5].resolve(kept(requests[5].claims));
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(2));
    expect(delivered.mock.calls.flatMap(([outcome]) => outcome.proofs)).toHaveLength(501);
    for (const request of requests.slice(1, 4)) request.resolve(kept(request.claims));
    await Promise.resolve();
  });

  it('does not dispatch queued claims whose owner was replaced or deliver after shutdown', async () => {
    const requests: Array<{
      claims: RpcClaim[];
      resolve: (value: ReturnType<typeof kept>) => void;
    }> = [];
    rpc.mockImplementation(
      (_name, args) => new Promise((resolve) => requests.push({ claims: args.p_claims, resolve }))
    );
    const { heartbeat, setNow } = await load();
    setNow(() => 1000);
    let ownerCurrent = true;
    let replaced = false;
    const delivered = vi.fn();
    await heartbeat(
      capture(2501),
      delivered,
      () => ownerCurrent,
      (claim) =>
        !replaced || (claim as { tableId?: string; tournamentId?: string })[inputKey] !== id(2000)
    );
    replaced = true;
    requests[0].resolve(kept(requests[0].claims));
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    expect(requests[4].claims).toHaveLength(499);
    expect(requests[4].claims.some((claim) => claim[rowKey] === id(2000))).toBe(false);
    expect(delivered).toHaveBeenCalledOnce();
    ownerCurrent = false;
    for (const request of requests.slice(1)) request.resolve(kept(request.claims));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(5);
    expect(delivered).toHaveBeenCalledOnce();
  });

  it('preserves busy, missing and malformed refusal semantics in immediate batch delivery', async () => {
    const { heartbeat, setNow } = await load();
    setNow(() => 1000);
    const delivered = vi.fn();
    rpc.mockResolvedValue({
      data: [
        { [rowKey]: id(0), lease_generation: generation, state: 'busy' },
        { [rowKey]: id(1), lease_generation: null, state: 'missing' },
        { [rowKey]: id(2), lease_generation: generation, state: 'kept' },
      ],
      error: null,
    });
    await heartbeat(capture(3), delivered);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    expect(delivered.mock.calls[0][0]).toEqual({
      status: 'answered',
      proofs: [{ ...capture(3)[2], proofDeadlineMonotonicMs: 21000 }],
      [lostKey]: [id(1)],
    });
    rpc.mockResolvedValue({ data: [], error: null });
    await heartbeat(capture(3), delivered);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(2));
    expect(delivered.mock.calls[1][0]).toEqual({
      status: 'answered',
      proofs: [],
      [lostKey]: [id(0), id(1), id(2)],
    });
  });

  it('releases a delivered transport once if its synchronous consumer throws', async () => {
    const { heartbeat, setNow } = await load();
    setNow(() => 1000);
    rpc.mockImplementation(async (_name, args) => kept(args.p_claims));
    const failedConsumer = vi.fn(() => {
      throw new Error('consumer failure');
    });
    await heartbeat(capture(1), failedConsumer);
    await vi.waitFor(() => expect(failedConsumer).toHaveBeenCalledOnce());
    const delivered = vi.fn();
    await heartbeat(capture(1), delivered);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(failedConsumer).toHaveBeenCalledOnce();
    expect(delivered.mock.calls[0][0].proofs).toHaveLength(1);
  });
});
