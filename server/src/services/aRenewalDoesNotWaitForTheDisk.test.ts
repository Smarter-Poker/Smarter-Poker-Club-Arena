/**
 * A RENEWAL DOES NOT WAIT FOR THE DISK (2026-10-03)
 *
 * At 00:53:39-41 UTC on 2026-10-03 the whole fleet fenced itself (182
 * cash_lease_proof_expired, 144 tournament_lease_proof_expired, 39
 * tournament_lease_lost) although the dedicated heartbeat session was live.
 * The checkpoint's fsyncs saturated the disk (longest 10.7 s) and nothing
 * committed from 00:53:22 to 00:53:36. The heartbeat UPDATE ran in
 * milliseconds, but its COMMIT waited for the WAL flush with the lease row
 * locks still held, so the session went silent and every hedge answered
 * `busy`. See leaseHeartbeatSession.ts.
 *
 * The model below is that database: during a flush stall a synchronous COMMIT
 * waits for the stall to end and keeps its row locks; the heartbeat function
 * skips locked rows (`busy`). The session now commits asynchronously, so the
 * same stall no longer stops renewal. What is NOT relaxed is pinned too: a
 * lease another generation took still fences the dealer and its hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineLeaseAuthority } from '../engine/ServerTableEngineBase.js';

vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

interface FakeClient {
  queries: string[];
  ended: boolean;
}
type Query = (client: FakeClient, text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;

const pgFake = vi.hoisted(() => {
  const state = { clients: [] as FakeClient[], query: null as unknown as Query };
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
    async connect() {
      return undefined;
    }
    query(text: string, values?: unknown[]) {
      this.queries.push(text);
      return state.query(this, text, values);
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

const TABLE = '11111111-2222-4333-8444-555555555555';
const GEN = 'aaaaaaaa-0000-4000-8000-000000000001';
const SUCCESSOR = 'aaaaaaaa-0000-4000-8000-000000000002';
const ASYNC_COMMIT = 'SET synchronous_commit = off';

const verifiedCash = (deadline: number): EngineLeaseAuthority => ({
  scope: 'cash',
  verified: true,
  generation: GEN,
  proofDeadlineMonotonicMs: deadline,
});

/**
 * One lease row in a Postgres whose WAL flush can stall. `holder` is the
 * generation the row names; `flushStallUntil` is when a waiting COMMIT
 * returns; `lockedUntil` is when the row lock of a waiting COMMIT is released.
 */
const db = {
  holder: GEN,
  flushStall: { from: Number.POSITIVE_INFINITY, until: 0 },
  lockedUntil: 0,
  /** Extra transit time for the next N dedicated statements (not a lock). */
  slowTransitMs: [] as number[],
};

const sleepUntil = (at: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

/** Run heartbeat_table_leases_v4 for one claim, then COMMIT (sync or async). */
async function heartbeatStatement(
  values: unknown[] | undefined,
  synchronousCommit: boolean
): Promise<{ rows: unknown[] }> {
  const [claim] = JSON.parse(String(values?.[1])) as Array<Record<string, string>>;
  const now = Date.now();
  if (db.holder !== claim.lease_generation) {
    return { rows: [{ table_id: claim.table_id, state: 'taken', lease_generation: db.holder }] };
  }
  // FOR NO KEY UPDATE SKIP LOCKED: a row another COMMIT still holds is busy.
  if (now < db.lockedUntil) {
    return { rows: [{ table_id: claim.table_id, state: 'busy', lease_generation: db.holder }] };
  }
  const row = { table_id: claim.table_id, state: 'kept', lease_generation: db.holder };
  const stalled = now >= db.flushStall.from && now < db.flushStall.until;
  if (synchronousCommit && stalled) {
    // COMMIT waits for the flush and keeps the row lock until it returns.
    db.lockedUntil = db.flushStall.until;
    await sleepUntil(db.flushStall.until);
  }
  return { rows: [row] };
}

function installDatabase(): void {
  pgFake.state.query = async (client, text, values) => {
    if (text.startsWith('SET ')) return { rows: [] };
    if (text.includes('has_function_privilege')) return { rows: [{ ok: true }] };
    const transit = db.slowTransitMs.shift() ?? 0;
    if (transit > 0) await sleepUntil(Date.now() + transit);
    return heartbeatStatement(values, !client.queries.includes(ASYNC_COMMIT));
  };
  // PostgREST keeps synchronous commit: it is the hand traffic's client.
  shared.mockImplementation(async (_fn: string, args: { p_claims: unknown[] }) => {
    const { rows } = await heartbeatStatement([null, JSON.stringify(args.p_claims)], true);
    return { data: rows, error: null };
  });
}

async function harness() {
  const session = await import('./leaseHeartbeatSession.js');
  await session._resetLeaseHeartbeatSessionsForTests({
    connectionString: 'postgres://x',
    random: () => 0.5,
  });
  const lease = await import('./tableLease.js');
  const base = await import('../engine/ServerTableEngineBase.js');
  const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
  lease._setTableLeaseMonotonicNowForTests(() => Date.now());
  base._setEngineLeaseMonotonicNowForTests(() => Date.now());

  const engine = new ServerTableEngine(TABLE, verifiedCash(Date.now() + 20_000));
  const internals = engine as unknown as { running: boolean; armEngineLeaseExpiryTimer(): void };
  internals.running = true;
  internals.armEngineLeaseExpiryTimer();

  const lost: string[] = [];
  /* What GameServer.renewVerifiedCashTableLeaseProofs does with a batch. */
  const apply = (outcome: Awaited<ReturnType<typeof lease.heartbeatTables>>) => {
    if (outcome.status !== 'answered') return;
    for (const proof of outcome.proofs) {
      engine.renewEngineLeaseProof(verifiedCash(proof.proofDeadlineMonotonicMs));
    }
    for (const tableId of outcome.lostTableIds) {
      lost.push(tableId);
      engine.fenceForEngineLeaseLoss('cash_table_lease_lost', false);
    }
  };
  /* One GameServer renewal pass: dispatch, never await the transport. */
  const pass = () =>
    void lease.heartbeatTables(
      [{ tableId: TABLE, leaseGeneration: GEN }],
      apply,
      () => true,
      () => engine.hasCurrentEngineLeaseAuthority()
    );
  /* Passes every 5 s (OWNERSHIP_LEASE_RENEWAL_CADENCE_MS) up to `untilMs`. */
  const runPassesUntil = async (untilMs: number, alive?: (at: number) => void) => {
    while (Date.now() < untilMs) {
      pass();
      await vi.advanceTimersByTimeAsync(5_000);
      alive?.(Date.now());
    }
  };
  return { engine, lost, pass, runPassesUntil, session };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(0);
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  delete process.env.ENGINE_PG_LISTEN_URL;
  pgFake.state.clients.length = 0;
  shared.mockReset();
  db.holder = GEN;
  db.flushStall = { from: Number.POSITIVE_INFINITY, until: 0 };
  db.lockedUntil = 0;
  db.slowTransitMs = [];
  installDatabase();
});

afterEach(async () => {
  try {
    const session = await import('./leaseHeartbeatSession.js');
    await session._resetLeaseHeartbeatSessionsForTests();
  } catch {
    /* module never loaded */
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a lease renewal does not wait for the disk', () => {
  it('the dedicated session commits asynchronously, before it renews anything', async () => {
    const { pass } = await harness();
    pass();
    await vi.advanceTimersByTimeAsync(0);
    const [client] = pgFake.state.clients;
    expect(client.queries.slice(0, 2)).toEqual(['SET statement_timeout = 8000', ASYNC_COMMIT]);
    expect(client.queries.at(-1)).toContain('FROM public.heartbeat_table_leases_v4(');
    expect(shared).not.toHaveBeenCalled();
  });

  it('a 25 s WAL flush stall (00:53:11-00:53:36) no longer expires the proof', async () => {
    const { engine, lost, runPassesUntil } = await harness();
    // Same shape as production: renewals answered, then 25 s with no flush.
    db.flushStall = { from: 6_000, until: 31_000 };
    await runPassesUntil(45_000, () => {
      expect(engine.isRunning()).toBe(true);
      expect(engine.hasCurrentEngineLeaseAuthority()).toBe(true);
    });
    expect(lost).toEqual([]);
    // Nothing ever waited on the flush holding the row: no busy, no hedge.
    expect(shared).not.toHaveBeenCalled();
  });

  it('a heartbeat that takes 12 s does not expire the proof when the next renewal succeeds', async () => {
    const { engine, lost, runPassesUntil, session } = await harness();
    // t=0 renews on the session; the t=5 s statement then takes 12 s.
    db.slowTransitMs = [0, 12_000];
    await runPassesUntil(40_000, () => {
      expect(engine.isRunning()).toBe(true);
      expect(engine.hasCurrentEngineLeaseAuthority()).toBe(true);
    });
    expect(lost).toEqual([]);
    // The t=10 s pass asked again without queueing behind the slow statement.
    expect(shared).toHaveBeenCalled();
    // The silent statement was dropped at its 10 s bound and the session came back.
    const metrics = session.leaseHeartbeatSessionsToPrometheus().join('\n');
    expect(metrics).toContain('poker_lease_heartbeat_session_connected{scope="table"} 1');
  });

  it('a lease another generation took still fences the dealer and refuses its hand', async () => {
    const { engine, lost, runPassesUntil } = await harness();
    await runPassesUntil(10_000);
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(true);

    // Another generation claims the row (the database fence moved it).
    db.holder = SUCCESSOR;
    await runPassesUntil(15_000);
    expect(lost).toEqual([TABLE]);
    // The gate ServerTableEngineSettlement.logHandHistory checks before and
    // after the atomic hand commit: false means "refused (lease_proof_expired)".
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(false);
    expect(engine.isRunning()).toBe(false);
    // Fenced long before its old 20 s proof would have run out, and a later
    // `kept`-shaped proof for the old generation cannot revive it.
    expect(Date.now()).toBeLessThan(10_000 + 20_000);
    expect(engine.renewEngineLeaseProof(verifiedCash(Date.now() + 20_000))).toBe(false);
  });

  it('a taker is still named during a flush stall, sooner than before', async () => {
    const { engine, lost, runPassesUntil } = await harness();
    db.flushStall = { from: 6_000, until: 31_000 };
    await runPassesUntil(10_000);
    db.holder = SUCCESSOR;
    await runPassesUntil(15_000);
    // Answered at once: async commit never parks the session on the stall.
    expect(lost).toEqual([TABLE]);
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(false);
    expect(engine.isRunning()).toBe(false);
  });
});
