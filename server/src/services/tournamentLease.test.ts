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
 * The explicit enforcement-off escape hatch keeps its historical behaviour but
 * is visibly unverified.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('./tableLease.js', () => ({ INSTANCE_ID: 'me', INSTANCE_VERSION: 'v1' }));

const T = 'aaaaaaaa-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  delete process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE;
});

const load = async () => await import('./tournamentLease.js');

describe('enforcement activation contract', () => {
  it('defaults to enforced in a fresh module when the environment variable is unset', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    const disabledModule = await load();
    expect(disabledModule.TOURNAMENT_LEASE_ENFORCED).toBe(false);

    delete process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE;
    vi.resetModules();
    const defaultModule = await load();
    expect(defaultModule.TOURNAMENT_LEASE_ENFORCED).toBe(true);
  });

  it('requires the exact value off to disable enforcement', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'OFF';
    const { TOURNAMENT_LEASE_ENFORCED } = await load();
    expect(TOURNAMENT_LEASE_ENFORCED).toBe(true);
  });
});

describe('claimTournamentLease', () => {
  it('returns a verified classified grant when the database grants', async () => {
    rpc.mockResolvedValue({
      data: [{ granted: true, holder: 'me', holder_age_seconds: 0 }],
      error: null,
    });
    const { claimTournament, claimTournamentLease } = await load();
    await expect(claimTournamentLease(T)).resolves.toEqual({
      status: 'granted',
      verified: true,
    });
    await expect(claimTournament(T)).resolves.toBe(true);
  });

  it('classifies a live foreign owner and refuses it when enforcement is on', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-instance', holder_age_seconds: 4 }],
      error: null,
    });
    const { claimTournament, claimTournamentLease } = await load();
    await expect(claimTournamentLease(T)).resolves.toMatchObject({
      status: 'owned_elsewhere',
      conflict: { tournamentId: T, holder: 'other-instance', holderAgeSeconds: 4 },
    });
    await expect(claimTournament(T)).resolves.toBe(false);
  });

  it('preserves enforcement-off conflict admission but marks it unverified', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-instance', holder_age_seconds: 4 }],
      error: null,
    });
    const { claimTournament, claimTournamentLease, tournamentLeaseDiagnostics } = await load();
    await expect(claimTournamentLease(T)).resolves.toEqual({
      status: 'granted',
      verified: false,
    });
    await expect(claimTournament(T)).resolves.toBe(true);
    expect(tournamentLeaseDiagnostics()).toMatchObject({
      enforced: false,
      conflictCount: 1,
      conflicts: [{ tournamentId: T, holder: 'other-instance', holderAgeSeconds: 4 }],
    });
  });

  it('classifies an RPC error as retryable and fails closed while enforced', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { claimTournament, claimTournamentLease } = await load();
    await expect(claimTournamentLease(T)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_error',
    });
    await expect(claimTournament(T)).resolves.toBe(false);
  });

  it('classifies a thrown transport failure as retryable and fails closed while enforced', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockRejectedValue(new Error('ETIMEDOUT'));
    const { claimTournament, claimTournamentLease } = await load();
    await expect(claimTournamentLease(T)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'rpc_threw',
    });
    await expect(claimTournament(T)).resolves.toBe(false);
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
  ])('classifies a malformed %s as retryable', async (_label, data) => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({ data, error: null });
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T)).resolves.toEqual({
      status: 'retryable_failure',
      reason: 'malformed_response',
    });
  });

  it.each([
    ['RPC error', { data: null, error: { message: 'offline' } }],
    ['malformed response', { data: [], error: null }],
  ])('keeps the explicit enforcement-off escape hatch for %s', async (_label, response) => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    rpc.mockResolvedValue(response);
    const { claimTournamentLease } = await load();
    await expect(claimTournamentLease(T)).resolves.toEqual({
      status: 'granted',
      verified: false,
    });
  });
});

describe('heartbeatTournaments - "could not ask" is not "lost everything"', () => {
  it('reports nothing lost when the RPC errors', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { heartbeatTournaments } = await load();
    // The inversion that turns a fail-safe into an outage.
    await expect(heartbeatTournaments([T, 'b'])).resolves.toEqual([]);
  });

  it('reports nothing lost when the RPC throws', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockRejectedValue(new Error('boom'));
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments([T])).resolves.toEqual([]);
  });

  it('reports the ones another LIVE instance took, when enforcing', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [
        { tournament_id: T, state: 'kept' },
        { tournament_id: 'lost-one', state: 'taken' },
      ],
      error: null,
    });
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments([T, 'lost-one'])).resolves.toEqual(['lost-one']);
  });

  /**
   * This side is the one that was actually hurting players.
   * ENGINE_TOURNAMENT_LEASE_ENFORCE is ON in production, so every false
   * "taken" STOPPED A RUNNING TOURNAMENT MANAGER. On 2026-08-29 that path
   * fired 101 times in an hour against 19 running tournaments.
   */
  it('does NOT stop a tournament whose lease is merely missing or stale', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [
        { tournament_id: 'no-row', state: 'missing' },
        { tournament_id: 'quiet', state: 'stale' },
        { tournament_id: 'really-taken', state: 'taken' },
      ],
      error: null,
    });
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments(['no-row', 'quiet', 'really-taken'])).resolves.toEqual([
      'really-taken',
    ]);
  });

  it('reports nothing lost while enforcement is off', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'off';
    rpc.mockResolvedValue({ data: [], error: null });
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments([T])).resolves.toEqual([]);
  });

  it('does not call the database for an empty list', async () => {
    const { heartbeatTournaments } = await load();
    await expect(heartbeatTournaments([])).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('releaseTournaments', () => {
  it('never throws on the shutdown path', async () => {
    rpc.mockRejectedValue(new Error('gone'));
    const { releaseTournaments } = await load();
    await expect(releaseTournaments()).resolves.toBeUndefined();
  });
});
