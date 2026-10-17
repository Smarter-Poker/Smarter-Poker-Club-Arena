import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const esm = { exports: {} as any };
const compiled = buildSync({
  entryPoints: [resolve('node_modules/@supabase/auth-js/dist/module/index.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
}).outputFiles[0].text;
new Function('require', 'module', 'exports', compiled)(require, esm, esm.exports);

const constructors = [
  ['CommonJS', require('@supabase/auth-js').AuthClient],
  ['ES module', esm.exports.AuthClient],
] as const;
let serial = 0;
afterEach(() => vi.restoreAllMocks());

function options(lock: any, storageValues = new Map<string, string>()) {
  return {
    url: 'https://auth-fixture.invalid/auth/v1',
    storageKey: `sdk-recovery-${serial++}`,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: true,
    storage: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageValues.set(key, value);
      },
      removeItem: (key: string) => {
        storageValues.delete(key);
      },
    },
    lock,
  };
}

describe.each(constructors)('%s authoritative SDK initialization recovery', (_kind, AuthClient) => {
  it('propagates the first acquisition failure, then the next explicit call initializes under the lock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new DOMException('fixture acquisition abort', 'AbortError');
    let calls = 0;
    let entered = 0;
    const lock = vi.fn(async (_name, _timeout, body) => {
      if (++calls === 1) throw failure;
      entered++;
      try {
        return await body();
      } finally {
        entered--;
      }
    });
    const client = new AuthClient(options(lock));
    const listener = vi.fn();
    const {
      data: { subscription },
    } = client.onAuthStateChange(listener);
    await expect(client.getSession()).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(entered).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    const recovered = await client.getSession();
    expect(recovered.error).toBeNull();
    expect(recovered.data.session).toBeNull();
    expect(calls).toBe(3); // New initialization, then the requested session read.
    expect(entered).toBe(0);
    subscription.unsubscribe();
    await new Promise((done) => setTimeout(done, 0));
    expect(console.warn).toHaveBeenCalledWith(
      '[AuthClient] Initial auth subscription admission failed',
      'AbortError'
    );
  });

  it('single-flights a recovered initialization for concurrent explicit callers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    let active = 0;
    const lock = async (_name: string, _timeout: number, body: () => Promise<unknown>) => {
      if (++calls === 1) throw new DOMException('acquire refused', 'AbortError');
      expect(++active).toBe(1);
      try {
        return await body();
      } finally {
        active--;
      }
    };
    const client = new AuthClient(options(lock));
    await expect(client.getSession()).rejects.toMatchObject({ name: 'AbortError' });
    const results = await Promise.all(Array.from({ length: 5 }, () => client.getSession()));
    expect(results.every((result: any) => result.error === null)).toBe(true);
    expect(calls).toBe(3);
    expect(active).toBe(0);
  });

  it('never retires or replays an initialization after its locked callback began', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new DOMException('callback failure', 'AbortError');
    const lock = vi.fn(async (_name, _timeout, body) => {
      await body();
      throw failure;
    });
    const client = new AuthClient(options(lock));
    await expect(client.getSession()).rejects.toBe(failure);
    await expect(client.getSession()).rejects.toBe(failure);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('preserves a stored session and delivers the genuine recovery event to its retained subscriber', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const config = options(
      async (_name: string, _timeout: number, body: () => Promise<unknown>) => {
        if (++calls === 1) throw new DOMException('acquire refused', 'AbortError');
        return body();
      }
    );
    const session = {
      access_token: 'synthetic-local-access',
      refresh_token: 'synthetic-local-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: '00000000-0000-0000-0000-000000000001' },
      token_type: 'bearer',
    };
    config.storage.setItem(config.storageKey, JSON.stringify(session));
    const client = new AuthClient(config);
    const listener = vi.fn();
    const {
      data: { subscription },
    } = client.onAuthStateChange(listener);
    await expect(client.getSession()).rejects.toMatchObject({ name: 'AbortError' });
    expect(listener).not.toHaveBeenCalled();
    const recovered = await client.getSession();
    expect(recovered.data.session.user.id).toBe(session.user.id);
    expect(listener).toHaveBeenCalledWith(
      'SIGNED_IN',
      expect.objectContaining({ user: session.user })
    );
    subscription.unsubscribe();
  });

  it('does not replay a token rejection produced after entering initialization', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = vi.fn(async (_name, _timeout, body) => body());
    const config = options(lock);
    config.storage.setItem(
      config.storageKey,
      JSON.stringify({
        access_token: 'synthetic-expired-access',
        refresh_token: 'synthetic-rejected-refresh',
        expires_at: 1,
        user: { id: '00000000-0000-0000-0000-000000000001' },
        token_type: 'bearer',
      })
    );
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 'refresh_token_not_found',
            msg: 'Fixture token refused',
          }),
          {
            status: 400,
            headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
          }
        )
    );
    const client = new AuthClient({ ...config, fetch });
    const first = await client.getSession();
    const second = await client.getSession();
    expect(first.data.session).toBeNull();
    expect(second.data.session).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(config.storage.getItem(config.storageKey)).toBeNull();
    expect(lock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an unrelated pre-acquisition exception', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new TypeError('invalid lock arguments');
    const lock = vi.fn(async () => {
      throw failure;
    });
    const client = new AuthClient(options(lock));
    await expect(client.getSession()).rejects.toBe(failure);
    await expect(client.getSession()).rejects.toBe(failure);
    expect(lock).toHaveBeenCalledTimes(1);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function admissionFixture(AuthClient: any) {
  const pending: Array<{
    timeout: number;
    body: () => Promise<unknown>;
    gate: ReturnType<typeof deferred>;
  }> = [];
  let blocked = false;
  let owned = false;
  const lock = vi.fn(async (_name, timeout, body) => {
    if (!blocked) return body();
    const gate = deferred();
    pending.push({ timeout, body, gate });
    await gate.promise;
    expect(owned).toBe(false);
    owned = true;
    try {
      return await body();
    } finally {
      owned = false;
    }
  });
  const client = new AuthClient(options(lock));
  return {
    client,
    pending,
    lock,
    owned: () => owned,
    block: () => {
      blocked = true;
    },
  };
}

const turn = () => new Promise<void>((done) => setTimeout(done, 0));

describe.each(constructors)('%s pending native admission', (_kind, AuthClient) => {
  it('admits a burst of actual getSession calls through one native waiter', async () => {
    const fixture = admissionFixture(AuthClient);
    await fixture.client.initialize();
    fixture.block();
    const reads = Promise.all(Array.from({ length: 5 }, () => fixture.client.getSession()));
    await turn();
    expect(fixture.pending).toHaveLength(1);
    fixture.pending[0].gate.resolve();
    expect((await reads).map((result) => result.error)).toEqual([null, null, null, null, null]);
    expect(fixture.owned()).toBe(false);
  });

  it('runs each admitted callback FIFO and drains after the leader rejects before release', async () => {
    const fixture = admissionFixture(AuthClient);
    await fixture.client.initialize();
    fixture.block();
    const failure = new Error('leader operation failed');
    const finish = deferred();
    const order: number[] = [];
    const leader = fixture.client._acquireLock(10000, async () => {
      expect(fixture.owned()).toBe(true);
      order.push(1);
      throw failure;
    });
    const second = fixture.client._acquireLock(10000, async () => {
      expect(fixture.owned()).toBe(true);
      order.push(2);
      await finish.promise;
      return 'second';
    });
    const third = fixture.client._acquireLock(10000, async () => {
      expect(fixture.owned()).toBe(true);
      order.push(3);
      return 'third';
    });
    const outcomes = Promise.allSettled([leader, second, third]);
    expect(order).toEqual([]);
    expect(fixture.pending).toHaveLength(1);
    fixture.pending[0].gate.resolve();
    await turn();
    expect(order).toEqual([1, 2]);
    expect(fixture.owned()).toBe(true);
    finish.resolve();
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: 'second' },
      { status: 'fulfilled', value: 'third' },
    ]);
    expect(order).toEqual([1, 2, 3]);
    expect(fixture.owned()).toBe(false);
  });

  it('rejects an unadmitted cohort with the original error without replay or retry', async () => {
    const fixture = admissionFixture(AuthClient);
    await fixture.client.initialize();
    fixture.block();
    const body = vi.fn(async () => 'entered');
    const calls = [
      fixture.client._acquireLock(10000, body),
      fixture.client._acquireLock(10000, body),
    ];
    const outcomes = Promise.allSettled(calls);
    const failure = new DOMException('native admission refused', 'AbortError');
    expect(fixture.pending).toHaveLength(1);
    fixture.pending[0].gate.reject(failure);
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(body).not.toHaveBeenCalled();
    expect(fixture.pending).toHaveLength(1);
    const next = fixture.client._acquireLock(10000, body);
    expect(fixture.pending).toHaveLength(2);
    fixture.pending[1].gate.resolve();
    expect(await next).toBe('entered');
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('keeps zero and different acquisition budgets independent of the positive cohort', async () => {
    const fixture = admissionFixture(AuthClient);
    await fixture.client.initialize();
    fixture.block();
    const callback = vi.fn(async () => 'done');
    const first = fixture.client._acquireLock(10000, callback);
    const cohort = fixture.client._acquireLock(10000, callback);
    const immediate = fixture.client._acquireLock(0, callback);
    const other = fixture.client._acquireLock(20, callback);
    const results = Promise.allSettled([first, cohort, immediate, other]);
    expect(fixture.pending.map((request) => request.timeout)).toEqual([10000, 0, 20]);
    const refusal = new Error('independent request refused');
    fixture.pending[1].gate.reject(refusal);
    fixture.pending[2].gate.resolve();
    expect(await other).toBe('done'); // An independent admitted request cannot drain unadmitted work.
    expect(callback).toHaveBeenCalledTimes(1);
    fixture.pending[0].gate.resolve();
    expect(await results).toEqual([
      { status: 'fulfilled', value: 'done' },
      { status: 'fulfilled', value: 'done' },
      { status: 'rejected', reason: refusal },
      { status: 'fulfilled', value: 'done' },
    ]);
    expect(callback).toHaveBeenCalledTimes(3);
  });
});
