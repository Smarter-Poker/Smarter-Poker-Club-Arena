import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { enginePgSsl } from './supabase/enginePgSession.js';
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: vi.fn() } }));
import {
  createLightningFoldSession,
  LIGHTNING_FOLD_SQL,
  type LightningFoldClient,
} from './lightningFoldSession.js';
import { runWithTournamentDataAuthority } from './supabase/dataActorContext.js';
import { registerTournamentManagerFenceHandler } from './supabase/tournamentManagerFence.js';

const args = {
  p_hand_id: '027ab7d1-b13c-4a9d-a7c3-4616f3d39e29',
  p_player_id: '121f80d2-5290-42e5-a32b-4d3a702e2772',
  p_request_id: 'b13cc1cf-8efc-4147-a262-cb2c640bf701',
  p_fold_type: 'normal' as const,
  p_committed: 1.25,
};
const url =
  'postgresql://engine_lightning_fold:private-secret@db.example.test:5432/postgres?sslmode=require';
afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const clients: Array<LightningFoldClient & { release: ReturnType<typeof vi.fn> }> = [];
  let queryWork:
    | ((text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>)
    | undefined;
  const connect = vi.fn(async () => {
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.startsWith('SELECT current_user')) return { rows: [{ ok: true }] };
        if (queryWork) return queryWork(text, values);
        if (text === 'COMMIT') return { rows: [], command: 'COMMIT' };
        return { rows: [{ result: { ok: true, receipt: 'original' } }] };
      }),
      release: vi.fn(),
    };
    clients.push(client);
    return client;
  });
  const pool = { connect, end: vi.fn(async () => {}), on: vi.fn() };
  const logs: string[] = [];
  const readUrl = vi.fn(async () => url);
  const openPool = vi.fn((_connectionString: string) => pool);
  const session = createLightningFoldSession({
    readUrl,
    openPool,
    log: (line) => logs.push(line),
    timeoutMs: 1_000,
  });
  return {
    session,
    pool,
    queries,
    clients,
    logs,
    readUrl,
    openPool,
    setQuery: (work: typeof queryWork) => {
      queryWork = work;
    },
  };
}

describe('dedicated original Lightning fold session', () => {
  it.each(['ssl=0', 'sslmode=disable'])(
    'prevents URL query parameters from overriding the verified login, session port and TLS: %s',
    async (sslQuery) => {
      const f = fixture();
      const tls = enginePgSsl();
      let parameters!: { user: string; port: number; ssl: unknown; options: unknown };
      let canonical = '';
      const session = createLightningFoldSession({
        readUrl: async () =>
          url.split('?')[0] +
          `?${sslQuery}&user=postgres&port=6543&options=-c%20synchronous_commit%3Doff#ignored-fragment`,
        openPool: (connectionString) => {
          canonical = connectionString;
          const client = new pg.Client({ connectionString, ssl: tls });
          parameters = (client as unknown as { connectionParameters: typeof parameters })
            .connectionParameters;
          return f.pool;
        },
        log: () => {},
      });
      expect(await session.start()).toBe(true);
      expect(parameters.user).toBe('engine_lightning_fold');
      expect(parameters.port).toBe(5432);
      expect(parameters.ssl).toBe(tls);
      expect(parameters.options).toBeFalsy();
      expect(new URL(canonical).search).toBe('');
      expect(new URL(canonical).hash).toBe('');
      await session.stop();
    }
  );
  it('warms separate constrained sockets and acknowledges only the original durable transaction', async () => {
    const f = fixture();
    expect(await f.session.start()).toBe(true);
    expect(f.pool.connect).toHaveBeenCalledTimes(4);
    expect(f.openPool.mock.calls[0][0]).not.toContain('sslmode');
    expect(f.readUrl).toHaveBeenCalledTimes(1);
    expect(await f.session.call(args)).toEqual({
      data: { ok: true, receipt: 'original' },
      error: null,
    });
    const original = f.queries.filter((q) => !q.text.startsWith('SELECT current_user'));
    expect(original.map((q) => q.text)).toEqual([
      expect.stringContaining('SET LOCAL synchronous_commit = on'),
      LIGHTNING_FOLD_SQL,
      'COMMIT',
    ]);
    expect(original[1].values?.slice(0, 5)).toEqual([
      args.p_hand_id,
      args.p_player_id,
      args.p_request_id,
      'normal',
      1.25,
    ]);
    expect(JSON.parse(String(original[1].values?.[5]))).toEqual({
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    });
    expect(f.logs.join()).not.toContain('private-secret');
    await f.session.stop();
    expect(f.pool.end).toHaveBeenCalledTimes(1);
    expect(await f.session.call(args)).toBeNull();
  });

  it('does not return a successful result before COMMIT completes', async () => {
    const f = fixture();
    await f.session.start();
    const commit = deferred<{ rows: Array<Record<string, unknown>>; command?: string }>();
    f.setQuery(async (text) =>
      text === 'COMMIT' ? commit.promise : { rows: [{ result: { ok: true } }] }
    );
    let answered = false;
    const call = f.session.call(args).then((value) => {
      answered = true;
      return value;
    });
    await vi.waitFor(() => expect(f.queries.some((q) => q.text === 'COMMIT')).toBe(true));
    expect(answered).toBe(false);
    commit.resolve({ rows: [], command: 'COMMIT' });
    expect(await call).toEqual({ data: { ok: true }, error: null });
    await f.session.stop();
  });

  it.each(['statement', 'commit'])(
    'preserves an ambiguous %s result without replay or fallback admission',
    async (phase) => {
      const f = fixture();
      await f.session.start();
      f.setQuery(async (text) => {
        if (
          (phase === 'statement' && text === LIGHTNING_FOLD_SQL) ||
          (phase === 'commit' && text === 'COMMIT')
        )
          throw new Error('private backend detail');
        return { rows: [{ result: { ok: true } }] };
      });
      expect(await f.session.call(args)).toEqual({
        data: null,
        error: { message: 'lightning_fold_outcome_unknown', code: 'LIGHTNING_FOLD_UNKNOWN' },
      });
      expect(f.queries.filter((q) => q.text === LIGHTNING_FOLD_SQL)).toHaveLength(1);
      expect(f.clients.at(-1)?.release).toHaveBeenCalledWith(true);
      expect(f.logs.join()).not.toContain('private backend detail');
      await f.session.stop();
    }
  );

  it('releases late acquisition without dispatch after the original HTTP route becomes eligible', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start();
    const late = deferred<LightningFoldClient>();
    f.pool.connect.mockImplementationOnce(() => late.promise as never);
    const call = f.session.call(args);
    await vi.advanceTimersByTimeAsync(100);
    expect(await call).toBeNull();
    const client = { query: vi.fn(), release: vi.fn() };
    late.resolve(client);
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.query).not.toHaveBeenCalled();
    await f.session.stop();
  });

  it('sends BEGIN, the original wrapper and COMMIT together in one round trip', async () => {
    const f = fixture();
    await f.session.start();
    const begin = deferred<{ rows: Array<Record<string, unknown>> }>();
    f.setQuery(async (text) => {
      if (text.startsWith('BEGIN')) return begin.promise;
      if (text === 'COMMIT') return { rows: [], command: 'COMMIT' };
      return { rows: [{ result: { ok: true } }] };
    });
    const call = f.session.call(args);
    // All three are on the wire before the first reply arrives.
    await vi.waitFor(() =>
      expect(
        f.queries.filter((q) => !q.text.startsWith('SELECT current_user')).map((q) => q.text)
      ).toEqual([expect.stringContaining('BEGIN'), LIGHTNING_FOLD_SQL, 'COMMIT'])
    );
    begin.resolve({ rows: [] });
    expect(await call).toEqual({ data: { ok: true }, error: null });
    await f.session.stop();
  });

  it('never falls back to a second route once the pipelined original is on the wire', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start();
    const begin = deferred<{ rows: Array<Record<string, unknown>> }>();
    f.setQuery(async (text) => (text.startsWith('BEGIN') ? begin.promise : { rows: [] }));
    const call = f.session.call(args);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await call)?.error?.code).toBe('LIGHTNING_FOLD_UNKNOWN');
    begin.resolve({ rows: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.queries.filter((q) => q.text === LIGHTNING_FOLD_SQL)).toHaveLength(1);
    expect(f.session.toPrometheus()).toContain('poker_lightning_fold_session_committed_total 0');
    expect(f.clients.at(-1)?.release).toHaveBeenCalledWith(true);
    await f.session.stop();
  });

  it('acknowledges nothing when the queued COMMIT answers ROLLBACK', async () => {
    const f = fixture();
    await f.session.start();
    f.setQuery(async (text) =>
      text === 'COMMIT' ? { rows: [], command: 'ROLLBACK' } : { rows: [{ result: { ok: true } }] }
    );
    expect(await f.session.call(args)).toEqual({
      data: null,
      error: { message: 'lightning_fold_outcome_unknown', code: 'LIGHTNING_FOLD_UNKNOWN' },
    });
    expect(f.session.toPrometheus()).toContain('poker_lightning_fold_session_committed_total 0');
    expect(f.clients.at(-1)?.release).toHaveBeenCalledWith(true);
    await f.session.stop();
  });

  it('does not replay or acknowledge a COMMIT that completes after the request boundary', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start();
    const commit = deferred<{ rows: Array<Record<string, unknown>>; command?: string }>();
    f.setQuery(async (text) =>
      text === 'COMMIT' ? commit.promise : { rows: [{ result: { ok: true } }] }
    );
    const call = f.session.call(args);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await call)?.error?.code).toBe('LIGHTNING_FOLD_UNKNOWN');
    commit.resolve({ rows: [], command: 'COMMIT' });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.session.toPrometheus()).toContain('poker_lightning_fold_session_committed_total 0');
    expect(f.queries.filter((q) => q.text === LIGHTNING_FOLD_SQL)).toHaveLength(1);
    await f.session.stop();
  });

  it('bounds admission at four active calls without queueing a fifth original request', async () => {
    const f = fixture();
    await f.session.start();
    const pending = deferred<{ rows: Array<Record<string, unknown>> }>();
    f.setQuery(async (text) => (text === LIGHTNING_FOLD_SQL ? pending.promise : { rows: [] }));
    const active = Array.from({ length: 4 }, () => f.session.call(args));
    expect(await f.session.call(args)).toBeNull();
    await vi.waitFor(() =>
      expect(f.queries.filter((q) => q.text === LIGHTNING_FOLD_SQL)).toHaveLength(4)
    );
    pending.resolve({ rows: [{ result: { ok: true } }] });
    await Promise.all(active);
    await f.session.stop();
  });

  it('captures each original actor before acquisition and delivers a fence only to its manager', async () => {
    const f = fixture();
    await f.session.start();
    const authority = { tournamentId: args.p_hand_id, leaseGeneration: args.p_request_id };
    const fenced = vi.fn();
    const unregister = registerTournamentManagerFenceHandler(authority, fenced);
    f.setQuery(async (text, values) => {
      if (text === LIGHTNING_FOLD_SQL) {
        const headers = JSON.parse(String(values?.[5]));
        if (headers['x-smarter-data-actor'] === 'tournament-manager')
          throw new Error('TOURNAMENT_MANAGER_FENCED');
      }
      return { rows: [{ result: { ok: true } }] };
    });
    await Promise.all([
      runWithTournamentDataAuthority(authority, () => f.session.call(args)),
      f.session.call(args),
    ]);
    expect(fenced).toHaveBeenCalledTimes(1);
    const headers = f.queries
      .filter((q) => q.text === LIGHTNING_FOLD_SQL)
      .map((q) => JSON.parse(String(q.values?.[5])));
    expect(headers).toContainEqual({
      'x-smarter-data-actor': 'tournament-manager',
      'x-smarter-data-protocol': '2',
      'x-smarter-tournament-id': authority.tournamentId,
      'x-smarter-tournament-lease-generation': authority.leaseGeneration,
    });
    expect(headers).toContainEqual({
      'x-smarter-data-actor': 'service',
      'x-smarter-data-protocol': '1',
    });
    unregister();
    await f.session.stop();
  });

  it('bounds the entire warmup and never advertises readiness after a late query', async () => {
    vi.useFakeTimers();
    const late = deferred<{ rows: Array<Record<string, unknown>> }>();
    const client = { query: vi.fn(() => late.promise), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => {}), on: vi.fn() };
    const session = createLightningFoldSession({
      readUrl: async () => url,
      openPool: () => pool,
      log: () => {},
    });
    const start = session.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await start).toBe(false);
    late.resolve({ rows: [{ ok: true }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(await session.call(args)).toBeNull();
    expect(session.toPrometheus()).toContain('poker_lightning_fold_session_ready 0');
    await session.stop();
  });

  it.each([
    url.replace('5432', '6543'),
    url.replace('engine_lightning_fold', 'engine_lease_heartbeat'),
    'not a credential',
  ])('refuses other credentials or transaction pooling without exposing them', async (value) => {
    const openPool = vi.fn();
    const logs: string[] = [];
    const session = createLightningFoldSession({
      readUrl: async () => value,
      openPool,
      log: (line) => logs.push(line),
    });
    expect(await session.start()).toBe(false);
    expect(openPool).not.toHaveBeenCalled();
    expect(await session.call(args)).toBeNull();
    expect(logs.join()).not.toContain('private-secret');
    await session.stop();
  });
});
