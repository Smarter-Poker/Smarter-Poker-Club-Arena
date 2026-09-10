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
import { bindRealtimeCallbacksToRegistration } from './realtimeCallbackContext.js';
import { observeFenceInResponse } from './tournamentManagerFence.js';

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
/* The host once carried SUPABASE_TIMEOUT_MS=60000 as a temporary response to
 * an upstream incident.  That incident is over, but a host override is not
 * allowed to turn one lost acknowledgement into a minute-long table freeze.
 * Invalid values also fail to the safe ceiling instead of becoming an
 * effectively unbounded timer. */
const requestedDbTimeoutMs = Number(process.env.SUPABASE_TIMEOUT_MS ?? 15_000);
const DB_TIMEOUT_MS =
  Number.isFinite(requestedDbTimeoutMs) && requestedDbTimeoutMs > 0
    ? Math.min(requestedDbTimeoutMs, 15_000)
    : 15_000;
/* Maintenance ownership work participates in the process shutdown certificate.
 * Its database functions have a six-second ceiling and this transport has an
 * eight-second ceiling, leaving over thirty seconds inside the app's 40-second
 * hard exit. The :53 declaration retries at the protocol layer while tables
 * remain gated; an individual HTTP request must never outlive its process. */
const requestedMaintenanceTimeoutMs = Number(process.env.MAINTENANCE_SUPABASE_TIMEOUT_MS ?? 8_000);
const MAINTENANCE_DB_TIMEOUT_MS =
  Number.isFinite(requestedMaintenanceTimeoutMs) && requestedMaintenanceTimeoutMs > 0
    ? Math.min(requestedMaintenanceTimeoutMs, 8_000)
    : 8_000;

function createBoundedServiceClient(timeoutMs: number, maxPreExecutionRetries = 2): SupabaseClient {
  const client = createClient(SUPABASE_URL, EFFECTIVE_SERVICE_ROLE_KEY, {
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
          let rejectBoundary!: (reason: unknown) => void;
          const boundary = new Promise<never>((_resolve, reject) => {
            rejectBoundary = reject;
          });
          const timeoutError = new Error('supabase_timeout');
          const t = setTimeout(() => {
            /* Abort asks the transport and its response stream to stop.  The
             * explicit rejection is separate and essential: an undici/socket
             * continuation is allowed to be broken enough that it never
             * acknowledges AbortSignal.  Production proved that shape when
             * PostgreSQL completed a hand obligation while the engine kept
             * awaiting its HTTP promise for hours. */
            ctl.abort(timeoutError);
            rejectBoundary(timeoutError);
          }, timeoutMs);
          const onAbort = () => {
            const reason = callerSignal?.reason ?? new Error('supabase_cancelled');
            ctl.abort(reason);
            rejectBoundary(reason);
          };
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
          const transport = (async (): Promise<Response> => {
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
          })();
          try {
            /* Never depend on the transport honoring abort in order to settle
             * the application promise. Promise.race installs rejection
             * handlers on both inputs, so a late transport failure is owned. */
            return await Promise.race([transport, boundary]);
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
          // A fenced manager generation stands down at the boundary that saw
          // the fence (tournamentManagerFence.ts). The response itself is
          // still returned so the caller's own error handling runs once.
          if (resp.status === 403) await observeFenceInResponse(resp);
          if (
            resp.status !== 503 ||
            attempt >= DELAYS_MS.length ||
            attempt >= maxPreExecutionRetries
          )
            return resp;
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
  return bindRealtimeCallbacksToRegistration(client);
}

export const supabase: SupabaseClient = createBoundedServiceClient(DB_TIMEOUT_MS);

/**
 * Maintenance owns its retries and exact receipt recovery. Disabling the
 * transport's hidden 503 replay makes eight seconds the ceiling for one
 * ownership operation rather than eight seconds per invisible attempt.
 */
export const maintenanceSupabase: SupabaseClient = createBoundedServiceClient(
  MAINTENANCE_DB_TIMEOUT_MS,
  0
);

// ═══════════════════════════════════════════════════════════════════════════════
// REALTIME BROADCASTING — Push hand state to all connected clients
// ═══════════════════════════════════════════════════════════════════════════════

// Channel cache to avoid creating new channels for every broadcast
// Phase 1.1 PR-5 (NO-GO-2): broadcastHandState + channelCache + cleanup*
// deleted. The Supabase Realtime `hand-state:{tableId}` channel is no longer
// the game-state transport — engine WebSocket at /ws/table/:tableId is the
// sole path, served by TableStateHub in server/src/transport/.
