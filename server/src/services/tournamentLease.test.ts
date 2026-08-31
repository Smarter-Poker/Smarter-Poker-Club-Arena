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
 * A lease check sits in front of "may I run this tournament", so the tests that
 * matter most are the FAIL-OPEN ones: a database problem must never be the
 * reason every tournament on the platform stops.
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

describe('claimTournament - fail open, always', () => {
  it('runs the tournament when the RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { claimTournament } = await load();
    // A lease problem must never be the reason a tournament fails to start.
    await expect(claimTournament(T)).resolves.toBe(true);
  });

  it('runs the tournament when the RPC throws', async () => {
    rpc.mockRejectedValue(new Error('ETIMEDOUT'));
    const { claimTournament } = await load();
    await expect(claimTournament(T)).resolves.toBe(true);
  });

  it('runs it when granted', async () => {
    rpc.mockResolvedValue({
      data: [{ granted: true, holder: 'me', holder_age_seconds: 0 }],
      error: null,
    });
    const { claimTournament } = await load();
    await expect(claimTournament(T)).resolves.toBe(true);
  });
});

describe('claimTournament - with enforcement OFF (today)', () => {
  it('records the conflict but still runs it', async () => {
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-instance', holder_age_seconds: 4 }],
      error: null,
    });
    const { claimTournament, tournamentLeaseDiagnostics } = await load();
    // Evidence before behaviour -- exactly how the table lease was rolled out.
    await expect(claimTournament(T)).resolves.toBe(true);
    const d = tournamentLeaseDiagnostics();
    expect(d.enforced).toBe(false);
    expect(d.conflictCount).toBe(1);
    expect(d.conflicts[0].holder).toBe('other-instance');
  });
});

describe('claimTournament - with enforcement ON', () => {
  it('stands down when another instance holds it', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-instance', holder_age_seconds: 4 }],
      error: null,
    });
    const { claimTournament } = await load();
    // THE POINT: this is what stops two managers on one tournament.
    await expect(claimTournament(T)).resolves.toBe(false);
  });

  it('still fails open on a database error', async () => {
    process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { claimTournament } = await load();
    await expect(claimTournament(T)).resolves.toBe(true);
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
