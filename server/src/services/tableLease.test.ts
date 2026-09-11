/**
 * tableLease — the guard that stops two engine containers dealing one table.
 *
 * The behaviour these tests pin down is mostly about what must NOT happen: a
 * database problem must never be able to stop a table dealing. That inversion —
 * a fail-safe that becomes an outage — is the failure mode of every liveness
 * mechanism we shipped on 2026-08-15, none of which fired on 2026-08-16.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

/**
 * The historical environment switch is deliberately ignored. A fresh module
 * per case proves that even `off` cannot instantiate an unleased dealer.
 */
async function loadLease(enforce: boolean) {
  vi.resetModules();
  if (enforce) process.env.ENGINE_LEASE_ENFORCE = 'on';
  else process.env.ENGINE_LEASE_ENFORCE = 'off';
  return import('./tableLease.js');
}

const TABLE = '11111111-2222-4333-8444-555555555555';
const TABLE_2 = '11111111-2222-4333-8444-555555555556';
const TABLE_3 = '11111111-2222-4333-8444-555555555557';
const GENERATION = 'aaaaaaaa-0000-4000-8000-000000000001';
const GENERATION_2 = 'aaaaaaaa-0000-4000-8000-000000000002';

beforeEach(() => {
  rpc.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENGINE_LEASE_ENFORCE;
});

describe('INSTANCE_ID', () => {
  it('is unique per module load, so a restarted engine cannot inherit its own dead lease', async () => {
    const a = await loadLease(false);
    const b = await loadLease(false);
    expect(a.INSTANCE_ID).not.toBe(b.INSTANCE_ID);
    expect(a.INSTANCE_ID).toContain(String(process.pid));
  });
});

describe('claimTableLease', () => {
  it('has no generation-minting compatibility adapter or default argument', async () => {
    const lease = await loadLease(true);
    expect(lease.claimTableLease.length).toBe(2);
    expect('claimTable' in lease).toBe(false);
  });

  it('returns a verified classified grant when the database grants', async () => {
    const { claimTableLease } = await loadLease(true);
    rpc.mockImplementation((_fn, args: { p_requested_generation: string }) => {
      return {
        data: [
          {
            granted: true,
            holder: 'me',
            holder_age_seconds: 0,
            lease_generation: args.p_requested_generation,
            protocol_version: 2,
          },
        ],
        error: null,
      };
    });
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'granted',
      verified: true,
      leaseGeneration: GENERATION,
      proofDeadlineMonotonicMs: expect.any(Number),
    });
    expect(rpc).toHaveBeenCalledWith(
      'claim_table_lease_v2',
      expect.objectContaining({ p_requested_generation: GENERATION })
    );
  });

  it('refuses a grant that does not prove the exact requested protocol-2 generation', async () => {
    const { claimTableLease } = await loadLease(true);
    rpc.mockResolvedValue({
      data: [
        {
          granted: true,
          holder: 'me',
          holder_age_seconds: 0,
          lease_generation: GENERATION_2,
          protocol_version: 2,
        },
      ],
      error: null,
    });
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'malformed_response',
      requestedGeneration: GENERATION,
      mayHaveCommitted: true,
    });
  });

  it('keeps an exact caller generation stable across delayed same-process claim retries', async () => {
    const { claimTableLease } = await loadLease(true);
    rpc.mockImplementation((_fn, args: { p_requested_generation: string }) => ({
      data: [
        {
          granted: true,
          holder: 'me',
          holder_age_seconds: 0,
          lease_generation: args.p_requested_generation,
          protocol_version: 2,
        },
      ],
      error: null,
    }));

    await expect(claimTableLease(TABLE, GENERATION)).resolves.toMatchObject({
      status: 'granted',
      verified: true,
      leaseGeneration: GENERATION,
    });
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toMatchObject({
      status: 'granted',
      verified: true,
      leaseGeneration: GENERATION,
    });
    expect(rpc.mock.calls.map(([, args]) => args.p_requested_generation)).toEqual([
      GENERATION,
      GENERATION,
    ]);
  });

  it('rejects malformed caller generations locally instead of opening a different DB lease', async () => {
    const { claimTableLease } = await loadLease(true);
    await expect(claimTableLease(TABLE, 'not-a-uuid')).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'malformed_response',
      requestedGeneration: 'not-a-uuid',
      mayHaveCommitted: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('classifies a live foreign owner and refuses it when enforcement is on', async () => {
    const denied = {
      data: [{ granted: false, holder: 'other-1', holder_age_seconds: 2.5 }],
      error: null,
    };

    const enforced = await loadLease(true);
    rpc.mockResolvedValue(denied);
    await expect(enforced.claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'owned_elsewhere',
      conflict: expect.objectContaining({
        tableId: TABLE,
        holder: 'other-1',
        holderAgeSeconds: 2.5,
      }),
    });
  });

  it('ignores enforcement-off and refuses a live foreign owner', async () => {
    const denied = {
      data: [{ granted: false, holder: 'other-1', holder_age_seconds: 2.5 }],
      error: null,
    };
    const observing = await loadLease(false);
    rpc.mockResolvedValue(denied);
    await expect(observing.claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'owned_elsewhere',
      conflict: expect.objectContaining({
        tableId: TABLE,
        holder: 'other-1',
        holderAgeSeconds: 2.5,
      }),
    });
    expect(observing.leaseDiagnostics().enforced).toBe(true);
  });

  it('records the conflict for health even when the removed override is set', async () => {
    const { claimTableLease, recentLeaseConflicts, leaseDiagnostics } = await loadLease(false);
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-1', holder_age_seconds: 2.5 }],
      error: null,
    });
    await claimTableLease(TABLE, GENERATION);
    expect(recentLeaseConflicts()).toEqual([
      expect.objectContaining({ tableId: TABLE, holder: 'other-1', holderAgeSeconds: 2.5 }),
    ]);
    expect(leaseDiagnostics().enforced).toBe(true);
  });

  it('classifies an RPC error as retryable and fails closed while enforcement is on', async () => {
    const { claimTableLease, leaseDiagnostics } = await loadLease(true);
    rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_error',
      requestedGeneration: GENERATION,
      mayHaveCommitted: true,
    });
    expect(leaseDiagnostics().claimErrors).toBe(1);
  });

  it('classifies a thrown transport failure as retryable and fails closed when enforced', async () => {
    const { claimTableLease } = await loadLease(true);
    rpc.mockRejectedValue(new Error('ECONNRESET'));
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_threw',
      requestedGeneration: GENERATION,
      mayHaveCommitted: true,
    });
  });

  it.each([
    ['empty result', []],
    ['multiple rows', [{ granted: true }, { granted: false }]],
    ['missing discriminator', [{ holder: 'me' }]],
    ['non-boolean discriminator', [{ granted: 'true' }]],
  ])(
    'classifies a malformed %s as retryable rather than guessing ownership',
    async (_name, data) => {
      const { claimTableLease } = await loadLease(true);
      rpc.mockResolvedValue({ data, error: null });
      await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
        status: 'retryable_failure',
        reason: 'malformed_response',
        requestedGeneration: GENERATION,
        mayHaveCommitted: true,
      });
    }
  );

  it('ignores enforcement-off for transport and malformed responses', async () => {
    const { claimTableLease } = await loadLease(false);

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_error',
      requestedGeneration: GENERATION,
      mayHaveCommitted: true,
    });

    rpc.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_threw',
      requestedGeneration: GENERATION,
      mayHaveCommitted: true,
    });

    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'malformed_response',
      requestedGeneration: GENERATION,
      mayHaveCommitted: true,
    });
  });

  it('refuses a verified response that arrives after its conservative proof window', async () => {
    const lease = await loadLease(true);
    let now = 0;
    lease._setTableLeaseMonotonicNowForTests(() => now);
    rpc.mockImplementation(async () => {
      now = lease.TABLE_LEASE_PROOF_WINDOW_MS;
      return {
        data: [
          {
            granted: true,
            holder: 'me',
            holder_age_seconds: 0,
            lease_generation: GENERATION,
            protocol_version: 2,
          },
        ],
        error: null,
      };
    });
    await expect(lease.claimTableLease(TABLE, GENERATION)).resolves.toEqual({
      status: 'acquired_but_proof_expired',
      leaseGeneration: GENERATION,
    });
  });
});

describe('heartbeatTables', () => {
  it('proves only kept rows and reports every non-kept row as locally lost', async () => {
    const lease = await loadLease(true);
    let now = 1_000;
    lease._setTableLeaseMonotonicNowForTests(() => now);
    rpc.mockResolvedValue({
      data: [
        { table_id: TABLE, state: 'kept', lease_generation: GENERATION },
        { table_id: TABLE_2, state: 'taken', lease_generation: GENERATION_2 },
        { table_id: TABLE_3, state: 'missing', lease_generation: null },
      ],
      error: null,
    });
    await expect(
      lease.heartbeatTables([
        { tableId: TABLE, leaseGeneration: GENERATION },
        { tableId: TABLE_2, leaseGeneration: GENERATION },
        { tableId: TABLE_3, leaseGeneration: GENERATION_2 },
      ])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [
        {
          tableId: TABLE,
          leaseGeneration: GENERATION,
          proofDeadlineMonotonicMs: 1_000 + lease.TABLE_LEASE_PROOF_WINDOW_MS,
        },
      ],
      lostTableIds: [TABLE_2, TABLE_3],
    });
    expect(lease.recentLeaseConflicts().map((c) => c.tableId)).toEqual([TABLE_2]);
    expect(lease.reclaimableLeaseCount()).toBe(1);
    expect(rpc).toHaveBeenCalledWith('heartbeat_table_leases_v4', {
      p_instance_id: lease.INSTANCE_ID,
      p_claims: [
        { table_id: TABLE, lease_generation: GENERATION },
        { table_id: TABLE_2, lease_generation: GENERATION },
        { table_id: TABLE_3, lease_generation: GENERATION_2 },
      ],
      p_stale_seconds: lease.LEASE_STALE_SECONDS,
    });
  });

  it('fails closed on a successful incomplete or duplicate response', async () => {
    const { heartbeatTables } = await loadLease(true);
    rpc.mockResolvedValue({
      data: [{ table_id: TABLE, state: 'kept', lease_generation: GENERATION }],
      error: null,
    });
    await expect(
      heartbeatTables([
        { tableId: TABLE, leaseGeneration: GENERATION },
        { tableId: TABLE_2, leaseGeneration: GENERATION_2 },
      ])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTableIds: [TABLE, TABLE_2],
    });

    rpc.mockResolvedValue({
      data: [
        { table_id: TABLE, state: 'kept', lease_generation: GENERATION },
        { table_id: TABLE, state: 'kept', lease_generation: GENERATION },
      ],
      error: null,
    });
    await expect(
      heartbeatTables([
        { tableId: TABLE, leaseGeneration: GENERATION },
        { tableId: TABLE_2, leaseGeneration: GENERATION_2 },
      ])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTableIds: [TABLE, TABLE_2],
    });
  });

  it('fails closed before the RPC for duplicate or malformed exact claims', async () => {
    const { heartbeatTables } = await loadLease(true);
    await expect(
      heartbeatTables([
        { tableId: TABLE, leaseGeneration: GENERATION },
        { tableId: TABLE, leaseGeneration: GENERATION_2 },
      ])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTableIds: [TABLE, TABLE],
    });
    await expect(
      heartbeatTables([{ tableId: TABLE, leaseGeneration: 'not-a-uuid' }])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTableIds: [TABLE],
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('types repeated transport failures as uncertain and never invents a new deadline', async () => {
    const { heartbeatTables } = await loadLease(true);
    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const claims = [
      { tableId: TABLE, leaseGeneration: GENERATION },
      { tableId: TABLE_2, leaseGeneration: GENERATION_2 },
    ];
    await expect(heartbeatTables(claims)).resolves.toEqual({
      status: 'uncertain',
      reason: 'rpc_error',
    });
    await expect(heartbeatTables(claims)).resolves.toEqual({
      status: 'uncertain',
      reason: 'rpc_error',
    });

    rpc.mockRejectedValue(new Error('socket hang up'));
    await expect(heartbeatTables(claims)).resolves.toEqual({
      status: 'uncertain',
      reason: 'rpc_threw',
    });
  });

  it('does not extend authority when event-loop delay consumes the proof window', async () => {
    const lease = await loadLease(true);
    let now = 0;
    lease._setTableLeaseMonotonicNowForTests(() => now);
    rpc.mockImplementation(async () => {
      now = lease.TABLE_LEASE_PROOF_WINDOW_MS;
      return {
        data: [{ table_id: TABLE, state: 'kept', lease_generation: GENERATION }],
        error: null,
      };
    });
    await expect(
      lease.heartbeatTables([{ tableId: TABLE, leaseGeneration: GENERATION }])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTableIds: [],
      obsoleteProofs: [
        { tableId: TABLE, leaseGeneration: GENERATION, proofDeadlineMonotonicMs: 20_000 },
      ],
    });
  });

  it('does not call the database at all with no tables', async () => {
    const { heartbeatTables } = await loadLease(true);
    await expect(heartbeatTables([])).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTableIds: [],
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('releaseTables', () => {
  it('releases only exact table generations', async () => {
    const { releaseTables, INSTANCE_ID } = await loadLease(true);
    rpc.mockResolvedValue({ data: 1, error: null });
    await expect(releaseTables([{ tableId: TABLE, leaseGeneration: GENERATION }])).resolves.toEqual(
      { status: 'confirmed', releasedCount: 1, attempts: 1 }
    );
    expect(rpc).toHaveBeenCalledWith('release_table_leases_v2', {
      p_instance_id: INSTANCE_ID,
      p_claims: [{ table_id: TABLE, lease_generation: GENERATION }],
    });
  });

  it('does not call the database without a valid exact claim batch', async () => {
    const { releaseTables } = await loadLease(true);
    await expect(releaseTables()).resolves.toEqual({
      status: 'confirmed',
      releasedCount: 0,
      attempts: 0,
    });
    await expect(
      releaseTables([{ tableId: TABLE, leaseGeneration: 'not-a-uuid' }])
    ).resolves.toMatchObject({ status: 'uncertain', reason: 'invalid_claims', attempts: 0 });
    await expect(
      releaseTables([
        { tableId: TABLE, leaseGeneration: GENERATION },
        { tableId: TABLE, leaseGeneration: GENERATION_2 },
      ])
    ).resolves.toMatchObject({ status: 'uncertain', reason: 'invalid_claims', attempts: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('retries an uncertain PostgREST answer immediately with the identical exact claim', async () => {
    const { releaseTables } = await loadLease(true);
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'schema reload' } })
      .mockResolvedValueOnce({ data: 0, error: null });
    await expect(releaseTables([{ tableId: TABLE, leaseGeneration: GENERATION }])).resolves.toEqual(
      { status: 'confirmed', releasedCount: 0, attempts: 2 }
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });

  it('returns a typed failure after bounded thrown transport failures', async () => {
    const { releaseTables } = await loadLease(true);
    rpc.mockRejectedValue(new Error('gone'));
    await expect(releaseTables([{ tableId: TABLE, leaseGeneration: GENERATION }])).resolves.toEqual(
      {
        status: 'uncertain',
        reason: 'rpc_threw',
        detail: 'gone',
        attempts: 2,
      }
    );
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not accept a malformed deletion count as release proof', async () => {
    const { releaseTables } = await loadLease(true);
    rpc.mockResolvedValue({ data: 2, error: null });
    await expect(
      releaseTables([{ tableId: TABLE, leaseGeneration: GENERATION }])
    ).resolves.toMatchObject({
      status: 'uncertain',
      reason: 'malformed_response',
      attempts: 2,
    });
  });
});

describe('table heartbeat lock isolation', () => {
  it('renews an available generation while a busy one receives no proof', async () => {
    const lease = await loadLease(true);
    lease._setTableLeaseMonotonicNowForTests(() => 1000);
    rpc.mockResolvedValue({
      data: [
        { table_id: TABLE, state: 'busy', lease_generation: GENERATION },
        { table_id: TABLE_2, state: 'kept', lease_generation: GENERATION_2 },
      ],
      error: null,
    });
    const outcome = await lease.heartbeatTables([
      { tableId: TABLE, leaseGeneration: GENERATION },
      { tableId: TABLE_2, leaseGeneration: GENERATION_2 },
    ]);
    expect(outcome).toEqual({
      status: 'answered',
      proofs: [
        { tableId: TABLE_2, leaseGeneration: GENERATION_2, proofDeadlineMonotonicMs: 21000 },
      ],
      lostTableIds: [],
    });
    expect(rpc.mock.calls[0][0]).toBe('heartbeat_table_leases_v4');
  });

  it('never renews from repeated busy replies, including after the prior deadline', async () => {
    const lease = await loadLease(true);
    let now = 0;
    lease._setTableLeaseMonotonicNowForTests(() => now);
    rpc.mockResolvedValue({
      data: [{ table_id: TABLE, state: 'busy', lease_generation: GENERATION }],
      error: null,
    });
    for (now of [0, 10000, 20000, 30000, 60000]) {
      await expect(
        lease.heartbeatTables([{ tableId: TABLE, leaseGeneration: GENERATION }])
      ).resolves.toEqual({
        status: 'answered',
        proofs: [],
        lostTableIds: [],
      });
    }
  });

  it.each([null, GENERATION_2, 'invalid-generation'])(
    'fails closed on a busy reply with invalid authority %s',
    async (returned) => {
      const lease = await loadLease(true);
      rpc.mockResolvedValue({
        data: [{ table_id: TABLE, state: 'busy', lease_generation: returned }],
        error: null,
      });
      await expect(
        lease.heartbeatTables([{ tableId: TABLE, leaseGeneration: GENERATION }])
      ).resolves.toEqual({
        status: 'answered',
        proofs: [],
        lostTableIds: [TABLE],
      });
    }
  );
});
