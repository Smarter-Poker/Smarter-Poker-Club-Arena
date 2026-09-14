/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE BOUNDED HTTP CLIENT POOL FOR THE WHOLE PROCESS (2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every Supabase call the engine makes goes through Node's global `fetch`, and
 * Node's fetch goes through ONE process-wide undici `Agent` that nothing here
 * had ever configured. Its defaults, read from the running engine:
 *
 *   connections      : unlimited per origin
 *   keepAliveTimeout : 4 seconds
 *
 * So a socket that has carried a request sits idle for four seconds and is
 * closed, and the next request to the same origin opens a new one: a fresh
 * TCP connect and a full TLS handshake. Measured inside the engine container
 * on 2026-09-14 10:33 UTC, in an ordinary minute: 240 HTTPS connections open
 * to the Supabase API and 1,674 in TIME-WAIT - roughly twenty-eight new TLS
 * sessions a second, all day - and 3,800 in TIME-WAIT during one tournament
 * re-admission storm at 10:07, when every manager asked the database the same
 * question at once and there was no ceiling on how many sockets that could
 * open.
 *
 * Why this is a MEMORY bug and not only a network one. TLS state is allocated
 * by OpenSSL, in native memory, on the main thread, in glibc's main arena -
 * the `[heap]` (brk) region. That arena cannot give a page back to the kernel
 * while anything above it is still in use, so a storm that opens thousands of
 * sessions at once ratchets the arena to its high-water mark and the mark
 * stays. Read on the box the same morning: the V8 heap sat between 400 and
 * 800 MB across GC cycles while the process climbed past 2 GB, and the delta
 * was the arena - 378 MB at boot+60m, 501 MB at boot+90m, +111 MB inside the
 * seven minutes of the 10:07 storm, flat in quiet minutes. The engine host
 * has 3.8 GB, the release train builds the next image on the same host and
 * refuses below 1.125 GiB free, and it was refused 11 of 14 times overnight.
 * On 2026-09-12 06:21:57 UTC the kernel OOM-killed the engine outright.
 *
 * The fix is the ceiling the default never had. This installs one Agent with
 *
 *   connections      : ENGINE_HTTP_MAX_CONNECTIONS   (default 128 per origin)
 *   keepAliveTimeout : ENGINE_HTTP_KEEPALIVE_MS      (default 30 000)
 *
 * The cap bounds how many TLS sessions can exist at once, which bounds the
 * arena's high-water mark; requests past it queue inside undici, in order,
 * and still honour the per-attempt deadline the Supabase client wrapper sets
 * (services/supabase/client.ts). The keep-alive stops the churn: a socket
 * reused thirty seconds later costs nothing, one re-opened four seconds later
 * costs a handshake. Cloudflare, in front of Supabase, sends no
 * `Keep-Alive: timeout=` hint and was measured holding an idle connection
 * open well past this value, so the longer idle is safe on their side; the
 * engine is the side that was closing.
 *
 * WHY THE BUNDLED CONSTRUCTOR AND NOT `import { Agent } from 'undici'`. Node
 * 22 ships undici 6.28 inside the binary and its fetch dispatches through the
 * Dispatcher it finds at `globalThis[Symbol.for('undici.globalDispatcher.1')]`.
 * An npm `undici` would be a second copy with its own version; the handler
 * protocol between fetch and Agent changed across majors, and a fetch from
 * one version driving an Agent from another is the kind of thing that works
 * until the next `npm update`. The default dispatcher IS an Agent, so its
 * constructor is the very class Node's fetch was written against. Same code,
 * same protocol, no new dependency.
 *
 * Node registers that default lazily, the first time its undici module loads
 * (any fetch(), or touching `Headers`). This touches `Headers` first so the
 * slot is populated, then replaces it. undici defines the slot writable, so a
 * plain assignment is the sanctioned `setGlobalDispatcher`.
 *
 * Everything here is reported, not assumed: `httpDispatcherReport()` says
 * whether the bound went in and with what, and /health publishes it as
 * `httpDispatcher`. A boot where it did not go in still runs - on the
 * unbounded default - and says so. Never a silent fall-back (CLAUDE.md 10.86).
 */

export interface HttpDispatcherReport {
  /** True when the global dispatcher is the bounded Agent installed here. */
  bounded: boolean;
  connectionsPerOrigin: number | null;
  keepAliveTimeoutMs: number | null;
  /** Why `bounded` is false, or an env override that was refused; null when clean. */
  reason: string | null;
}

/** undici's own registry key for the process-wide dispatcher (stable since v5). */
export const GLOBAL_DISPATCHER_SYMBOL = Symbol.for('undici.globalDispatcher.1');

export const DEFAULT_MAX_CONNECTIONS_PER_ORIGIN = 128;
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 30_000;

/**
 * An env override is honoured only when it is a positive integer. Anything
 * else - empty, negative, "unlimited", a typo - keeps the default AND is
 * named in the report, because a ceiling that silently vanished is the
 * failure this module exists to end.
 */
export function positiveIntegerFromEnv(
  raw: string | undefined,
  fallback: number
): { value: number; rejected: string | null } {
  if (raw === undefined || raw === '') return { value: fallback, rejected: null };
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return { value: n, rejected: null };
  return { value: fallback, rejected: raw };
}

let report: HttpDispatcherReport = {
  bounded: false,
  connectionsPerOrigin: null,
  keepAliveTimeoutMs: null,
  reason: 'installBoundedHttpDispatcher() has not run',
};

type DispatcherLike = { dispatch?: unknown; constructor?: unknown };

/**
 * Install the bounded Agent as the process-wide dispatcher. Pure with respect
 * to its inputs so it can be exercised against a stand-in global in tests;
 * the production caller passes nothing.
 */
export function installBoundedHttpDispatcher(
  env: Record<string, string | undefined> = process.env,
  g: Record<PropertyKey, unknown> = globalThis as unknown as Record<PropertyKey, unknown>
): HttpDispatcherReport {
  const connections = positiveIntegerFromEnv(
    env.ENGINE_HTTP_MAX_CONNECTIONS,
    DEFAULT_MAX_CONNECTIONS_PER_ORIGIN
  );
  const keepAlive = positiveIntegerFromEnv(
    env.ENGINE_HTTP_KEEPALIVE_MS,
    DEFAULT_KEEPALIVE_TIMEOUT_MS
  );
  const rejected = [
    connections.rejected !== null
      ? `ENGINE_HTTP_MAX_CONNECTIONS=${JSON.stringify(connections.rejected)} is not a positive integer, using ${connections.value}`
      : null,
    keepAlive.rejected !== null
      ? `ENGINE_HTTP_KEEPALIVE_MS=${JSON.stringify(keepAlive.rejected)} is not a positive integer, using ${keepAlive.value}`
      : null,
  ].filter((s): s is string => s !== null);

  const fail = (why: string): HttpDispatcherReport => {
    report = {
      bounded: false,
      connectionsPerOrigin: null,
      keepAliveTimeoutMs: null,
      reason: [why, ...rejected].join('; '),
    };
    return report;
  };

  // Populate the slot: Node creates the default Agent when its bundled undici
  // first loads, and `Headers` is the cheapest thing that loads it.
  try {
    const HeadersCtor = g.Headers as (new () => unknown) | undefined;
    if (typeof HeadersCtor === 'function') void new HeadersCtor();
  } catch {
    /* fall through: the slot check below is the verdict */
  }

  const current = g[GLOBAL_DISPATCHER_SYMBOL] as DispatcherLike | undefined;
  if (!current || typeof current.dispatch !== 'function') {
    return fail('no global undici dispatcher is registered on this runtime');
  }
  const AgentCtor = current.constructor as
    | (new (opts: Record<string, unknown>) => DispatcherLike)
    | undefined;
  if (typeof AgentCtor !== 'function' || AgentCtor.name !== 'Agent') {
    return fail(
      `the default dispatcher is ${
        typeof AgentCtor === 'function' ? AgentCtor.name || '(anonymous)' : typeof AgentCtor
      }, not undici's Agent; refusing to guess its options`
    );
  }

  let agent: DispatcherLike;
  try {
    agent = new AgentCtor({
      connections: connections.value,
      keepAliveTimeout: keepAlive.value,
      // undici clamps keepAliveTimeout to this; keep the ceiling above it.
      keepAliveMaxTimeout: Math.max(keepAlive.value, 600_000),
      pipelining: 1,
    });
  } catch (e) {
    return fail(`Agent construction threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof agent.dispatch !== 'function') {
    return fail('the constructed Agent has no dispatch(); not installing it');
  }

  try {
    g[GLOBAL_DISPATCHER_SYMBOL] = agent;
  } catch (e) {
    return fail(
      `the global dispatcher slot refused assignment: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (g[GLOBAL_DISPATCHER_SYMBOL] !== agent) {
    return fail('the global dispatcher slot did not take the assignment');
  }

  report = {
    bounded: true,
    connectionsPerOrigin: connections.value,
    keepAliveTimeoutMs: keepAlive.value,
    reason: rejected.length ? rejected.join('; ') : null,
  };
  return report;
}

/** The last install's outcome, for /health. */
export function httpDispatcherReport(): HttpDispatcherReport {
  return report;
}
