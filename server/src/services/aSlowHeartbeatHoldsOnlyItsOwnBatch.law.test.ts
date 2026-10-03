/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SLOW HEARTBEAT HOLDS ONLY ITS OWN BATCH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-10-03)
 *
 * At 09:34:33 UTC the dedicated tournament renewal statement - one statement
 * carrying all ~300 claims, because a request held up to 500 - ran its full
 * 8 s and was cancelled (09:34:41.003, Postgres pid 3566275). It waited on no
 * lock: heartbeat_tournament_leases_v4 already SKIPs locked rows and
 * log_lock_waits (1 s) recorded nothing for it. But it held the row lock of
 * every lease it had renewed until it would commit, so the hedge answered
 * `busy` for every row, and at 09:34:42-47 every manager's proof ran out
 * together (lease_proof_expired, tournament_lease_lost, watchdog_kill).
 *
 * WHAT THIS LAW PINS
 *
 *   1. A request carries at most 50 claims.
 *   2. Replaying the incident - the statement holding the first batch never
 *      answers - every OTHER tournament is still renewed, on the dedicated
 *      session or, if it would have to queue more than a second behind the
 *      statement that has not answered, on the shared client.
 *   3. The stuck batch's own claims extend nothing and accuse nobody: an
 *      UNKNOWN answer is still UNKNOWN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Query = (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
const pgFake = vi.hoisted(() => {
  const state = { query: null as unknown as Query };
  class Client {
    constructor(public config: Record<string, unknown>) {}
    on() {
      return this;
    }
    removeAllListeners() {
      return this;
    }
    async connect() {
      return undefined;
    }
    query(text: string, values?: unknown[]) {
      return state.query(text, values);
    }
    async end() {}
  }
  return { state, Client };
});
vi.mock('pg', () => ({ default: { Client: pgFake.Client } }));

const shared = vi.fn();
vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: (...args: unknown[]) => shared(...args) },
}));

const T = (n: number) => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const GEN = 'bbbbbbbb-0000-4000-8000-000000000001';
const FLEET = 300;
const claims = () =>
  Array.from({ length: FLEET }, (_, i) => ({ tournamentId: T(i), leaseGeneration: GEN }));
const kept = (asked: Array<{ tournament_id: string; lease_generation: string }>) =>
  asked.map((c) => ({
    tournament_id: c.tournament_id,
    state: 'kept',
    lease_generation: c.lease_generation,
  }));

beforeEach(() => {
  vi.resetModules();
  shared.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
  delete process.env.ENGINE_PG_LISTEN_URL;
});
afterEach(async () => {
  const session = await import('./leaseHeartbeatSession.js');
  await session._resetLeaseHeartbeatSessionsForTests();
  vi.restoreAllMocks();
});

/**
 * The incident: the session statement that carries T(0) never answers until
 * the test cancels it (statement_timeout, 57014). Every other statement, and
 * every shared-client request, answers `kept`.
 */
async function replay() {
  let cancel!: () => void;
  const stuck = new Promise<never>((_, reject) => {
    cancel = () =>
      reject(
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      );
  });
  let stuckBatch: string[] = [];
  pgFake.state.query = async (text, values) => {
    if (text.startsWith('SET ')) return { rows: [] };
    if (text.includes('has_function_privilege')) return { rows: [{ ok: true }] };
    const asked = JSON.parse(String(values?.[1])) as Array<{
      tournament_id: string;
      lease_generation: string;
    }>;
    if (asked.some((c) => c.tournament_id === T(0))) {
      stuckBatch = asked.map((c) => c.tournament_id);
      return stuck;
    }
    return { rows: kept(asked) };
  };
  shared.mockImplementation(async (_name: string, args: { p_claims: never[] }) => ({
    data: kept(args.p_claims),
    error: null,
  }));
  const session = await import('./leaseHeartbeatSession.js');
  await session._resetLeaseHeartbeatSessionsForTests({ connectionString: 'postgres://x' });
  const lease = await import('./tournamentLease.js');
  const pass = lease.heartbeatTournaments(claims());
  return { pass, cancel, stuckBatch: () => stuckBatch };
}

describe('the production bound', () => {
  it('sends a 300-tournament pass as requests of at most 50 claims', async () => {
    shared.mockImplementation(async (_name: string, args: { p_claims: never[] }) => ({
      data: kept(args.p_claims),
      error: null,
    }));
    const { HEARTBEAT_CLAIMS_PER_REQUEST } = await import('./leaseHeartbeatBatches.js');
    expect(HEARTBEAT_CLAIMS_PER_REQUEST).toBe(50);
    const lease = await import('./tournamentLease.js');
    const out = await lease.heartbeatTournaments(claims());
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    expect(out.proofs).toHaveLength(FLEET);
    expect(shared).toHaveBeenCalledTimes(6);
    expect(shared.mock.calls.every(([, args]) => args.p_claims.length <= 50)).toBe(true);
  });
});

describe('the 2026-10-03 replay: one renewal statement does not answer', () => {
  it('every other tournament is still renewed, and the stuck batch is UNKNOWN', async () => {
    const { pass, cancel, stuckBatch } = await replay();
    // The batches queued behind the stuck statement give up their turn after
    // a second and ask on the shared client; later batches go there at once.
    await vi.waitFor(() => expect(shared).toHaveBeenCalledTimes(5), { timeout: 3_000 });
    cancel(); // 8 s later Postgres cancels the stuck statement
    const out = await pass;
    expect(out.status).toBe('answered');
    if (out.status !== 'answered') throw new Error('expected an answer');
    expect(stuckBatch()).toHaveLength(50);
    const renewed = new Set(out.proofs.map((p) => p.tournamentId));
    expect(renewed.size).toBe(FLEET - 50);
    for (const id of stuckBatch()) expect(renewed.has(id)).toBe(false);
    expect(out.lostTournamentIds).toEqual([]);
  });

  it('before: with one request for the whole fleet the same statement renewed nobody', async () => {
    (await import('./leaseHeartbeatBatches.js'))._setHeartbeatClaimsPerRequestForTests(500);
    const { pass, cancel, stuckBatch } = await replay();
    await vi.waitFor(() => expect(stuckBatch()).toHaveLength(FLEET));
    cancel();
    const out = await pass;
    // UNKNOWN for the whole fleet: no proof was renewed (nobody is accused,
    // but every proof runs out 20 s after the last renewal).
    expect(
      out.status === 'uncertain' || (out.status === 'answered' && out.proofs.length === 0)
    ).toBe(true);
    expect(shared).not.toHaveBeenCalled();
  });
});
