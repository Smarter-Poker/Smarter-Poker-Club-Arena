import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_DISPATCHER_SYMBOL, installBoundedHttpDispatcher } from '../httpDispatcher.js';

const nativeFetch = globalThis.fetch;
const captured = vi.hoisted(() => ({ fetches: [] as Array<typeof fetch> }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: { global: { fetch: typeof fetch } }) => {
    captured.fetches.push(options.global.fetch);
    return {};
  },
}));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the database deadline includes waiting for a real HTTP connection', () => {
  it.each(['attempt deadline', 'caller cancellation'])(
    '%s removes a queued mutation before it can reach the origin',
    async (mode) => {
      vi.resetModules();
      captured.fetches.length = 0;
      vi.stubEnv('SUPABASE_TIMEOUT_MS', '2000');
      vi.stubGlobal('fetch', nativeFetch);
      await import('./client.js');
      expect(captured.fetches).toHaveLength(3);
      const boundedFetch = captured.fetches[0];

      void new Headers();
      const registry = globalThis as unknown as Record<PropertyKey, unknown>;
      const previous = registry[GLOBAL_DISPATCHER_SYMBOL];
      const installed = installBoundedHttpDispatcher({ ENGINE_HTTP_MAX_CONNECTIONS: '1' });
      expect(installed.bounded, installed.reason ?? '').toBe(true);
      const dispatcher = registry[GLOBAL_DISPATCHER_SYMBOL] as { destroy: () => Promise<void> };
      const holdAbort = new AbortController();
      let heldResponse: ServerResponse | undefined;
      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const methods: string[] = [];
      const server = createServer((request, response) => {
        methods.push(request.method ?? 'unknown');
        if (request.url === '/hold') {
          heldResponse = response;
          signalHeld();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
      let holdOutcome: Promise<unknown> | undefined;
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('loopback origin has no port');
        const base = `http://127.0.0.1:${address.port}`;
        holdOutcome = nativeFetch(`${base}/hold`, { signal: holdAbort.signal })
          .then((response) => response.text())
          .catch((error: unknown) => error);
        await held;

        let signalQueued!: () => void;
        const queued = new Promise<void>((resolve) => {
          signalQueued = resolve;
        });
        const actual =
          await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
        const client = actual.createClient(base, 'test-key', {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) => {
              const result = boundedFetch(input, init);
              signalQueued();
              return result;
            },
          },
        });
        const caller = new AbortController();
        const outcome = Promise.resolve(
          client.rpc('queued_mutation', { value: 1 }).abortSignal(caller.signal)
        );
        await queued;
        expect(methods).toEqual(['GET']);
        if (mode === 'caller cancellation') caller.abort(new Error('queued_caller_cancelled'));
        const { error } = await outcome;
        expect(error).not.toBeNull();
        expect(error?.message).toContain(
          mode === 'caller cancellation' ? 'queued_caller_cancelled' : 'supabase_timeout'
        );

        // Give the same pool its connection back, then drain a later request.
        // The rejected POST must remain absent even after it could have run.
        heldResponse!.end('released');
        await holdOutcome;
        expect(await (await nativeFetch(`${base}/after`)).json()).toEqual({});
        expect(methods).toEqual(['GET', 'GET']);
      } finally {
        holdAbort.abort();
        server.closeAllConnections();
        await holdOutcome;
        try {
          await dispatcher.destroy();
        } finally {
          registry[GLOBAL_DISPATCHER_SYMBOL] = previous;
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    },
    15000
  );
});
