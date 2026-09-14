/**
 * LAW: the engine opens a bounded number of connections, and keeps them.
 *
 * Node's global fetch dispatched every Supabase call through an undici Agent
 * with no connection cap and a four-second keep-alive. Measured on the engine
 * on 2026-09-14: 240 HTTPS connections open and 1,674 in TIME-WAIT in an
 * ordinary minute, 3,800 in TIME-WAIT during one tournament re-admission
 * storm. Each is a TLS session allocated in glibc's main arena on the main
 * thread, and that arena keeps its high-water mark: the process climbed past
 * 2 GB with the V8 heap flat at 400-800 MB, the on-host image build was
 * refused 11 of 14 times overnight for lack of memory, and on 2026-09-12 the
 * kernel OOM-killed the engine. services/httpDispatcher.ts installs the
 * ceiling; this law keeps it installed, first, honest about failure, and
 * effective - the last part measured against a real socket, not a mock.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_KEEPALIVE_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS_PER_ORIGIN,
  GLOBAL_DISPATCHER_SYMBOL,
  httpDispatcherReport,
  installBoundedHttpDispatcher,
  positiveIntegerFromEnv,
} from './httpDispatcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const G = globalThis as unknown as Record<PropertyKey, unknown>;

type Closable = { close?: () => Promise<void> | void };

/** A stand-in for the runtime's default Agent, recording what it was built with. */
function fakeRuntime(opts: { agentName?: string; withDispatch?: boolean } = {}) {
  const built: Array<Record<string, unknown>> = [];
  const dispatch = () => true;
  const AgentCtor = {
    [opts.agentName ?? 'Agent']: class {
      dispatch?: () => boolean;
      constructor(o: Record<string, unknown>) {
        built.push(o);
        if (opts.withDispatch !== false) this.dispatch = dispatch;
      }
    },
  }[opts.agentName ?? 'Agent'];
  const g: Record<PropertyKey, unknown> = {
    Headers: class {},
    [GLOBAL_DISPATCHER_SYMBOL]: new AgentCtor({}),
  };
  return { g, built };
}

describe('the env overrides are integers or they are refused', () => {
  it('accepts a positive integer, refuses everything else by name', () => {
    expect(positiveIntegerFromEnv('64', 128)).toEqual({ value: 64, rejected: null });
    expect(positiveIntegerFromEnv(undefined, 128)).toEqual({ value: 128, rejected: null });
    expect(positiveIntegerFromEnv('', 128)).toEqual({ value: 128, rejected: null });
    for (const bad of ['0', '-5', '1.5', 'unlimited', 'NaN']) {
      const r = positiveIntegerFromEnv(bad, 128);
      expect(r.value, bad).toBe(128);
      expect(r.rejected, bad).toBe(bad);
    }
  });
});

describe('installBoundedHttpDispatcher against a stand-in runtime', () => {
  it('replaces the default Agent with one carrying the ceiling and the keep-alive', () => {
    const { g, built } = fakeRuntime();
    const before = g[GLOBAL_DISPATCHER_SYMBOL];
    const r = installBoundedHttpDispatcher({}, g);
    expect(r).toEqual({
      bounded: true,
      connectionsPerOrigin: DEFAULT_MAX_CONNECTIONS_PER_ORIGIN,
      keepAliveTimeoutMs: DEFAULT_KEEPALIVE_TIMEOUT_MS,
      reason: null,
    });
    expect(g[GLOBAL_DISPATCHER_SYMBOL]).not.toBe(before);
    expect(built.at(-1)).toEqual({
      connections: DEFAULT_MAX_CONNECTIONS_PER_ORIGIN,
      keepAliveTimeout: DEFAULT_KEEPALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: 600_000,
      pipelining: 1,
    });
    expect(httpDispatcherReport()).toBe(r);
  });

  it('honours env overrides and names a refused one instead of dropping the ceiling', () => {
    const { g, built } = fakeRuntime();
    const r = installBoundedHttpDispatcher(
      { ENGINE_HTTP_MAX_CONNECTIONS: '32', ENGINE_HTTP_KEEPALIVE_MS: 'forever' },
      g
    );
    expect(r.bounded).toBe(true);
    expect(r.connectionsPerOrigin).toBe(32);
    expect(r.keepAliveTimeoutMs).toBe(DEFAULT_KEEPALIVE_TIMEOUT_MS);
    expect(r.reason).toContain('ENGINE_HTTP_KEEPALIVE_MS="forever" is not a positive integer');
    expect(built.at(-1)?.connections).toBe(32);
    expect(built.at(-1)?.keepAliveTimeout).toBe(DEFAULT_KEEPALIVE_TIMEOUT_MS);
  });

  it('a keep-alive above ten minutes raises the max alongside it', () => {
    const { g, built } = fakeRuntime();
    installBoundedHttpDispatcher({ ENGINE_HTTP_KEEPALIVE_MS: '900000' }, g);
    expect(built.at(-1)?.keepAliveTimeout).toBe(900_000);
    expect(built.at(-1)?.keepAliveMaxTimeout).toBe(900_000);
  });

  it('says so when there is no dispatcher to bound', () => {
    const g: Record<PropertyKey, unknown> = { Headers: class {} };
    const r = installBoundedHttpDispatcher({}, g);
    expect(r.bounded).toBe(false);
    expect(r.reason).toContain('no global undici dispatcher');
    expect(g[GLOBAL_DISPATCHER_SYMBOL]).toBeUndefined();
  });

  it('refuses to guess the options of a dispatcher that is not undici Agent', () => {
    const { g } = fakeRuntime({ agentName: 'ProxyAgent' });
    const before = g[GLOBAL_DISPATCHER_SYMBOL];
    const r = installBoundedHttpDispatcher({}, g);
    expect(r.bounded).toBe(false);
    expect(r.reason).toContain('ProxyAgent');
    expect(g[GLOBAL_DISPATCHER_SYMBOL]).toBe(before);
  });

  it('does not install an Agent that cannot dispatch', () => {
    const { g } = fakeRuntime({ withDispatch: false });
    // The default in the slot must still look like a dispatcher for the
    // constructor to be trusted; only the newly built one is broken.
    (g[GLOBAL_DISPATCHER_SYMBOL] as { dispatch?: unknown }).dispatch = () => true;
    const before = g[GLOBAL_DISPATCHER_SYMBOL];
    const r = installBoundedHttpDispatcher({}, g);
    expect(r.bounded).toBe(false);
    expect(r.reason).toContain('no dispatch()');
    expect(g[GLOBAL_DISPATCHER_SYMBOL]).toBe(before);
  });
});

describe('on this runtime the bound is real', () => {
  const original = G[GLOBAL_DISPATCHER_SYMBOL];
  const installed: unknown[] = [];
  let server: Server | undefined;

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    for (const a of installed) await (a as Closable).close?.();
    if (original !== undefined) G[GLOBAL_DISPATCHER_SYMBOL] = original;
  });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * A loopback origin that, like Cloudflare in front of Supabase, sends NO
   * `Keep-Alive: timeout=` hint - undici obeys a server hint over its own
   * option, so a Node http server's default `timeout=5` would hide what the
   * option does. keepAliveTimeout=0 on the server suppresses the header and
   * leaves the idle policy entirely to the client, which is the production
   * shape.
   */
  async function listen(
    handler: Parameters<typeof createServer>[1]
  ): Promise<{ base: string; sockets: () => number; peak: () => number }> {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = createServer(handler);
    server.keepAliveTimeout = 0;
    let total = 0;
    let open = 0;
    let peak = 0;
    server.on('connection', (socket) => {
      total++;
      open++;
      peak = Math.max(peak, open);
      socket.on('close', () => open--);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return { base: `http://127.0.0.1:${addr.port}`, sockets: () => total, peak: () => peak };
  }

  it('the runtime default is undici Agent, and fetch keeps working through the bound one', async () => {
    // Should this ever read anything but Agent, the class source is the
    // first thing to want, so it is in the failure message rather than lost.
    void new Headers();
    const ambient = G[GLOBAL_DISPATCHER_SYMBOL] as { constructor?: unknown } | undefined;
    const ambientCtor = ambient?.constructor as { name?: string } | undefined;
    expect(
      ambientCtor?.name,
      `ambient global dispatcher is ${ambientCtor?.name}: ${String(ambientCtor).slice(0, 400)}`
    ).toBe('Agent');
    const r = installBoundedHttpDispatcher({});
    installed.push(G[GLOBAL_DISPATCHER_SYMBOL]);
    expect(r.bounded, r.reason ?? '').toBe(true);
    expect(
      (G[GLOBAL_DISPATCHER_SYMBOL] as { constructor: { name: string } }).constructor.name
    ).toBe('Agent');
    const origin = await listen((_req, res) => res.end('ok'));
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${origin.base}/ping/${i}`);
      expect(await res.text()).toBe('ok');
      // undici hands a finished client back to its pool one tick after the
      // body ends; back-to-back requests can therefore open a second socket
      // once. A gap makes the reuse deterministic.
      await sleep(30);
    }
    expect(origin.sockets(), 'three gapped sequential requests share one socket').toBe(1);
  });

  it('the keep-alive is ours when the origin sends no hint: idle sockets live ENGINE_HTTP_KEEPALIVE_MS', async () => {
    // A deliberately tiny keep-alive: every idle socket is closed before the
    // next request, so each request opens a new one. This is the 4 s default
    // scaled down to test speed, and it is what the engine was doing to
    // Supabase between hands.
    const short = installBoundedHttpDispatcher({ ENGINE_HTTP_KEEPALIVE_MS: '200' });
    installed.push(G[GLOBAL_DISPATCHER_SYMBOL]);
    expect(short.keepAliveTimeoutMs).toBe(200);
    const churn = await listen((_req, res) => res.end('ok'));
    for (let i = 0; i < 3; i++) {
      await (await fetch(`${churn.base}/short/${i}`)).text();
      await sleep(450);
    }
    expect(churn.sockets(), 'a 200 ms keep-alive reopens on every 450 ms gap').toBe(3);

    // The production default: the same gaps, one socket.
    const long = installBoundedHttpDispatcher({});
    installed.push(G[GLOBAL_DISPATCHER_SYMBOL]);
    expect(long.keepAliveTimeoutMs).toBe(DEFAULT_KEEPALIVE_TIMEOUT_MS);
    const kept = await listen((_req, res) => res.end('ok'));
    for (let i = 0; i < 3; i++) {
      await (await fetch(`${kept.base}/long/${i}`)).text();
      await sleep(450);
    }
    expect(kept.sockets(), 'a 30 s keep-alive holds one socket across the same gaps').toBe(1);
  });

  it('the connection cap holds against a real origin: N parallel requests, at most cap sockets', async () => {
    const CAP = 2;
    const r = installBoundedHttpDispatcher({ ENGINE_HTTP_MAX_CONNECTIONS: String(CAP) });
    installed.push(G[GLOBAL_DISPATCHER_SYMBOL]);
    expect(r.connectionsPerOrigin).toBe(CAP);

    const origin = await listen((_req, res) => {
      // Hold every response long enough that the six requests overlap.
      setTimeout(() => res.end('slow'), 60);
    });
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => fetch(`${origin.base}/slow/${i}`).then((x) => x.text()))
    );
    expect(responses).toEqual(Array(6).fill('slow'));
    expect(origin.sockets(), 'sockets opened for six overlapping requests').toBeLessThanOrEqual(
      CAP
    );
    expect(origin.peak()).toBeLessThanOrEqual(CAP);
  });
});

describe('the bound is installed before anything else can fetch', () => {
  it('the installer is the first import of server/src/index.ts', () => {
    const src = readFileSync(resolve(here, '../index.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
    expect(imports.length).toBeGreaterThan(5);
    expect(imports[0]).toBe("import './services/httpDispatcher.install.js';");
  });

  it('the installer calls the install and reports the outcome either way', () => {
    const src = readFileSync(resolve(here, 'httpDispatcher.install.ts'), 'utf8');
    expect(src).toContain('installBoundedHttpDispatcher()');
    expect(src).toContain('NOT bounded');
  });

  it('/health publishes the report, so a boot on the unbounded default is visible', () => {
    const src = readFileSync(resolve(here, '../GameServer.ts'), 'utf8');
    expect(src).toContain('httpDispatcher: httpDispatcherReport()');
  });
});
