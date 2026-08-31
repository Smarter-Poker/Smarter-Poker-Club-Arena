/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PGRST RETRY FETCH — transport-level retry for PostgREST "not executed" 503s
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Added 2026-08-31 during the PGRST002 outage investigation.
 *
 * WHY THIS EXISTS
 * Production intermittently returned HTTP 503 `PGRST002 — Could not query the
 * database for the schema cache` (47,202 of ~793k requests in one hour; 28% of
 * traffic in the worst 5-minute window), failing live seating
 * (`/rest/v1/table_seats`) and dealing (`/rest/v1/rpc/insert_hole_cards`).
 * Root cause was fixed at the DB level (the `authenticator` role's 8s
 * statement_timeout was killing PostgREST's 18-31s schema-cache reload on our
 * 966-relation schema, so every DDL-triggered reload 503'd the API until a
 * retry survived). This wrapper is the defense-in-depth layer: a brief
 * schema-cache reload or pool blip must degrade to added latency, not to a
 * failed seat or an undealt hand.
 *
 * WHY RETRYING HERE IS SAFE — INCLUDING FOR POSTs
 * We retry ONLY responses PostgREST emits BEFORE executing the request:
 *   PGRST001 — could not establish a database connection
 *   PGRST002 — could not load the schema cache (request never planned)
 *   PGRST003 — timed out acquiring a pool connection (request never sent)
 * In all three cases the statement was never run, so replaying an INSERT/RPC
 * cannot double-execute it. Any other 503 (or non-JSON 503 from the gateway)
 * is returned to the caller untouched. Network-level FAILURES (fetch threw:
 * DNS, reset, abort) are retried only for GET/HEAD, where replay is harmless —
 * a thrown POST may or may not have reached the server, so it is NOT replayed.
 *
 * This complements (does not replace) `src/utils/retryFetch.ts`, which is the
 * component-level `{ data, error }` retry helper. This wrapper sits under the
 * supabase-js client via `global.fetch`, so every .from()/.rpc() call in the
 * app — including code that never adopted retryFetch — is covered.
 */

const RETRYABLE_PRE_EXECUTION_CODES = new Set(['PGRST001', 'PGRST002', 'PGRST003']);

/** Backoff before retry attempt N (ms). Total added worst-case latency ~4.5s. */
const RETRY_DELAYS_MS = [300, 1200, 3000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

/**
 * Resume-style entry point for the lazy path: the caller already made the
 * first attempt, got a 503 whose body carries a retryable code, and hands us
 * the request to retry. Lives here so the entry bundle only pays for a
 * ~10-line shim (see src/lib/supabase.ts) and this module loads as its own
 * chunk the first time a retryable 503 actually appears.
 */
export async function retryPgrst503(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  firstResponse: Response
): Promise<Response> {
  let lastResponse = firstResponse;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    await sleep(RETRY_DELAYS_MS[attempt] + Math.random() * 250);
    const attemptInput =
      typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
    let response: Response;
    try {
      response = await globalThis.fetch(attemptInput, init);
    } catch (err) {
      // The first attempt proved the request reaches the server and is not
      // executed (pre-execution 503); a throw now is a transient network
      // failure. Surface the last 503 rather than the throw so callers keep
      // the structured PostgREST error.
      continue;
    }
    lastResponse = response;
    if (response.status !== 503) return response;
    let code: unknown;
    try {
      code = (await response.clone().json())?.code;
    } catch {
      return response;
    }
    if (typeof code !== 'string' || !RETRYABLE_PRE_EXECUTION_CODES.has(code)) return response;
  }
  return lastResponse;
}

/**
 * Wrap a fetch implementation with pre-execution-503 retry.
 * Pass the result to supabase-js `createClient(..., { global: { fetch } })`.
 */
export function withPgrstRetry(
  baseFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  // Bind lazily to globalThis to avoid "Illegal invocation" in browsers.
  const doFetch =
    baseFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = requestMethod(input, init);
    const replaySafeOnThrow = method === 'GET' || method === 'HEAD';

    let attempt = 0;
    for (;;) {
      // A Request object's body is consumed by fetch; clone per attempt so a
      // retry never replays an already-consumed stream.
      const attemptInput =
        typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;

      let response: Response;
      try {
        response = await doFetch(attemptInput, init);
      } catch (err) {
        // The request may or may not have reached the server. Only replay
        // methods where a duplicate is harmless.
        if (!replaySafeOnThrow || attempt >= RETRY_DELAYS_MS.length) throw err;
        await sleep(RETRY_DELAYS_MS[attempt] + Math.random() * 250);
        attempt++;
        continue;
      }

      if (response.status !== 503 || attempt >= RETRY_DELAYS_MS.length) {
        return response;
      }

      // Only retry the specific "request was never executed" PostgREST codes.
      let code: unknown;
      try {
        code = (await response.clone().json())?.code;
      } catch {
        return response; // non-JSON 503 (gateway/maintenance) — do not retry
      }
      if (typeof code !== 'string' || !RETRYABLE_PRE_EXECUTION_CODES.has(code)) {
        return response;
      }

      await sleep(RETRY_DELAYS_MS[attempt] + Math.random() * 250);
      attempt++;
    }
  };
}
