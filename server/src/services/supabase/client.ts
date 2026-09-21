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

import { resolveClientTimeoutMs } from '../cashAccountingBatchBudget.js';
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
const DB_TIMEOUT_MS = resolveClientTimeoutMs();
/* Maintenance boundary writers may legitimately wait behind a guarded entry
 * transaction for up to 30 seconds. They use a dedicated client whose HTTP
 * deadline is longer than the database function's 45-second hard ceiling;
 * widening the ordinary game-data client would let a hung hand stall longer. */
const MAINTENANCE_DB_TIMEOUT_MS = Number(process.env.MAINTENANCE_SUPABASE_TIMEOUT_MS ?? 50_000);
/* The horse fleet's SEEDING calls get their own, much shorter deadline.
 *
 * The 15-second default above is right for a hand in progress, where giving up
 * on a write is worse than waiting. Seeding is the opposite: a horse that
 * cannot take a seat in a few seconds simply takes one on the next cycle, and
 * nothing is lost by saying so early.
 *
 * Measured 2026-09-11. An uncontended atomic_table_buyin, timed in a
 * self-aborting probe against production, is 132 ms. Its recorded mean across
 * 9,767 calls in 44 hours is 1,336 ms with a 27.3-second maximum, so the
 * middle is fast and the tail is very long. The seeding loop is sequential by
 * construction - each seat updates the exposure and per-host body counts the
 * NEXT decision reads - so one call in that tail stalls every table behind it.
 * A single cycle on 2026-09-11 spent 33 of its 109 seconds on five buy-ins
 * that timed out 5.8 to 11.7 seconds apart, one after another.
 *
 * 5 seconds is 38x the uncontended cost. A call slower than that is abandoned,
 * the chair is freed, and the loop moves on - which is the path the code
 * already takes for a refused buy-in. Nothing is at risk that was not already:
 * the 15-second deadline abandoned the same way, less often, and a seat that
 * committed after the client gave up is read back as taken on the next cycle.
 */
const SEEDING_DB_TIMEOUT_MS = Number(process.env.SEEDING_SUPABASE_TIMEOUT_MS ?? 5_000);

function preserveResponseMetadata(buffered: Response, original: Response): Response {
  const clone = buffered.clone.bind(buffered);
  Object.defineProperties(buffered, {
    url: { value: original.url },
    redirected: { value: original.redirected },
    type: { value: original.type },
    clone: { value: () => preserveResponseMetadata(clone(), original) },
  });
  return buffered;
}

function createBoundedServiceClient(timeoutMs: number): SupabaseClient {
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
          const refuse = (reason: unknown) => {
            rejectBoundary(reason);
            ctl.abort(reason);
          };
          const t = setTimeout(() => refuse(new Error('supabase_timeout')), timeoutMs);
          const onAbort = () => refuse(callerSignal!.reason);
          try {
            callerSignal?.addEventListener('abort', onAbort, { once: true });
            callerSignal?.throwIfAborted();
            const operation = (async () => {
              const headers = new Headers(
                typeof Request !== 'undefined' && attemptInput instanceof Request
                  ? attemptInput.headers
                  : undefined
              );
              // Preserve caller headers, then stamp the immutable actor last.
              new Headers(init.headers).forEach((value, name) => headers.set(name, value));
              const authoritativeHeaders = dataActorHeaders(headers);
              const response = await fetch(attemptInput, {
                ...init,
                headers: authoritativeHeaders,
                signal: ctl.signal,
              });
              if (ctl.signal.aborted) {
                // Late completion cannot become success or start a replay.
                void response.body?.cancel(ctl.signal.reason).catch(() => {});
                ctl.signal.throwIfAborted();
              }
              // Consume the actual body under the deadline. Returning its
              // buffered bytes keeps later SDK decoding off the network stream.
              const bytes = response.body === null ? null : await response.arrayBuffer();
              ctl.signal.throwIfAborted();
              if (bytes === null) return response;
              return preserveResponseMetadata(
                new Response(bytes, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                }),
                response
              );
            })();
            // Abort is cooperative; reject independently if transport stalls.
            // The race observes late failures without replaying ambiguous writes.
            return await Promise.race([operation, boundary]);
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
  return bindRealtimeCallbacksToRegistration(client);
}

export const supabase: SupabaseClient = createBoundedServiceClient(DB_TIMEOUT_MS);

/** Only the serialized maintenance save/clear RPCs use this longer deadline. */
export const maintenanceSupabase: SupabaseClient =
  createBoundedServiceClient(MAINTENANCE_DB_TIMEOUT_MS);

/* The horse fleet's seat-purchase client. See SEEDING_DB_TIMEOUT_MS. */
export const seedingSupabase: SupabaseClient = createBoundedServiceClient(SEEDING_DB_TIMEOUT_MS);
/* Exported so callers can DERIVE their batch sizes from the budget that
   actually binds them, instead of writing a literal that cannot notice
   when its own per-item cost changes. See cashAccountingBatchBudget.ts. */
export { DB_TIMEOUT_MS };
export { SEEDING_DB_TIMEOUT_MS };

// ═══════════════════════════════════════════════════════════════════════════════
// REALTIME BROADCASTING — Push hand state to all connected clients
// ═══════════════════════════════════════════════════════════════════════════════

// Channel cache to avoid creating new channels for every broadcast
// Phase 1.1 PR-5 (NO-GO-2): broadcastHandState + channelCache + cleanup*
// deleted. The Supabase Realtime `hand-state:{tableId}` channel is no longer
// the game-state transport — engine WebSocket at /ws/table/:tableId is the
// sole path, served by TableStateHub in server/src/transport/.
