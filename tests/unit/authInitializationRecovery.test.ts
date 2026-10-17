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
