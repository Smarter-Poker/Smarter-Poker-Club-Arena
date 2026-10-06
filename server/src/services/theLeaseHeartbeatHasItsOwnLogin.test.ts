/**
 * THE LEASE HEARTBEAT HAS ITS OWN LOGIN (2026-10-02)
 *
 * About fifteen times in 24 hours the engine lost every table and tournament
 * lease at once. At 22:27Z the last heartbeat answered at 22:27:07 in 338 ms;
 * PostgREST then answered nobody for ~20 s (PGRST003, pool exhausted), the
 * 20 s proof ran out at 22:27:27 and ~340 tables fenced themselves while one
 * engine instance existed. The dedicated heartbeat session (#5166) would have
 * carried the heartbeats, but it had no credential: ENGINE_PG_LISTEN_URL was
 * never set on the host, so it was disabled for the life of every process.
 *
 * Here the host sets no variable, the engine reads the session URL from Vault
 * (fn_engine_lease_session_url, migration 20261002223745), and:
 *   - a stalled shared pool no longer costs a single proof (tables and
 *     tournaments keep authority past 30 s of stall);
 *   - a REAL conflict the database answers on that session still fences at
 *     once - the transport changed, the verdicts did not;
 *   - without the credential the old failure is reproduced exactly;
 *   - a failed read is retried, a definitive "no secret" is not, and the URL
 *     is never written to a log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClient {
  config: Record<string, unknown>;
  queries: string[];
}
type Behaviour = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const pgFake = vi.hoisted(() => {
  const state = { clients: [] as FakeClient[], behaviour: null as unknown as Behaviour };
  class Client {
    queries: string[] = [];
    constructor(public config: Record<string, unknown>) {
      state.clients.push(this);
    }
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
      this.queries.push(text);
      return state.behaviour.query(text, values);
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

const SECRET = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const VAULT_URL = `postgresql://engine_lease_heartbeat.ref:${SECRET}@pooler.invalid:5432/postgres`;
const T = (n: number) => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const GEN = 'bbbbbbbb-0000-4000-8000-000000000001';
const hang = () => new Promise<never>(() => undefined);

/** Postgres answers `state` for every claim on the dedicated session. */
function answering(state: string): Behaviour {
  return {
    query: async (text, values) => {
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

/** The 22:27Z pool: the Vault read answers (or not), every heartbeat waits for a slot. */
function stalledPool(vault: () => Promise<unknown>) {
  shared.mockImplementation((fn: string) =>
    fn === 'fn_engine_lease_session_url' ? vault() : hang()
  );
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

const logged: string[] = [];
beforeEach(() => {
  vi.resetModules();
  shared.mockReset();
  pgFake.state.clients.length = 0;
  pgFake.state.behaviour = answering('kept');
  logged.length = 0;
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE = 'on';
  delete process.env.ENGINE_PG_LISTEN_URL;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const session = await import('./leaseHeartbeatSession.js');
  await session._resetLeaseHeartbeatSessionsForTests();
});

/** Heartbeat tables every 5 s through `seconds` of stall; returns each proof deadline. */
async function tablesThroughStall(seconds: number, state?: string) {
  if (state) pgFake.state.behaviour = answering(state);
  const lease = await import('./tableLease.js');
  let now = 0;
  lease._setTableLeaseMonotonicNowForTests(() => now);
  const claims = [0, 1, 2].map((i) => ({ tableId: T(i), leaseGeneration: GEN }));
  const deadlines = new Map<string, number>();
  const lost = new Set<string>();
  const onBatch = (outcome: Awaited<ReturnType<typeof lease.heartbeatTables>>) => {
    if (outcome.status !== 'answered') return;
    for (const proof of outcome.proofs)
      deadlines.set(proof.tableId, proof.proofDeadlineMonotonicMs);
    for (const id of outcome.lostTableIds) lost.add(id);
  };
  for (now = 0; now <= seconds * 1000; now += 5_000) {
    void lease.heartbeatTables(claims, onBatch, () => true);
    await flush();
  }
  now = seconds * 1000;
  return { claims, deadlines, lost, now };
}

describe('a stalled PostgREST pool no longer costs the fleet its leases', () => {
  it('table proofs outlive 30 s of stall on the Vault credential', async () => {
    stalledPool(async () => ({ data: VAULT_URL, error: null }));
    const session = await import('./leaseHeartbeatSession.js');
    expect(await session.resolveLeaseHeartbeatSessionUrl()).toBe(true);

    const { claims, deadlines, lost, now } = await tablesThroughStall(30);
    for (const claim of claims) expect(deadlines.get(claim.tableId) ?? 0).toBeGreaterThan(now);
    expect(lost.size).toBe(0);
    expect(pgFake.state.clients[0]?.config.connectionString).toBe(VAULT_URL);
    // Not one heartbeat waited on the stalled pool.
    expect(shared.mock.calls.map(([fn]) => fn)).toEqual(['fn_engine_lease_session_url']);
  });

  it('tournament proofs outlive 30 s of stall on the Vault credential', async () => {
    stalledPool(async () => ({ data: VAULT_URL, error: null }));
    const session = await import('./leaseHeartbeatSession.js');
    await session.resolveLeaseHeartbeatSessionUrl();
    const lease = await import('./tournamentLease.js');
    let now = 0;
    lease._setTournamentLeaseMonotonicNowForTests(() => now);
    const claims = [0, 1].map((i) => ({ tournamentId: T(i), leaseGeneration: GEN }));
    const deadlines = new Map<string, number>();
    const onBatch = (outcome: Awaited<ReturnType<typeof lease.heartbeatTournaments>>) => {
      if (outcome.status !== 'answered') return;
      for (const p of outcome.proofs) deadlines.set(p.tournamentId, p.proofDeadlineMonotonicMs);
      expect(outcome.lostTournamentIds).toEqual([]);
    };
    for (now = 0; now <= 30_000; now += 5_000) {
      void lease.heartbeatTournaments(claims, onBatch, () => true);
      await flush();
    }
    now = 30_000;
    for (const claim of claims) {
      expect(deadlines.get(claim.tournamentId) ?? 0).toBeGreaterThan(now);
    }
  });

  it('a real conflict answered on the session still fences at once', async () => {
    stalledPool(async () => ({ data: VAULT_URL, error: null }));
    const session = await import('./leaseHeartbeatSession.js');
    await session.resolveLeaseHeartbeatSessionUrl();

    const { claims, deadlines, lost } = await tablesThroughStall(0, 'taken');
    expect([...lost].sort()).toEqual(claims.map((c) => c.tableId).sort());
    expect(deadlines.size).toBe(0);
  });

  it('without the credential the 22:27Z storm is reproduced: every proof lapses at 20 s', async () => {
    stalledPool(async () => ({ data: null, error: null })); // Vault holds no secret
    const session = await import('./leaseHeartbeatSession.js');
    expect(await session.resolveLeaseHeartbeatSessionUrl()).toBe(false);

    const { deadlines, lost } = await tablesThroughStall(30);
    expect(deadlines.size).toBe(0); // nothing renewed: authority ends at the 20 s window
    expect(lost.size).toBe(0); // and silence is still not called a conflict
    expect(pgFake.state.clients).toHaveLength(0);
  });
});

describe('reading the credential', () => {
  it('a read that fails is asked again; the session upgrades when it answers', async () => {
    vi.useFakeTimers();
    let vaultAnswers = false;
    stalledPool(async () =>
      vaultAnswers
        ? { data: VAULT_URL, error: null }
        : { data: null, error: { code: 'PGRST003', message: 'Timed out acquiring connection' } }
    );
    const session = await import('./leaseHeartbeatSession.js');
    expect(await session.resolveLeaseHeartbeatSessionUrl()).toBe(false);
    // Meanwhile a heartbeat goes to the shared client, exactly as before.
    void session.leaseHeartbeatRpc('table', {
      p_instance_id: 'engine-1',
      p_claims: [],
      p_stale_seconds: 30,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(pgFake.state.clients).toHaveLength(0);

    vaultAnswers = true;
    await vi.advanceTimersByTimeAsync(session.LEASE_SESSION_URL_RETRY_MS);
    await session.leaseHeartbeatRpc('table', {
      p_instance_id: 'engine-1',
      p_claims: [{ table_id: T(1), lease_generation: GEN }],
      p_stale_seconds: 30,
    });
    expect(pgFake.state.clients).toHaveLength(1);
    expect(pgFake.state.clients[0]?.config.connectionString).toBe(VAULT_URL);
  });

  it('a host variable wins and Vault is never asked', async () => {
    process.env.ENGINE_PG_LISTEN_URL = 'postgres://host-configured.invalid:5432/postgres';
    const session = await import('./leaseHeartbeatSession.js');
    expect(await session.resolveLeaseHeartbeatSessionUrl()).toBe(true);
    expect(shared).not.toHaveBeenCalled();
  });

  it('the credential is never logged, and the pooler is verified against the Supabase root', async () => {
    stalledPool(async () => ({ data: VAULT_URL, error: null }));
    const session = await import('./leaseHeartbeatSession.js');
    await session.resolveLeaseHeartbeatSessionUrl();
    await tablesThroughStall(10);
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(logged.join('\n')).toContain('credential read from Vault');

    const { SUPABASE_ROOT_2021_CA } = await import('./supabase/enginePgSession.js');
    const ssl = pgFake.state.clients[0]?.config.ssl as {
      ca: string[];
      rejectUnauthorized: boolean;
    };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain(SUPABASE_ROOT_2021_CA);
    expect(SUPABASE_ROOT_2021_CA).toContain('BEGIN CERTIFICATE');
  });
});
