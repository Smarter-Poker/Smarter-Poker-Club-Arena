/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND SPINS RPC DEADLINE — a request that never answers is still an answer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-22, review round 2)
 *
 * Every Diamond Spins page waits on the server for the thing the player just
 * did. The Crash tick chain holds the live round between polls, `starting`
 * holds the plate, `cashing` holds the cash-out, Plinko holds `busy`, and a
 * move holds the tile it was made on. Each of those waits is one `await` on a
 * Supabase RPC — and `fetch` has no timeout. A socket that dies without a FIN
 * (a phone changing networks, a laptop waking, a proxy holding the stream)
 * leaves that await pending for as long as the page stays open: the round
 * still reads "open", the live-bonus guard still holds the player, the button
 * stays busy, and nothing recovers, because from the page's side nothing has
 * failed yet.
 *
 * WHAT THIS CHANGES
 *
 * A Diamond Spins RPC now has a budget. When it expires the request is
 * aborted and the page is handed the one case it is already written for: a
 * send whose answer never arrived. Each page's own recovery then runs — a
 * saved wager is replayed on its own ticket until the server says what
 * happened, a move re-reads its round, the tick asks again on its next beat.
 *
 * WHY ASKING AGAIN IS SAFE. Every money door behind these calls is idempotent
 * on the identity the request carries: `fn_plinko_drop` and the bonus starts
 * on their commit (a completed game replays its receipt), a cash-out and a
 * settle on their round, a wheel spin on its commit. So a request that DID
 * commit before the deadline answers the replay with the same receipt instead
 * of charging twice. That is also the path a dropped connection has always
 * taken; the deadline does not add it, it stops the page from waiting forever
 * to reach it.
 *
 * WHY TWENTY SECONDS. The database stops an `authenticated` statement at 8s
 * and PostgREST waits at most 10s for a pooled connection, so no legitimate
 * answer to one of these calls is still being computed at 20s — past that the
 * socket is gone, not slow. A deadline that fires early anyway costs one
 * replay, never a round.
 *
 * WHY HEADERS ARE NOT THE ANSWER. postgrest-js reads the body AFTER fetch
 * resolves, so a reply whose headers arrive and whose body then stalls holds
 * the caller exactly as a silent socket does. The body is read inside the
 * budget and handed on as a complete response.
 *
 * SCOPE — DIAMOND SPINS ONLY. The families below are the wheel, the four
 * bonus games and the diamond readouts those pages draw. The rest of the app
 * keeps the transport it has today: bounding it is an audit of every other
 * caller's recovery (tables, tournaments, marketplace), not a side effect of
 * this fix.
 *
 * LOADED LAZILY from src/lib/supabase.ts, so the entry chunk every player
 * downloads before first paint pays for the route test and nothing else.
 */
import { runWithRequestDeadline } from '../utils/requestDeadline';

/** Comfortably past the server's own limits (8s statement, 10s pool wait). */
export const DIAMOND_SPINS_RPC_DEADLINE_MS = 20_000;

/** A response with a body of its own; the rest must be constructed with null. */
const BODILESS = new Set([204, 205, 304]);

export type SendRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Send one Diamond Spins request under the deadline. `send` is the transport
 * the client would have used anyway (PostgREST 503 retries and all), so this
 * bounds the whole exchange rather than a single attempt inside it.
 */
export function fetchDiamondSpinsRpc(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  send: SendRequest
): Promise<Response> {
  const upstream =
    init?.signal ??
    (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  return runWithRequestDeadline(
    async (signal) => {
      const response = await send(input, { ...init, signal });
      const body = await response.arrayBuffer();
      return new Response(BODILESS.has(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    { timeoutMs: DIAMOND_SPINS_RPC_DEADLINE_MS, signal: upstream ?? undefined }
  );
}
