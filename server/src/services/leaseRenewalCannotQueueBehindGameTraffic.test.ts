/**
 * LEASE RENEWAL CANNOT QUEUE BEHIND GAME TRAFFIC (2026-09-24)
 *
 * On 2026-09-22 PostgREST's connection pool was held by game traffic and
 * answered 437 requests with 504 PGRST003 in 35 seconds. Every lease
 * heartbeat rode that same pool, none was answered inside the 20 s proof
 * window, and every manager's proof expired at once (1,616
 * lease_proof_expired, 572 tournament_lease_lost in one minute).
 *
 * The first two cases reproduce that: every shared Data API request hangs.
 * Before the fix no proof is ever renewed and the managers' authority ends at
 * 20 s. With the fix the renewal is answered on the dedicated session. The
 * rest pin what did NOT change: busy and UNKNOWN extend nothing, a dead
 * session never blocks the loop, and no configuration means the shared
 * client exactly as before. See leaseHeartbeatSession.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Behaviour = {
  connect: (client: FakeClient) => Promise<unknown>;
  query: (client: FakeClient, text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};
interface FakeClient {
  config: Record<string, unknown>;
  queries: string[];
  ended: boolean;
}

const pgFake = vi.hoisted(() => {
  const state = {
    clients: [] as FakeClient[],
    behaviour: null as unknown as Behaviour,
  };
  class Client {
    queries: string[] = [];
    ended = false;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(public config: Record<string, unknown>) {
      state.clients.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    removeAllListeners(event?: string) {
      if (event) this.listeners.delete(event);
      else this.listeners.clear();
      return this;
    }
    connect() {
      return state.behaviour.connect(this);
    }
    query(text: string, values?: unknown[]) {
      this.queries.push(text);
      return state.behaviour.query(this, text, values);
    }
    async end() {
      this.ended = true;
    }
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
const hang = () => new Promise<never>(() => undefined);

/** A healthy Postgres: answers `state` for every claim it is asked about. */
function answering(state = 'kept'): Behaviour {
  return {
    connect: async () => undefined,
    query: async (_client, text, values) => {
      if (text.startsWith('SET ')) return { rows: [] };
      if (text.includes('has_function_privilege')) return { rows: [{ ok: true }] };
      const claims = JSON.parse(String(values?.[1])) as Array<Record<string, string>>;
      return {
        rows: claims.map((claim) => ({
          ...(claim.tournament_id
            ? { tournament_id: claim.tournament_id }
            : { table_id: claim.table_id }),
          state,
          lease_generation: claim.lease_generation,
        })),
      };
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  vi.resetModules();
  shared.mockReset();
  pgFake.state.clients.length = 0;
  pgFake.state.behaviour = answering();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
  delete process.env.ENGINE_PG_LISTEN_URL;
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.ENGINE_PG_LISTEN_URL;
  try {
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests();
  } catch {
    /* absent before the fix */
  }
});

describe('the shared Data API pool is full of game traffic', () => {
  it('tournament proofs are still renewed past 20 s', async () => {
    process.env.ENGINE_PG_LISTEN_URL = 'postgres://session-pooler.invalid:5432/postgres';
    shared.mockImplementation(hang); // every PostgREST request waits for a pool slot
    const lease = await import('./tournamentLease.js');
    let now = 0;
    lease._setTournamentLeaseMonotonicNowForTests(() => now);
    const claims = [0, 1, 2].map((i) => ({ tournamentId: T(i), leaseGeneration: GEN }));
    const deadlines = new Map<string, number>();
    const onBatch = (outcome: Awaited<ReturnType<typeof lease.heartbeatTournaments>>) => {
      if (outcome.status !== 'answered') return;
      for (const proof of outcome.proofs)
        deadlines.set(proof.tournamentId, proof.proofDeadlineMonotonicMs);
      expect(outcome.lostTournamentIds).toEqual([]);
    };

    // Passes every 5 s, as GameServer runs them, for 30 s of pool starvation.
    for (now = 0; now <= 30_000; now += 5_000) {
      void lease.heartbeatTournaments(claims, onBatch, () => true);
      await flush();
    }
    now = 30_000;
    // Every manager still holds a proof that outlives the 20 s window.
    for (const claim of claims) {
      expect(deadlines.get(claim.tournamentId) ?? 0).toBeGreaterThan(now);
    }
  });

  it('table proofs are still renewed past 20 s', async () => {
    process.env.ENGINE_PG_LISTEN_URL = 'postgres://session-pooler.invalid:5432/postgres';
    shared.mockImplementation(hang);
    const lease = await import('./tableLease.js');
    let now = 0;
    lease._setTableLeaseMonotonicNowForTests(() => now);
    const claims = [0, 1].map((i) => ({ tableId: T(i), leaseGeneration: GEN }));
    const deadlines = new Map<string, number>();
    const onBatch = (outcome: Awaited<ReturnType<typeof lease.heartbeatTables>>) => {
      if (outcome.status !== 'answered') return;
      for (const proof of outcome.proofs)
        deadlines.set(proof.tableId, proof.proofDeadlineMonotonicMs);
      expect(outcome.lostTableIds).toEqual([]);
    };

    for (now = 0; now <= 30_000; now += 5_000) {
      void lease.heartbeatTables(claims, onBatch, () => true);
      await flush();
    }
    now = 30_000;
    for (const claim of claims) {
      expect(deadlines.get(claim.tableId) ?? 0).toBeGreaterThan(now);
    }
  });
});

describe('the dedicated session changes the transport and nothing else', () => {
  it('a hedge does not queue behind a dedicated statement that has not answered (2026-09-26)', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let statements = 0;
    pgFake.state.behaviour = {
      connect: async () => undefined,
      query: async (_client, text) => {
        if (text.startsWith('SET ')) return { rows: [] };
        if (text.includes('has_function_privilege')) return { rows: [{ ok: true }] };
        statements++;
        return hang(); // the session's statement never answers
      },
    };
    shared.mockResolvedValue({
      data: [{ tournament_id: T(1), state: 'kept', lease_generation: GEN }],
      error: null,
    });
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests({ connectionString: 'postgres://x' });
    const args = {
      p_instance_id: 'engine-1',
      p_claims: [{ tournament_id: T(1), lease_generation: GEN }],
      p_stale_seconds: 30,
    };
    void session.leaseHeartbeatRpc('tournament', args);
    await flush();
    expect(statements).toBe(1);
    expect(shared).not.toHaveBeenCalled();

    // A second question a second and a half later is a hedge: it must reach
    // the database, not wait behind the statement that has not answered.
    clock = 1_500;
    const hedge = await session.leaseHeartbeatRpc('tournament', args);
    expect(hedge.error).toBeNull();
    expect(shared).toHaveBeenCalledTimes(1);
    expect(statements).toBe(1);
  });

  it('runs one heartbeat statement per scope with an 8 s statement timeout on verified TLS', async () => {
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests({ connectionString: 'postgres://x' });
    const lease = await import('./tournamentLease.js');
    const out = await lease.heartbeatTournaments([{ tournamentId: T(1), leaseGeneration: GEN }]);
    expect(out.status).toBe('answered');
    expect(shared).not.toHaveBeenCalled();
    expect(pgFake.state.clients).toHaveLength(1);
    const [client] = pgFake.state.clients;
    expect(client.config.ssl).toEqual({ rejectUnauthorized: true });
    expect(String(client.config.application_name)).toMatch(
      /^club-arena-engine-lease-heartbeat-tournament:/
    );
    expect(client.queries[0]).toBe('SET statement_timeout = 8000');
    expect(client.queries.at(-1)).toContain(
      'FROM public.heartbeat_tournament_leases_v4($1::text, $2::jsonb, $3::integer)'
    );
  });

  it('busy on the exact generation extends nothing and accuses nobody', async () => {
    pgFake.state.behaviour = answering('busy');
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests({ connectionString: 'postgres://x' });
    const lease = await import('./tournamentLease.js');
    const out = await lease.heartbeatTournaments([{ tournamentId: T(1), leaseGeneration: GEN }]);
    expect(out).toEqual({ status: 'answered', proofs: [], lostTournamentIds: [] });
  });

  it('a statement timeout is UNKNOWN, extends nothing, and keeps the session', async () => {
    const healthy = answering();
    pgFake.state.behaviour = {
      connect: healthy.connect,
      query: async (client, text, values) => {
        if (text.includes('FROM public.heartbeat_table_leases_v4')) {
          throw Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          });
        }
        return healthy.query(client, text, values);
      },
    };
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests({ connectionString: 'postgres://x' });
    const lease = await import('./tableLease.js');
    const claims = [{ tableId: T(1), leaseGeneration: GEN }];
    expect(await lease.heartbeatTables(claims)).toEqual({
      status: 'uncertain',
      reason: 'rpc_error',
    });
    expect(await lease.heartbeatTables(claims)).toEqual({
      status: 'uncertain',
      reason: 'rpc_error',
    });
    // Not replayed on the shared client, and the same session is reused.
    expect(shared).not.toHaveBeenCalled();
    expect(pgFake.state.clients).toHaveLength(1);
    expect(pgFake.state.clients[0].ended).toBe(false);
  });

  it('a dead session is dropped, never blocks the loop, and reconnects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const healthy = answering();
    let silent = true;
    pgFake.state.behaviour = {
      connect: healthy.connect,
      query: (client, text, values) =>
        silent && text.includes('FROM public.heartbeat_tournament_leases_v4')
          ? hang()
          : healthy.query(client, text, values),
    };
    shared.mockImplementation(
      async (_name: string, args: { p_claims: Array<{ tournament_id: string }> }) => ({
        data: args.p_claims.map((c) => ({
          tournament_id: c.tournament_id,
          state: 'kept',
          lease_generation: GEN,
        })),
        error: null,
      })
    );
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests({
      connectionString: 'postgres://x',
      random: () => 0,
    });
    const lease = await import('./tournamentLease.js');
    const claims = [{ tournamentId: T(1), leaseGeneration: GEN }];

    // A silent socket: the request is UNKNOWN after the local bound.
    const first = lease.heartbeatTournaments(claims);
    await vi.advanceTimersByTimeAsync(session.LEASE_HEARTBEAT_LOCAL_BOUND_MS);
    expect(await first).toEqual({ status: 'uncertain', reason: 'rpc_error' });
    expect(pgFake.state.clients[0].ended).toBe(true);

    // During the backoff the next pass is served at once by the shared client.
    const during = await lease.heartbeatTournaments(claims);
    expect(during.status).toBe('answered');
    expect(shared).toHaveBeenCalledTimes(1);
    expect(pgFake.state.clients).toHaveLength(1);

    // The backoff (375 ms with no jitter) opens a new session in the background.
    silent = false;
    await vi.advanceTimersByTimeAsync(375);
    expect(pgFake.state.clients).toHaveLength(2);
    const after = await lease.heartbeatTournaments(claims);
    expect(after.status).toBe('answered');
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it('a session that cannot connect falls back without waiting for the retry', async () => {
    pgFake.state.behaviour = {
      connect: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
      query: answering().query,
    };
    shared.mockResolvedValue({ data: [], error: null });
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests({ connectionString: 'postgres://x' });
    const result = await session.leaseHeartbeatRpc('table', {
      p_instance_id: 'me',
      p_claims: [],
      p_stale_seconds: 30,
    });
    expect(result).toEqual({ data: [], error: null });
    expect(shared).toHaveBeenCalledWith('heartbeat_table_leases_v4', {
      p_instance_id: 'me',
      p_claims: [],
      p_stale_seconds: 30,
    });
  });

  it('a login role without EXECUTE disables the session for good and uses the shared client', async () => {
    const healthy = answering();
    pgFake.state.behaviour = {
      connect: healthy.connect,
      query: async (client, text, values) =>
        text.includes('has_function_privilege')
          ? { rows: [{ ok: false }] }
          : healthy.query(client, text, values),
    };
    shared.mockResolvedValue({ data: [], error: null });
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests({ connectionString: 'postgres://x' });
    const args = { p_instance_id: 'me', p_claims: [], p_stale_seconds: 30 };
    await session.leaseHeartbeatRpc('tournament', args);
    await session.leaseHeartbeatRpc('tournament', args);
    expect(shared).toHaveBeenCalledTimes(2);
    expect(pgFake.state.clients).toHaveLength(1);
    expect(pgFake.state.clients[0].ended).toBe(true);
    expect(session.leaseHeartbeatSessionsToPrometheus()).toContain(
      'poker_lease_heartbeat_session_enabled{scope="tournament"} 0'
    );
  });
});

describe('with no session configured nothing changes', () => {
  it('sends the exact same request through the shared client and opens no session', async () => {
    shared.mockResolvedValue({
      data: [{ tournament_id: T(1), state: 'kept', lease_generation: GEN }],
      error: null,
    });
    const lease = await import('./tournamentLease.js');
    const out = await lease.heartbeatTournaments([{ tournamentId: T(1), leaseGeneration: GEN }]);
    expect(out.status).toBe('answered');
    expect(shared).toHaveBeenCalledTimes(1);
    expect(shared.mock.calls[0][0]).toBe('heartbeat_tournament_leases_v4');
    expect(shared.mock.calls[0][1]).toEqual({
      p_instance_id: expect.any(String),
      p_claims: [{ tournament_id: T(1), lease_generation: GEN }],
      p_stale_seconds: 30,
    });
    expect(pgFake.state.clients).toHaveLength(0);
  });
});
