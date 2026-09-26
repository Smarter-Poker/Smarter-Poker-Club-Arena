import { createServer } from 'node:http';
const nativeFetch = globalThis.fetch;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ fetches: [] as Array<typeof fetch> }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: { global: { fetch: typeof fetch } }) => {
    captured.fetches.push(options.global.fetch);
    return {};
  },
}));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  captured.fetches.length = 0;
  vi.stubEnv('SUPABASE_TIMEOUT_MS', '100');
  vi.stubEnv('MAINTENANCE_SUPABASE_TIMEOUT_MS', '100');
  vi.stubEnv('SEEDING_SUPABASE_TIMEOUT_MS', '100');
  await import('./client.js');
  /* Every bounded client this module builds, in construction order:
       0 supabase          - the ordinary game-data client (SUPABASE_TIMEOUT_MS)
       1 maintenanceSupabase - longer, for serialized maintenance writes
       2 seedingSupabase     - SHORTER, so a slow seat purchase cannot stall a
                               horse-fleet seeding cycle (added 2026-09-11)
       3 accountingPeriodSupabase - LONGER, derived from the 300 s server
                               budget of fn_rakeback_recompute_periods, so a
                               committed week is never reported as a timeout
                               (added 2026-09-26; asserted separately below)
     The count is asserted because every one of them shares the fetch wrapper
     under test: a new client added without a thought about its deadline shows
     up here rather than in production. boundedFetch below is index 0. */
  expect(captured.fetches).toHaveLength(4);
});

describe('the period recompute client outlives its server budget', () => {
  it('keeps waiting past the hand deadline and gives up only after the server budget', async () => {
    const { periodRecomputeClientTimeoutMs, PERIOD_RECOMPUTE_SERVER_BUDGET_MS } =
      await import('../cashAccountingBatchBudget.js');
    let release!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
    );
    let outcome = 'pending';
    const pending = captured.fetches[3]('https://example.test/rpc', { method: 'POST' }).then(
      () => {
        outcome = 'success';
      },
      (error: Error) => {
        outcome = error.message;
      }
    );
    try {
      await vi.advanceTimersByTimeAsync(PERIOD_RECOMPUTE_SERVER_BUDGET_MS);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(
        periodRecomputeClientTimeoutMs() - PERIOD_RECOMPUTE_SERVER_BUDGET_MS + 1
      );
      expect(outcome).toBe('supabase_timeout');
    } finally {
      release(new Response('{}', { status: 200 }));
      await pending;
    }
  });
});

describe.each([0, 1, 2])('client %i independently owns its response deadline', (clientIndex) => {
  it.each([200, 503])(
    'rejects an uncooperative fetch and never replays its late %i',
    async (status) => {
      let release!: (response: Response) => void;
      let signal!: AbortSignal;
      const transport = vi.fn((_input: unknown, init: RequestInit) => {
        signal = init.signal!;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      vi.stubGlobal('fetch', transport);
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, 'removeEventListener');
      let outcome = 'pending';
      const pending = captured.fetches[clientIndex]('https://example.test/rpc', {
        method: 'POST',
        signal: caller.signal,
      }).then(
        () => {
          outcome = 'success';
        },
        (error: Error) => {
          outcome = error.message;
        }
      );
      try {
        await vi.advanceTimersByTimeAsync(101);
        expect(outcome).toBe('supabase_timeout');
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      } finally {
        release(new Response(status === 503 ? '{"code":"PGRST002"}' : '{}', { status }));
        await pending;
        await vi.advanceTimersByTimeAsync(1600);
      }
      expect(outcome).toBe('supabase_timeout');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects a real response stream even when it ignores abort', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    const transport = vi.fn(async (_input: unknown, init: RequestInit) => {
      signal = init.signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            controller.enqueue(new TextEncoder().encode('{'));
          },
        })
      );
    });
    vi.stubGlobal('fetch', transport);
    let outcome = 'pending';
    const pending = captured.fetches[clientIndex]('https://example.test/rpc', {
      method: 'POST',
    }).then(
      () => {
        outcome = 'success';
      },
      (error: Error) => {
        outcome = error.message;
      }
    );
    try {
      await vi.advanceTimersByTimeAsync(101);
      expect(outcome).toBe('supabase_timeout');
      expect(signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.enqueue(new TextEncoder().encode('}'));
      body.close();
      await pending;
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('honours caller cancellation even when fetch ignores its signal', async () => {
    let release!: (response: Response) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal('fetch', transport);
    const caller = new AbortController();
    const reason = new Error('owner_cancelled');
    let observed: unknown;
    const pending = captured.fetches[clientIndex]('https://example.test/rpc', {
      signal: caller.signal,
    }).catch((error: unknown) => {
      observed = error;
    });
    try {
      caller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release(new Response('{}'));
      await pending;
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('SDK response consumption stays inside the transport boundary', () => {
  it('gives the actual SDK buffered bytes and preserves its response metadata', async () => {
    const original = new Response('[{"id":1}]', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-range': '0-0/1' },
    });
    const originalText = vi.spyOn(original, 'text').mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(original));
    const actual =
      await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    const client = actual.createClient('https://example.test', 'test-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: captured.fetches[0] },
    });
    const result = await client.from('deadline_probe').select('id', { count: 'exact' });
    expect(result).toMatchObject({
      data: [{ id: 1 }],
      count: 1,
      status: 200,
      statusText: 'OK',
      error: null,
    });
    expect(originalText).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves URL, redirect and type metadata through readable clones', async () => {
    const original = new Response('{"ok":true}', { headers: { 'x-test': 'preserved' } });
    Object.defineProperties(original, {
      url: { value: 'https://example.test/final' },
      redirected: { value: true },
      type: { value: 'basic' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(original));
    const response = await captured.fetches[0]('https://example.test/start');
    const clone = response.clone();
    for (const item of [response, clone]) {
      expect(item.url).toBe(original.url);
      expect(item.redirected).toBe(true);
      expect(item.type).toBe('basic');
      expect(item.headers.get('x-test')).toBe('preserved');
      expect(await item.json()).toEqual({ ok: true });
    }
    expect(() => response.clone()).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stalledBody(status = 200) {
  return vi.fn(async (_input: unknown, init: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), {
          once: true,
        });
      },
    });
    return new Response(stream, { status });
  });
}

const ordinaryDatabaseFetch = (): typeof fetch => {
  const boundedFetch = captured.fetches[0];
  if (!boundedFetch) throw new Error('ordinary database client fetch was not captured');
  return boundedFetch;
};

describe('database deadline includes response body and caller cancellation', () => {
  it.each([200, 503])('aborts a stalled %s body without replaying a mutation', async (status) => {
    const transport = stalledBody(status);
    vi.stubGlobal('fetch', transport);
    const outcome = ordinaryDatabaseFetch()('https://example.test/rpc', { method: 'POST' }).then(
      () => 'unexpected success',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(await outcome).toBe('supabase_timeout');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends at the deadline even when the transport ignores its abort', async () => {
    /* THE DEADLINE IS THE DEADLINE (2026-09-16). The abort is cooperative;
       the boundary promise is what makes the deadline real. Production
       170e6a2a, on a build whose wrapper relied on the abort alone: an rpc for
       a hand the database had committed at 14:43:58Z stayed unsettled for
       three hours and forty minutes, holding that table's settlement
       barrier, its manager's stop() and a tournament scheduler slot. A
       transport that never settles must not be able to do that again. */
    const transport = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', transport);
    const outcome = ordinaryDatabaseFetch()('https://example.test/rpc', { method: 'POST' }).then(
      () => 'unexpected success',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await outcome).toBe('supabase_timeout');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send an already cancelled request', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    controller.abort(new Error('caller_cancelled'));
    await expect(
      ordinaryDatabaseFetch()('https://example.test', { signal: controller.signal })
    ).rejects.toThrow('caller_cancelled');
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours cancellation supplied on a Request object', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const request = new Request('https://example.test', { signal: controller.signal });
    controller.abort(new Error('request_cancelled'));
    await expect(ordinaryDatabaseFetch()(request)).rejects.toThrow('request_cancelled');
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns readable data and releases its caller listener after completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"ok":true}', { headers: { 'x-test': 'preserved' } }))
    );
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const response = await ordinaryDatabaseFetch()('https://example.test', {
      signal: controller.signal,
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('x-test')).toBe('preserved');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('database transport compatibility', () => {
  it('retries only a proven pre-execution rejection and keeps the response readable', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"code":"PGRST002"}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', transport);
    const pending = ordinaryDatabaseFetch()('https://example.test/rpc', {
      method: 'POST',
      body: '{}',
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(await (await pending).json()).toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous write failure', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('lost acknowledgement'));
    vi.stubGlobal('fetch', transport);
    await expect(
      ordinaryDatabaseFetch()('https://example.test/rpc', { method: 'POST' })
    ).rejects.toThrow('lost acknowledgement');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a bodyless success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const response = await ordinaryDatabaseFetch()('https://example.test');
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a real SDK query whose HTTP body stops after headers', async () => {
    vi.useRealTimers();

    /* A REAL SOCKET NEEDS MORE THAN 100ms OF HEADROOM (2026-09-08).
       Every other test in this file drives the wrapper with fake timers, so
       the 100ms deadline from beforeEach costs nothing. This one is real: a
       real loopback server, a real connect, real time. On 2026-09-08 it failed
       CI with `expected +0 to be 1` - the server's handler had never run,
       because the 100ms deadline fired before Node finished connecting to
       127.0.0.1 on a box with 33 of 33 runners busy and 30 jobs queued.

       Re-importing with a 2s deadline removes the race without touching what
       is being proved: the body below still never completes, so the deadline
       still fires and still produces the error asserted at the end. The
       `requests` count stays a real assertion - it is what separates "the
       deadline bounded a request that was SENT and stalled" from "the request
       was cancelled before it left", which the test above this one covers. */
    vi.resetModules();
    vi.stubEnv('SUPABASE_TIMEOUT_MS', '2000');
    // Select the newly configured wrapper, not beforeEach's 100ms capture.
    captured.fetches.length = 0;
    await import('./client.js');

    vi.stubGlobal('fetch', nativeFetch);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('['); // Deliberately never finish the body.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const actual =
        await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
      const client = actual.createClient(`http://127.0.0.1:${address.port}`, 'test-key', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: ordinaryDatabaseFetch() },
      });
      const { data, error } = await client.from('deadline_probe').select('id');
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
