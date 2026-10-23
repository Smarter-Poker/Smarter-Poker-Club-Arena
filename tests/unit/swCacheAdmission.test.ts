import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('public/sw-bus.js', 'utf8');
const origin = 'https://arena.invalid';
const never = () => new Promise<never>(() => {});
const fresh = () => new Response('cached', { headers: { date: new Date().toUTCString() } });
function fixture(overrides: Record<string, any> = {}) {
  let handler: (event: any) => void;
  const cache = {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    ...overrides.cache,
  };
  const caches = { open: vi.fn(async () => cache), ...overrides.caches };
  const fetch = overrides.fetch ?? vi.fn(async () => new Response('network'));
  const requestConstructor = vi.fn(function (input: Request, init: RequestInit) {
    return new Request(input, init);
  });
  runInNewContext(source, {
    self: {
      location: { origin },
      addEventListener: (name: string, callback: any) => {
        if (name === 'fetch') handler = callback;
      },
      clients: { matchAll: async () => [] },
    },
    caches,
    fetch,
    URL,
    Request: requestConstructor,
    Response,
    Date,
    setTimeout,
    clearTimeout,
  });
  const request = (path: string) => {
    const background: Promise<unknown>[] = [];
    let response!: Promise<Response>;
    const req = new Request(origin + path);
    if (path === '/hub/club-arena/table/fixture')
      Object.defineProperty(req, 'destination', { value: 'document' });
    handler!({
      request: req,
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
      waitUntil: (value: Promise<unknown>) => background.push(value),
    });
    return { response, background };
  };
  return { cache, caches, fetch, request, requestConstructor };
}
afterEach(() => vi.useRealTimers());

const assets = ['/hub/club-arena/assets/TablePage-hash-v6.js', '/hub/club-arena/images/felt.png'];

describe.each(assets)('actual worker cache admission: %s', (path) => {
  it.each(['open', 'match'])(
    'falls back to genuine network after stalled %s within the existing 300ms allowance',
    async (operation) => {
      vi.useFakeTimers();
      const f = fixture(
        operation === 'open'
          ? { caches: { open: vi.fn(never) } }
          : { cache: { match: vi.fn(never) } }
      );
      const { response } = f.request(path);
      await vi.advanceTimersByTimeAsync(299);
      expect(f.fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(await (await response).text()).toBe('network');
    }
  );
  it.each(['open', 'match'])('treats rejected %s as unavailable cache', async (operation) => {
    const reject = vi.fn(async () => {
      throw new Error('cache unavailable');
    });
    const f = fixture(
      operation === 'open' ? { caches: { open: reject } } : { cache: { match: reject } }
    );
    const { response } = f.request(path);
    expect(await (await response).text()).toBe('network');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('serves healthy fresh cache without network', async () => {
    const f = fixture({ cache: { match: vi.fn(async () => fresh()) } });
    expect(await (await f.request(path).response).text()).toBe('cached');
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['put', 'keys'])(
    'a rejected cache %s cannot replace the network response or reject background work',
    async (operation) => {
      const f = fixture({
        cache: {
          [operation]: vi.fn(async () => {
            throw new Error('cache write failed');
          }),
        },
      });
      const { response, background } = f.request(path);
      expect(await (await response).text()).toBe('network');
      await expect(Promise.all(background)).resolves.toBeDefined();
    }
  );
  it('a stalled cache write cannot block the real response', async () => {
    const f = fixture({ cache: { put: vi.fn(never) } });
    expect(await (await f.request(path).response).text()).toBe('network');
  });
  it('keeps an uncached offline request an actual error', async () => {
    const f = fixture({
      fetch: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const { response, background } = f.request(path);
    const result = await response;
    expect(result.ok).toBe(false);
    expect(path.endsWith('.png') ? result.type : result.status).toBe(
      path.endsWith('.png') ? 'error' : 503
    );
    await Promise.all(background);
  });
});

it('shares one 300ms allowance across opening and matching rather than granting each a new budget', async () => {
  vi.useFakeTimers();
  const f = fixture({
    caches: {
      open: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ match: never }), 250))),
    },
  });
  const { response } = f.request(assets[0]);
  await vi.advanceTimersByTimeAsync(300);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(await (await response).text()).toBe('network');
});

it('retains stale media offline while attempting genuine revalidation', async () => {
  const cached = new Response('old art', { headers: { date: new Date(0).toUTCString() } });
  const f = fixture({
    cache: { match: vi.fn(async () => cached) },
    fetch: vi.fn(async () => {
      throw new Error('offline');
    }),
  });
  const { response, background } = f.request(assets[1]);
  expect(await (await response).text()).toBe('old art');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  await Promise.all(background);
});

it('shell network response does not wait for a stalled cache write', async () => {
  const f = fixture({ cache: { put: vi.fn(never) } });
  expect(await (await f.request('/hub/club-arena/table/fixture').response).text()).toBe('network');
});

const shell = '/hub/club-arena/table/fixture';
it.each(['open', 'match'])(
  'shell uses genuine network after stalled cache %s',
  async (operation) => {
    vi.useFakeTimers();
    const f = fixture(
      operation === 'open' ? { caches: { open: vi.fn(never) } } : { cache: { match: vi.fn(never) } }
    );
    const { response } = f.request(shell);
    await vi.advanceTimersByTimeAsync(300);
    expect(await (await response).text()).toBe('network');
  }
);
it('cached shell retains the original bounded freshness race against slow network', async () => {
  vi.useFakeTimers();
  const f = fixture({ cache: { match: vi.fn(async () => fresh()) }, fetch: vi.fn(never) });
  const { response } = f.request(shell);
  await vi.advanceTimersByTimeAsync(300);
  expect(await (await response).text()).toBe('cached');
});
it('shell cache write rejection cannot hide a genuine fresh shell', async () => {
  const f = fixture({
    cache: {
      match: vi.fn(async () => fresh()),
      put: vi.fn(async () => {
        throw new Error('cache quota');
      }),
    },
  });
  const { response, background } = f.request(shell);
  expect(await (await response).text()).toBe('network');
  await expect(Promise.all(background)).resolves.toBeDefined();
});
it('shell returns cached offline fallback when there is no cached shell or network', async () => {
  const f = fixture({
    cache: {
      match: vi.fn(async (key) =>
        key === '/hub/club-arena/offline.html' ? new Response('offline page') : undefined
      ),
    },
    fetch: vi.fn(async () => {
      throw new Error('offline');
    }),
  });
  expect(await (await f.request(shell).response).text()).toBe('offline page');
});
it('cached media older than six hours revalidates genuinely and persists in the background', async () => {
  const f = fixture({
    cache: {
      match: vi.fn(
        async () =>
          new Response('old', {
            headers: { date: new Date(Date.now() - 6 * 60 * 60 * 1000 - 1000).toUTCString() },
          })
      ),
    },
  });
  const { response, background } = f.request(assets[1]);
  expect(await (await response).text()).toBe('old');
  await Promise.all(background);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.requestConstructor).toHaveBeenCalledWith(expect.anything(), { cache: 'no-cache' });
  expect(f.cache.put).toHaveBeenCalledTimes(1);
});

it('uses the original shell read if it completes while a failed network request is pending', async () => {
  vi.useFakeTimers();
  const f = fixture({
    cache: {
      match: vi.fn(async (key) => {
        if (key === '/hub/club-arena') {
          return new Promise((resolve) =>
            setTimeout(() => resolve(new Response('saved shell')), 350)
          );
        }
        return new Response('offline page');
      }),
    },
    fetch: vi.fn(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('network lost')), 100))
    ),
  });
  const { response } = f.request(shell);
  await vi.advanceTimersByTimeAsync(400);
  expect(await (await response).text()).toBe('saved shell');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.cache.match).toHaveBeenCalledTimes(1);
});

it('keeps a shell delivered during the offline-cache lookup ahead of the offline document', async () => {
  vi.useFakeTimers();
  const f = fixture({
    cache: {
      match: vi.fn(
        async (key) =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(new Response(key === '/hub/club-arena' ? 'saved shell' : 'offline page')),
              key === '/hub/club-arena' ? 350 : 60
            )
          )
      ),
    },
    fetch: vi.fn(async () => {
      throw new Error('offline');
    }),
  });
  const { response } = f.request(shell);
  await vi.advanceTimersByTimeAsync(360);
  expect(await (await response).text()).toBe('saved shell');
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
