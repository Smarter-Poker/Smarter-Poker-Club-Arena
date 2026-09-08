/**
 * Supabase service-role client — env config + the one shared `supabase` instance.
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 *
 * Every other `src/services/supabase/*` submodule imports the client from
 * here, and nothing imports back from the barrel — that is what keeps the
 * module graph acyclic.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { reportError } from '../errorReporter.js';
import { dataActorHeaders } from './dataActorContext.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_SERVICE_ROLE_KEY) {
  reportError(
    new Error('[Supabase] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set!'),
    'Supabase.FATAL'
  );
  // Under the test runner the service-role key is intentionally absent (handlers
  // are exercised with mocked Supabase); exiting the process aborts the whole
  // suite. Only hard-exit in a real runtime.
  if (!process.env.VITEST) {
    process.exit(1);
  }
}

// createClient throws if the key is falsy; supply a harmless placeholder under
// the test runner so module import doesn't blow up before mocks are applied.
const EFFECTIVE_SERVICE_ROLE_KEY =
  SUPABASE_SERVICE_ROLE_KEY || (process.env.VITEST ? 'test-placeholder-key' : '');

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE ROLE CLIENT — Full DB access, bypasses RLS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 2026-08-15 FREEZE FIX. There was no fetch timeout anywhere in the server —
 * no AbortController, no Promise.race, nothing. The dealing loop awaits several
 * Supabase calls per hand (loadSeatedPlayers, refreshBlinds, postHandTasks,
 * recoverBustedSeatedHorses), so ONE hung socket stalled that table forever with
 * no error, no retry and nothing to observe. Ten tables dropping out inside a
 * 48-second window on 2026-08-15 is the signature of a degrading shared
 * transport, not ten independent logic bugs.
 *
 * A hard deadline turns a hung request into a rejection the loop's existing
 * catch can back off and retry on.
 */
const DB_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS ?? 15_000);
/* Maintenance boundary writers may legitimately wait behind a guarded entry
 * transaction for up to 30 seconds. They use a dedicated client whose HTTP
 * deadline is longer than the database function's 45-second hard ceiling;
 * widening the ordinary game-data client would let a hung hand stall longer. */
const MAINTENANCE_DB_TIMEOUT_MS = Number(process.env.MAINTENANCE_SUPABASE_TIMEOUT_MS ?? 50_000);

function createBoundedServiceClient(timeoutMs: number): SupabaseClient {
  return createClient(SUPABASE_URL, EFFECTIVE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      /**
       * Two layers here, both load-bearing:
       * 1. Per-attempt hard deadline (2026-08-15 freeze fix above) - a hung
       *    socket becomes a rejection the dealing loop can handle.
       * 2. Pre-execution-503 retry (2026-08-31 PGRST002 outage) - PostgREST
       *    returns 503 with code PGRST001/PGRST002/PGRST003 BEFORE the statement
       *    executes (no connection / schema cache loading / pool acquisition
       *    timed out). Replaying those is safe for any method, including the
       *    dealing RPCs - the statement never ran. Any other 503, non-JSON 503,
       *    or network throw is NOT retried here; the loop's existing catch and
       *    backoff still own those. Retries are short (300ms/1.2s) so worst case
       *    stays inside one dealing tick budget.
       */
      fetch: async (input: any, init: any = {}) => {
        const attemptOnce = async () => {
          const callerSignal: AbortSignal | undefined =
            init.signal ??
            (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
          // Cancellation may precede this attempt, including during retry backoff.
          callerSignal?.throwIfAborted();
          // A Request object's body stream is consumed by fetch - clone per
          // attempt so a retry never replays a consumed stream. (supabase-js
          // passes a URL string + init in practice; this is belt-and-braces.)
          const attemptInput =
            typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(new Error('supabase_timeout')), timeoutMs);
          const onAbort = () => ctl.abort(callerSignal?.reason);
          callerSignal?.addEventListener('abort', onAbort, { once: true });
          const headers = new Headers(
            typeof Request !== 'undefined' && attemptInput instanceof Request
              ? attemptInput.headers
              : undefined
          );
          // Preserve explicit fetch-init overrides, then stamp the immutable
          // actor last.  This is repeated for every retry so neither a mutable
          // Headers object nor a consumed Request can change authority.
          new Headers(init.headers).forEach((value, name) => headers.set(name, value));
          const authoritativeHeaders = dataActorHeaders(headers);
          try {
            const response = await fetch(attemptInput, {
              ...init,
              headers: authoritativeHeaders,
              signal: ctl.signal,
            });
            // fetch resolves when the response headers arrive, while
            // supabase-js still has to consume the body. Drain a clone under
            // the same deadline so a response that stalls mid-body cannot
            // freeze a dealing or ownership loop indefinitely.
            const reader = response.clone().body?.getReader();
            if (reader) {
              try {
                while (!(await reader.read()).done) {
                  /* drain to EOF */
                }
              } finally {
                reader.releaseLock();
              }
            }
            ctl.signal.throwIfAborted();
            return response;
          } finally {
            clearTimeout(t);
            callerSignal?.removeEventListener('abort', onAbort);
          }
        };

        const RETRYABLE = new Set(['PGRST001', 'PGRST002', 'PGRST003']);
        const DELAYS_MS = [300, 1200];
        let attempt = 0;
        for (;;) {
          const resp = await attemptOnce();
          if (resp.status !== 503 || attempt >= DELAYS_MS.length) return resp;
          let code: unknown;
          try {
            code = ((await resp.clone().json()) as { code?: unknown } | null)?.code;
          } catch {
            return resp;
          }
          if (typeof code !== 'string' || !RETRYABLE.has(code)) return resp;
          await new Promise((r) => setTimeout(r, DELAYS_MS[attempt] + Math.random() * 200));
          attempt++;
        }
      },
    },
  });
}

export const supabase: SupabaseClient = createBoundedServiceClient(DB_TIMEOUT_MS);

/** Only the serialized maintenance save/clear RPCs use this longer deadline. */
export const maintenanceSupabase: SupabaseClient =
  createBoundedServiceClient(MAINTENANCE_DB_TIMEOUT_MS);

// ═══════════════════════════════════════════════════════════════════════════════
// REALTIME BROADCASTING — Push hand state to all connected clients
// ═══════════════════════════════════════════════════════════════════════════════

// Channel cache to avoid creating new channels for every broadcast
// Phase 1.1 PR-5 (NO-GO-2): broadcastHandState + channelCache + cleanup*
// deleted. The Supabase Realtime `hand-state:{tableId}` channel is no longer
// the game-state transport — engine WebSocket at /ws/table/:tableId is the
// sole path, served by TableStateHub in server/src/transport/.
