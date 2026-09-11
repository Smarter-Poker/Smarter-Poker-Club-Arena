/**
 * ONE TOURNAMENT, ONE MANAGER.
 *
 * Without this lease, a second engine instance resumes tournaments the first
 * one is already running: two managers advancing blind levels, two calling
 * synchronized breaks, two running hand-for-hand, two processing eliminations
 * and payouts for one prize pool. Cash tables were leased for exactly this
 * reason -- "two decks, two dealers and two settlements against the same
 * seats" -- and tournaments were the gap that kept the engine a single point of
 * failure.
 *
 * A lease check sits in front of "may I run this tournament". Under enforcement
 * only a verified grant may start a manager: an unreadable answer is retryable,
 * because guessing "yes" can create two managers and corrupt one prize pool.
 * The former environment escape hatch is ignored: production cannot create a
 * generation-less manager from an unreadable or denied ownership answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('./tableLease.js', () => ({ INSTANCE_ID: 'me', INSTANCE_VERSION: 'v1' }));

const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const T3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const G = 'bbbbbbbb-0000-4000-8000-000000000001';
const G2 = 'bbbbbbbb-0000-4000-8000-000000000002';

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  delete process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE;
});

const load = async () => await import('./tournamentLease.js');

describe('enforcement activation contract', () => {
  it('cannot be disabled by the historical environment value', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    const disabledModule = await load();
    expect(disabledModule.TOURNAMENT_LEASE_ENFORCED).toBe(true);
    expect(disabledModule.tournamentLeaseDiagnostics().enforced).toBe(true);

    delete process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE;
    vi.resetModules();
    const defaultModule = await load();
    expect(defaultModule.TOURNAMENT_LEASE_ENFORCED).toBe(true);
  });

  it('stays enforced for every other environment value', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'OFF';
    const { TOURNAMENT_LEASE_ENFORCED } = await load();
    expect(TOURNAMENT_LEASE_ENFORCED).toBe(true);
  });
});

describe('claimTournamentLease', () => {
  it('has no generation-minting compatibility adapter or default argument', async () => {
    const lease = await load();
    expect(lease.claimTournamentLease.length).toBe(2);
    expect('claimTournament' in lease).toBe(false);
  });

  it('returns a verified classified grant when the database grants', async () => {
    rpc.mockImplementation((_name, args: { p_requested_generation: string }) => {
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
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T, G)).resolves.toEqual({
      status: 'granted',
      verified: true,
      leaseGeneration: G,
      proofDeadlineMonotonicMs: expect.any(Number),
    });
    expect(rpc).toHaveBeenCalledWith(
      'claim_tournament_lease_v2',
      expect.objectContaining({ p_requested_generation: G })
    );
  });

  it('classifies a live foreign owner and refuses it when enforcement is on', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-instance', holder_age_seconds: 4 }],
      error: null,
    });
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T, G)).resolves.toMatchObject({
      status: 'owned_elsewhere',
      conflict: { tournamentId: T, holder: 'other-instance', holderAgeSeconds: 4 },
    });
  });

  it('ignores enforcement-off and refuses a live foreign owner', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-instance', holder_age_seconds: 4 }],
      error: null,
    });
    const { claimTournamentLease, tournamentLeaseDiagnostics } = await load();
    await expect(claimTournamentLease(T, G)).resolves.toEqual({
      status: 'owned_elsewhere',
      conflict: {
        tournamentId: T,
        holder: 'other-instance',
        holderAgeSeconds: 4,
        at: expect.any(Number),
      },
    });
    expect(tournamentLeaseDiagnostics()).toMatchObject({
      enforced: true,
      conflictCount: 1,
      conflicts: [{ tournamentId: T, holder: 'other-instance', holderAgeSeconds: 4 }],
    });
  });

  it('classifies an RPC error as retryable and fails closed while enforced', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T, G)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_error',
      requestedGeneration: G,
      mayHaveCommitted: true,
    });
  });

  it('classifies a thrown transport failure as retryable and fails closed while enforced', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockRejectedValue(new Error('ETIMEDOUT'));
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T, G)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_threw',
      requestedGeneration: G,
      mayHaveCommitted: true,
    });
  });

  it.each([
    ['empty result', null],
    [
      'multiple rows',
      [
        { granted: true, holder: 'me', holder_age_seconds: 0 },
        { granted: false, holder: 'other', holder_age_seconds: 1 },
      ],
    ],
    ['missing discriminator', [{ holder: 'me', holder_age_seconds: 0 }]],
    ['non-boolean discriminator', [{ granted: 'yes', holder: 'me', holder_age_seconds: 0 }]],
    ['grant without a generation', [{ granted: true, holder: 'me', holder_age_seconds: 0 }]],
  ])('classifies a malformed %s as retryable', async (_label, data) => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({ data, error: null });
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T, G)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'malformed_response',
      requestedGeneration: G,
      mayHaveCommitted: true,
    });
  });

  it.each([
    ['RPC error', { data: null, error: { message: 'offline' } }],
    ['malformed response', { data: [], error: null }],
  ])('ignores enforcement-off and fails closed for %s', async (_label, response) => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    rpc.mockResolvedValue(response);
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T, G)).resolves.toMatchObject({
      status: 'retryable_failure',
      requestedGeneration: G,
      mayHaveCommitted: true,
    });
  });

  it('refuses a grant whose response arrives after its conservative proof window', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    let now = 100;
    rpc.mockImplementation(async () => {
      now = 20_100;
      return {
        data: [
          {
            granted: true,
            holder: 'me',
            holder_age_seconds: 0,
            lease_generation: G,
            protocol_version: 2,
          },
        ],
        error: null,
      };
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => now);
    await expect(lease.claimTournamentLease(T, G)).resolves.toEqual({
      status: 'acquired_but_proof_expired',
      leaseGeneration: G,
    });
  });

  it('rejects malformed caller generations locally instead of minting authority', async () => {
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T, 'not-a-uuid')).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'malformed_response',
      requestedGeneration: 'not-a-uuid',
      mayHaveCommitted: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('heartbeatTournaments - "could not ask" is not "lost everything"', () => {
  it('reports nothing lost when the RPC errors', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { heartbeatTournaments } = await load();
    // The inversion that turns a fail-safe into an outage.
    await expect(
      heartbeatTournaments([
        { tournamentId: T, leaseGeneration: G },
        { tournamentId: T2, leaseGeneration: G2 },
      ])
    ).resolves.toEqual({ status: 'uncertain', reason: 'rpc_error' });
  });

  it('reports nothing lost when the RPC throws', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockRejectedValue(new Error('boom'));
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments([{ tournamentId: T, leaseGeneration: G }])).resolves.toEqual({
      status: 'uncertain',
      reason: 'rpc_threw',
    });
  });

  it('reports the ones another LIVE instance took, when enforcing', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [
        { tournament_id: T, state: 'kept', lease_generation: G },
        { tournament_id: T2, state: 'taken', lease_generation: G2 },
      ],
      error: null,
    });
    const { heartbeatTournaments } = await load();
    await expect(
      heartbeatTournaments([
        { tournamentId: T, leaseGeneration: G },
        { tournamentId: T2, leaseGeneration: G },
      ])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [
        {
          tournamentId: T,
          leaseGeneration: G,
          proofDeadlineMonotonicMs: expect.any(Number),
        },
      ],
      lostTournamentIds: [T2],
    });
  });

  it('anchors a renewed deadline before the RPC instead of after a slow response', async () => {
    let now = 500;
    rpc.mockImplementation(async () => {
      now = 5_500;
      return {
        data: [{ tournament_id: T, state: 'kept', lease_generation: G }],
        error: null,
      };
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => now);
    await expect(
      lease.heartbeatTournaments([{ tournamentId: T, leaseGeneration: G }])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [
        {
          tournamentId: T,
          leaseGeneration: G,
          proofDeadlineMonotonicMs: 20_500,
        },
      ],
      lostTournamentIds: [],
    });
  });

  it('does not extend authority when event-loop delay consumes the proof window', async () => {
    let now = 500;
    rpc.mockImplementation(async () => {
      now = 20_500;
      return {
        data: [{ tournament_id: T, state: 'kept', lease_generation: G }],
        error: null,
      };
    });
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => now);
    await expect(
      lease.heartbeatTournaments([{ tournamentId: T, leaseGeneration: G }])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTournamentIds: [],
      obsoleteProofs: [{ tournamentId: T, leaseGeneration: G, proofDeadlineMonotonicMs: 20_500 }],
    });
  });

  /**
   * This side is the one that was actually hurting players.
   * ENGINE_TOURNAMENT_LEASE_ENFORCE is ON in production, so every false
   * "taken" STOPPED A RUNNING TOURNAMENT MANAGER. On 2026-08-29 that path
   * fired 101 times in an hour against 19 running tournaments.
   */
  it('stops every manager whose exact generation a successful response cannot prove', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [
        { tournament_id: T, state: 'missing', lease_generation: null },
        { tournament_id: T2, state: 'kept', lease_generation: G2 },
        { tournament_id: T3, state: 'taken', lease_generation: G2 },
      ],
      error: null,
    });
    const { heartbeatTournaments } = await load();
    await expect(
      heartbeatTournaments([
        { tournamentId: T, leaseGeneration: G },
        { tournamentId: T2, leaseGeneration: G },
        { tournamentId: T3, leaseGeneration: G },
      ])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTournamentIds: [T, T2, T3],
    });
  });

  it('fails closed on a successful but incomplete generation response', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [{ tournament_id: T, state: 'kept', lease_generation: G }],
      error: null,
    });
    const { heartbeatTournaments } = await load();
    await expect(
      heartbeatTournaments([
        { tournamentId: T, leaseGeneration: G },
        { tournamentId: T2, leaseGeneration: G2 },
      ])
    ).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTournamentIds: [T, T2],
    });
  });

  it('does not hide a proven generation loss when the removed override is set', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    rpc.mockResolvedValue({ data: [], error: null });
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments([{ tournamentId: T, leaseGeneration: G }])).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTournamentIds: [T],
    });
  });

  it('does not call the database for an empty list', async () => {
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments([])).resolves.toEqual({
      status: 'answered',
      proofs: [],
      lostTournamentIds: [],
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('releaseTournaments', () => {
  it('releases only one exact tournament generation', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    const { releaseTournaments } = await load();
    await expect(releaseTournaments([{ tournamentId: T, leaseGeneration: G }])).resolves.toEqual({
      status: 'confirmed',
      releasedCount: 1,
      attempts: 1,
    });
    expect(rpc).toHaveBeenCalledWith('release_tournament_leases_v2', {
      p_instance_id: 'me',
      p_claims: [{ tournament_id: T, lease_generation: G }],
    });
  });

  it('does not call the database without an exact generation', async () => {
    const { releaseTournaments } = await load();
    await expect(releaseTournaments()).resolves.toEqual({
      status: 'confirmed',
      releasedCount: 0,
      attempts: 0,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('retries the identical exact release and accepts an idempotent zero count', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'schema reload' } })
      .mockResolvedValueOnce({ data: 0, error: null });
    const { releaseTournaments } = await load();
    await expect(releaseTournaments([{ tournamentId: T, leaseGeneration: G }])).resolves.toEqual({
      status: 'confirmed',
      releasedCount: 0,
      attempts: 2,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });

  it('returns a typed failure after two unconfirmed answers', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
    const { releaseTournaments } = await load();
    await expect(releaseTournaments([{ tournamentId: T, leaseGeneration: G }])).resolves.toEqual({
      status: 'uncertain',
      reason: 'rpc_error',
      detail: 'offline',
      attempts: 2,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('fails locally on duplicate or malformed exact claims', async () => {
    const { releaseTournaments } = await load();
    await expect(
      releaseTournaments([
        { tournamentId: T, leaseGeneration: G },
        { tournamentId: T, leaseGeneration: G2 },
      ])
    ).resolves.toMatchObject({ status: 'uncertain', reason: 'invalid_claims', attempts: 0 });
    await expect(
      releaseTournaments([{ tournamentId: T, leaseGeneration: 'bad' }])
    ).resolves.toMatchObject({ status: 'uncertain', reason: 'invalid_claims', attempts: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('tournament heartbeat lock isolation', () => {
  it('renews an available generation while a busy one receives no proof', async () => {
    const lease = await load();
    lease._setTournamentLeaseMonotonicNowForTests(() => 1000);
    rpc.mockResolvedValue({
      data: [
        { tournament_id: T, state: 'busy', lease_generation: G },
        { tournament_id: T2, state: 'kept', lease_generation: G2 },
      ],
      error: null,
    });
    const outcome = await lease.heartbeatTournaments([
      { tournamentId: T, leaseGeneration: G },
      { tournamentId: T2, leaseGeneration: G2 },
    ]);
    expect(outcome).toEqual({
      status: 'answered',
      proofs: [{ tournamentId: T2, leaseGeneration: G2, proofDeadlineMonotonicMs: 21000 }],
      lostTournamentIds: [],
    });
    expect(rpc.mock.calls[0][0]).toBe('heartbeat_tournament_leases_v4');
  });

  it('never renews from repeated busy replies, including after the prior deadline', async () => {
    const lease = await load();
    let now = 0;
    lease._setTournamentLeaseMonotonicNowForTests(() => now);
    rpc.mockResolvedValue({
      data: [{ tournament_id: T, state: 'busy', lease_generation: G }],
      error: null,
    });
    for (now of [0, 10000, 20000, 30000, 60000]) {
      await expect(
        lease.heartbeatTournaments([{ tournamentId: T, leaseGeneration: G }])
      ).resolves.toEqual({
        status: 'answered',
        proofs: [],
        lostTournamentIds: [],
      });
    }
  });

  it.each([null, G2, 'invalid-generation'])(
    'fails closed on a busy reply with invalid authority %s',
    async (returned) => {
      const lease = await load();
      rpc.mockResolvedValue({
        data: [{ tournament_id: T, state: 'busy', lease_generation: returned }],
        error: null,
      });
      await expect(
        lease.heartbeatTournaments([{ tournamentId: T, leaseGeneration: G }])
      ).resolves.toEqual({
        status: 'answered',
        proofs: [],
        lostTournamentIds: [T],
      });
    }
  );
});
