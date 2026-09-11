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
  await import('./client.js');
  expect(captured.fetches).toHaveLength(2);
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

/** A broken transport that ignores AbortSignal entirely. */
function abortDeafBody(status = 200) {
  return vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            // Deliberately never close, error, or listen for abort.
          },
        }),
        { status }
      )
  );
}

const ordinaryDatabaseFetch = (): typeof fetch => {
  const boundedFetch = captured.fetches[0];
  if (!boundedFetch) throw new Error('ordinary database client fetch was not captured');
  return boundedFetch;
};

const maintenanceDatabaseFetch = (): typeof fetch => {
  const boundedFetch = captured.fetches[1];
  if (!boundedFetch) throw new Error('maintenance database client fetch was not captured');
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

  it('rejects at the application boundary when the transport ignores abort', async () => {
    const transport = abortDeafBody();
    vi.stubGlobal('fetch', transport);
    const outcome = ordinaryDatabaseFetch()('https://example.test/rpc', {
      method: 'POST',
    }).then(
      () => 'unexpected success',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(await outcome).toBe('supabase_timeout');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects when fetch itself never resolves or observes abort', async () => {
    const transport = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', transport);
    const outcome = ordinaryDatabaseFetch()('https://example.test/rpc', {
      method: 'POST',
    }).then(
      () => 'unexpected success',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(await outcome).toBe('supabase_timeout');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns a late transport rejection after the application deadline wins', async () => {
    let rejectTransport!: (reason: unknown) => void;
    const transport = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectTransport = reject;
        })
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      vi.stubGlobal('fetch', transport);
      const outcome = ordinaryDatabaseFetch()('https://example.test/rpc').then(
        () => 'unexpected success',
        (error: Error) => error.message
      );
      await vi.advanceTimersByTimeAsync(101);
      expect(await outcome).toBe('supabase_timeout');
      rejectTransport(new Error('late_transport_failure'));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('caps the stale production override at fifteen seconds', async () => {
    vi.resetModules();
    captured.fetches.length = 0;
    vi.stubEnv('SUPABASE_TIMEOUT_MS', '60000');
    await import('./client.js');
    expect(captured.fetches).toHaveLength(2);

    const transport = abortDeafBody();
    vi.stubGlobal('fetch', transport);
    const outcome = ordinaryDatabaseFetch()('https://example.test/rpc').then(
      () => 'unexpected success',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(15_001);
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

  it('settles immediately when a caller cancels an abort-deaf request', async () => {
    const transport = abortDeafBody();
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const outcome = ordinaryDatabaseFetch()('https://example.test', {
      signal: controller.signal,
    }).then(
      () => 'unexpected success',
      (error: Error) => error.message
    );
    controller.abort(new Error('caller_cancelled_midflight'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe('caller_cancelled_midflight');
    expect(transport).toHaveBeenCalledTimes(1);
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

describe('maintenance ownership transport', () => {
  it('never hides a second mutation attempt behind a pre-execution 503', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response('{"code":"PGRST002"}', { status: 503 }));
    vi.stubGlobal('fetch', transport);

    const response = await maintenanceDatabaseFetch()('https://example.test/rpc', {
      method: 'POST',
      body: '{}',
    });

    expect(response.status).toBe(503);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps even an unsafe environment override at eight seconds', async () => {
    vi.resetModules();
    captured.fetches.length = 0;
    vi.stubEnv('MAINTENANCE_SUPABASE_TIMEOUT_MS', '60000');
    await import('./client.js');
    expect(captured.fetches).toHaveLength(2);

    const transport = stalledBody();
    vi.stubGlobal('fetch', transport);
    const outcome = maintenanceDatabaseFetch()('https://example.test/rpc', {
      method: 'POST',
    }).then(
      () => 'unexpected success',
      (error: Error) => error.message
    );

    await vi.advanceTimersByTimeAsync(8_001);
    expect(await outcome).toBe('supabase_timeout');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
