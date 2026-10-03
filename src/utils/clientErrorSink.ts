/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLIENT ERROR SINK — first-party telemetry from players' browsers (2026-10-03)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Until this existed `reportError` wrote console.error and nothing else, so an
 * error a player hit was seen only if they sent a screenshot. Sentry is retired
 * for good (owner's standing rule, tests/sentry-never-comes-back.law.test.ts);
 * this is the first-party replacement and it talks to ONE place: our own
 * Supabase RPC `fn_report_client_errors`
 * (supabase/migrations/20261003080431_players_errors_reach_a_first_party_sink.sql).
 *
 * THE CONTRACT, because this runs inside error handling:
 *   - it never throws and never blocks: every path is guarded, every send is
 *     fire-and-forget, a failed send is dropped, never retried, never reported;
 *   - it batches: the first event opens a short window and everything in it
 *     goes in one request; on page hide the queue goes with `keepalive`;
 *   - it samples repeats: one event per dedupe key per minute, the rest are
 *     counted and carried as `occurrences` on the next one (or on page hide);
 *   - it is bounded: 30 events a minute and 200 a page session, whatever the
 *     page does. The database enforces its own caps independently;
 *   - it scrubs before anything leaves the browser (emails, tokens, secrets),
 *     and the database scrubs again;
 *   - it sends only for a signed-in player, under their own session; the
 *     database takes user_id from that session, never from the payload.
 *
 * Loaded lazily by errorReporter.ts on the first error, so the entry chunk
 * pays nothing for it.
 */

/** What errorReporter hands over, captured synchronously at the moment of the error. */
export interface ClientErrorCapture {
  at: number;
  route: string;
  code: string;
  name: string | null;
  message: string;
  stack: string | null;
  source: string;
  extra?: unknown;
}

/** The wire shape fn_report_client_errors reads. */
export interface SinkEvent {
  at: number;
  route: string;
  app_version: string | null;
  user_agent: string | null;
  automated: boolean;
  code: string;
  name: string | null;
  message: string;
  stack: string | null;
  source: string;
  context?: Record<string, unknown>;
  dedupe_key: string;
  occurrences: number;
}

export const SINK_LIMITS = {
  message: 500,
  stack: 2000,
  route: 200,
  code: 64,
  name: 64,
  source: 120,
  contextBytes: 2048,
  contextString: 200,
  contextKeys: 20,
  contextArray: 10,
  contextDepth: 3,
  batch: 10,
  perMinute: 30,
  perSession: 200,
  repeatWindowMs: 60_000,
  debounceMs: 2_000,
  maxKeys: 200,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SCRUBBING — the same five rules as public.fn_client_error_scrub
// ─────────────────────────────────────────────────────────────────────────────

const SCRUBBERS: ReadonlyArray<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[jwt]'],
  [/(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [token]'],
  [
    /((?:access_token|refresh_token|id_token|token|apikey|api_key|password|passwd|secret|authorization|key)=)[^&\s"'\\]+/gi,
    '$1[redacted]',
  ],
  // A 32+ character run of token alphabet that contains a digit. UUIDs survive:
  // their hyphens split them into short runs.
  [/(?=[A-Za-z_+/=]*[0-9])[A-Za-z0-9_+/=]{32,}/g, '[token]'],
];

/** Strip emails, JWTs, bearer tokens, secret query values and long opaque tokens; cap the length. */
export function scrubText(text: string, max: number): string {
  let out = String(text).slice(0, max + 256);
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out.slice(0, max);
}

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api_?key|cookie|e-?mail|phone/i;

function walk(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return scrubText(value, SINK_LIMITS.contextString);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= SINK_LIMITS.contextDepth) return '[object]';
  if (Array.isArray(value)) {
    return value.slice(0, SINK_LIMITS.contextArray).map((v) => walk(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (n++ >= SINK_LIMITS.contextKeys) break;
    let v: unknown;
    try {
      v = (value as Record<string, unknown>)[key];
    } catch {
      v = '[unreadable]';
    }
    const safeKey = scrubText(key, 64);
    out[safeKey] = SENSITIVE_KEY.test(key) ? '[redacted]' : walk(v, depth + 1);
  }
  return out;
}

/** A bounded, scrubbed, JSON-safe copy of `extra`, at most 2 KiB serialized. */
export function scrubContext(extra: unknown): Record<string, unknown> | undefined {
  try {
    if (extra === undefined || extra === null) return undefined;
    const walked = walk(typeof extra === 'object' ? extra : { value: extra }, 0);
    if (!walked || typeof walked !== 'object' || Array.isArray(walked)) return undefined;
    const json = JSON.stringify(walked);
    if (
      json.length > SINK_LIMITS.contextBytes ||
      new Blob([json]).size > SINK_LIMITS.contextBytes
    ) {
      return { truncated: true };
    }
    return walked as Record<string, unknown>;
  } catch {
    return { truncated: true };
  }
}

/** FNV-1a, 32-bit. Enough to group repeats; not a security boundary. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function sanitizeCode(code: string): string {
  const cleaned = String(code)
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, SINK_LIMITS.code);
  return cleaned || 'UNKNOWN';
}

/** One key per (code, where, message shape): digits are folded so "seat 3" and "seat 4" group. */
export function dedupeKey(code: string, source: string, message: string): string {
  const shape = message.replace(/\d+/g, '#').slice(0, 200);
  return `${code.slice(0, 40)}:${fnv1a(`${code}|${source}|${shape}`)}`;
}

export interface SinkEnvironment {
  appVersion: string | null;
  userAgent: string | null;
  automated: boolean;
}

/** Normalize, scrub and cap one capture into the wire shape. */
export function toSinkEvent(capture: ClientErrorCapture, environment: SinkEnvironment): SinkEvent {
  const code = sanitizeCode(capture.code);
  const source = String(capture.source)
    .replace(/[^A-Za-z0-9_.:/-]/g, '_')
    .slice(0, SINK_LIMITS.source);
  const message = scrubText(capture.message, SINK_LIMITS.message);
  const event: SinkEvent = {
    at: capture.at,
    route: scrubText(String(capture.route).split(/[?#]/)[0], SINK_LIMITS.route),
    app_version: environment.appVersion ? environment.appVersion.slice(0, 64) : null,
    user_agent: environment.userAgent ? environment.userAgent.slice(0, 256) : null,
    automated: environment.automated,
    code,
    name: capture.name ? sanitizeCode(capture.name).slice(0, SINK_LIMITS.name) : null,
    message,
    stack: capture.stack ? scrubText(capture.stack, SINK_LIMITS.stack) : null,
    source,
    dedupe_key: dedupeKey(code, source, message),
    occurrences: 1,
  };
  const context = scrubContext(capture.extra);
  if (context) event.context = context;
  return event;
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCHING, SAMPLING, RATE LIMIT
// ─────────────────────────────────────────────────────────────────────────────

export interface SinkDeps extends SinkEnvironment {
  send(events: SinkEvent[], keepalive: boolean): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface ClientErrorSink {
  enqueue(capture: ClientErrorCapture): void;
  /** Send everything queued now. `keepalive` = the page is going away. */
  flush(keepalive?: boolean): void;
  stats(): { queued: number; sent: number; dropped: number; suppressed: number };
}

export function createClientErrorSink(deps: SinkDeps): ClientErrorSink {
  const queue: SinkEvent[] = [];
  const seen = new Map<string, { lastSentAt: number; suppressed: number; last: SinkEvent }>();
  const sentAt: number[] = [];
  let sent = 0;
  let dropped = 0;
  let timer: unknown = null;

  const withinRate = (t: number): boolean => {
    while (sentAt.length && t - sentAt[0] >= 60_000) sentAt.shift();
    return sentAt.length < SINK_LIMITS.perMinute && sent < SINK_LIMITS.perSession;
  };
  const admit = (event: SinkEvent, t: number) => {
    sentAt.push(t);
    sent++;
    queue.push(event);
    if (timer === null) {
      timer = deps.setTimer(() => {
        timer = null;
        flush(false);
      }, SINK_LIMITS.debounceMs);
    }
  };

  function enqueue(capture: ClientErrorCapture): void {
    try {
      const t = deps.now();
      const event = toSinkEvent(capture, deps);
      const key = event.dedupe_key;
      const prior = seen.get(key);
      if (prior && t - prior.lastSentAt < SINK_LIMITS.repeatWindowMs) {
        prior.suppressed++;
        prior.last = event;
        return;
      }
      if (!withinRate(t)) {
        // Not lost: counted against its key, carried by the next one sent.
        if (prior) {
          prior.suppressed++;
          prior.last = event;
        } else if (seen.size < SINK_LIMITS.maxKeys) {
          seen.set(key, { lastSentAt: -Infinity, suppressed: 1, last: event });
        } else {
          dropped++;
        }
        return;
      }
      event.occurrences = Math.min(10_000, 1 + (prior?.suppressed ?? 0));
      seen.delete(key); // re-insert so Map order is least-recently-sent first
      seen.set(key, { lastSentAt: t, suppressed: 0, last: event });
      while (seen.size > SINK_LIMITS.maxKeys) {
        const oldest = seen.keys().next().value as string;
        seen.delete(oldest);
      }
      admit(event, t);
    } catch {
      dropped++;
    }
  }

  function flush(keepalive = false): void {
    try {
      if (timer !== null) {
        deps.clearTimer(timer);
        timer = null;
      }
      if (keepalive) {
        // The page is going: carry the counts of repeats that never got a turn.
        const t = deps.now();
        for (const [key, entry] of seen) {
          if (entry.suppressed <= 0) continue;
          if (queue.length >= SINK_LIMITS.batch) break;
          queue.push({
            ...entry.last,
            at: t,
            occurrences: Math.min(10_000, entry.suppressed),
          });
          seen.set(key, { ...entry, suppressed: 0, lastSentAt: t });
        }
        // keepalive bodies share a 64 KiB budget per page: one batch, at most.
        if (queue.length) deps.send(queue.splice(0, SINK_LIMITS.batch), true);
        dropped += queue.length;
        queue.length = 0;
        return;
      }
      while (queue.length) deps.send(queue.splice(0, SINK_LIMITS.batch), false);
    } catch {
      /* best effort */
    }
  }

  return {
    enqueue,
    flush,
    stats: () => ({
      queued: queue.length,
      sent,
      dropped,
      suppressed: [...seen.values()].reduce((n, e) => n + e.suppressed, 0),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER INSTANCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build-time values, each read by its full static name: Vite replaces
 * `import.meta.env.VITE_X` at build time and does not promise a dynamic
 * `import.meta.env[name]` lookup.
 */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function supabaseUrl(): string | null {
  try {
    return nonEmpty(import.meta.env.VITE_SUPABASE_URL);
  } catch {
    return null;
  }
}

function supabaseKey(): string | null {
  try {
    return nonEmpty(import.meta.env.VITE_SUPABASE_ANON_KEY);
  } catch {
    return null;
  }
}

function appVersion(): string | null {
  try {
    return nonEmpty(import.meta.env.VITE_APP_VERSION);
  } catch {
    return null;
  }
}

/**
 * The signed-in player's access token, read straight from the shared SSO
 * storage key, or null when there is none or it has (nearly) expired.
 *
 * Deliberately not authUtils.readLocalSession: this module is also reachable
 * from the standalone Diamond test page, which must not link the account
 * modules (tests/e2e/helpers/diamond-test-fixture.mjs refuses a page that does). The key
 * is the same one (AUTH_STORAGE_KEY, shared with the World Hub).
 */
export function signedInAccessToken(now: number = Date.now()): string | null {
  try {
    const raw = globalThis.localStorage?.getItem('smarter-poker-auth');
    if (!raw) return null;
    const session = JSON.parse(raw) as { access_token?: unknown; expires_at?: unknown };
    const token = session?.access_token;
    if (typeof token !== 'string' || token === '') return null;
    const expiresAt = typeof session.expires_at === 'number' ? session.expires_at * 1000 : null;
    if (expiresAt !== null && expiresAt - now < 30_000) return null;
    return token;
  } catch {
    return null;
  }
}

function sendToSupabase(events: SinkEvent[], keepalive: boolean): void {
  try {
    const base = supabaseUrl();
    const key = supabaseKey();
    if (!base || !key || events.length === 0) return;
    // Signed-in players only: the RPC is not executable by anon (the live
    // definer audit holds anon-executable DEFINER writers at zero), so a
    // signed-out send would only be refused. Every table, buy-in and leave
    // flow is signed in.
    const token = signedInAccessToken();
    if (!token) return;
    void fetch(`${base.replace(/\/+$/, '')}/rest/v1/rpc/fn_report_client_errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ p_events: events }),
      keepalive,
      credentials: 'omit',
    }).catch(() => {
      /* telemetry never reports itself */
    });
  } catch {
    /* telemetry never reports itself */
  }
}

function createBrowserSink(): ClientErrorSink {
  let automated = false;
  let userAgent: string | null = null;
  try {
    automated = globalThis.navigator?.webdriver === true;
    userAgent = globalThis.navigator?.userAgent ?? null;
  } catch {
    /* defaults stand */
  }
  const sink = createClientErrorSink({
    appVersion: appVersion(),
    userAgent,
    automated,
    send: sendToSupabase,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  try {
    window.addEventListener('pagehide', () => sink.flush(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') sink.flush(true);
    });
  } catch {
    /* no page lifecycle: the timer still flushes */
  }
  return sink;
}

export const clientErrorSink: ClientErrorSink = createBrowserSink();
