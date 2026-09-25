/**
 * BOUNDED HTTP CONNECTIONS IN THE MAIN ENGINE ISOLATE (2026-09-14)
 *
 * The incident report recorded the default fetch Agent with no per-origin
 * connection cap and a four-second keep-alive. In one network-namespace sample
 * it counted 240 established HTTPS connections and 1,674 TIME-WAIT sockets;
 * a tournament re-admission storm had 3,800 TIME-WAIT sockets. These observations
 * indicate connection churn. A TIME-WAIT snapshot alone does not measure the
 * TLS handshake rate or establish that every request opened a new connection.
 *
 * Reported process RSS rose while the main isolate's V8 heap remained in a
 * 400-800 MB band, and the [heap] region grew around the storm. TLS allocation
 * and allocator fragmentation are plausible contributors, not established causes.
 * The virtual extent of [heap] is not resident memory or allocation ownership.
 * A connection ceiling does not establish a ceiling on native RSS or queued
 * request memory; assess workload, worker heaps, connection churn and RSS
 * across comparable post-release periods before attributing an improvement.
 *
 * This installs one Agent with connections=128 per origin and a 30-second
 * keep-alive, overridable by ENGINE_HTTP_MAX_CONNECTIONS / ENGINE_HTTP_KEEPALIVE_MS.
 * Excess requests queue in undici; the Supabase wrapper's per-attempt deadline
 * covers that wait and the response-body drain. Other fetch callers retain their
 * own cancellation contracts. Worker isolates and other origins have separate
 * pools; this is not a whole-process connection or memory ceiling.
 *
 * The constructor comes from the runtime's existing Agent to avoid mixing fetch
 * and dispatcher versions. The registry symbol and constructor name are runtime
 * implementation details: validate actual fetch behavior in the pinned Node image.
 * Touching Headers initializes the lazy default; the writable registry slot is
 * then replaced. A different constructor or failed assignment is reported and
 * leaves the existing dispatcher in place. Installation is the first index import.
 *
 * httpDispatcherReport() records the install result. It is not a live socket
 * count, memory proof, or guarantee against a later dispatcher replacement.
 */

export interface HttpDispatcherReport {
  /** True when the last installation successfully selected the bounded Agent. */
  bounded: boolean;
  connectionsPerOrigin: number | null;
  keepAliveTimeoutMs: number | null;
  /** Why `bounded` is false, or an env override that was refused; null when clean. */
  reason: string | null;
}

/** Dispatcher registry key used by the pinned Node/undici runtime. */
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
