/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GAME SERVER API — HTTP Client for Player Actions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sends player actions (fold/call/raise/check/all-in) to the game server.
 * The server is the AUTHORITATIVE source for game state — it validates
 * actions, updates the HandController, and broadcasts the new state
 * to all clients via Supabase Realtime.
 *
 * This replaces the old "broadcast-only" approach where actions were
 * sent via Realtime but never reached the server-side engine.
 */

import { supabase } from '../lib/supabase';
import { AUTH_STORAGE_KEY, parseJwtPayload, readLocalSession } from '../lib/authUtils';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// Server URL — Hetzner Cloud VPS (Ashburn, VA) for production, localhost for development.
// The game server runs on a Hetzner CPX11 as a dedicated Node.js process with persistent
// in-memory state. Caddy reverse proxy handles HTTPS via Let's Encrypt.
// NEVER use Railway, Fly.io, or Vercel serverless for this (cold starts, no persistent state).
const GAME_SERVER_URL =
  import.meta.env.VITE_GAME_SERVER_URL ||
  (import.meta.env.PROD ? 'https://engine.smarter.poker' : 'http://localhost:8080');

/** An outage must not leave an HTTP action waiting forever before fetch starts. */
const ENGINE_AUTH_WAIT_MS = 15_000;
async function waitForEngineAuth<T>(work: (stillWaiting: () => boolean) => Promise<T>): Promise<T> {
  let waiting = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(() => waiting),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          waiting = false;
          reject(new Error('Engine authentication wait timed out'));
        }, ENGINE_AUTH_WAIT_MS);
      }),
    ]);
  } finally {
    waiting = false;
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Identity survives token expiry, but never a sign-out or a new login. */
function loginIdentity(token: string | null | undefined): string | null {
  const claims = token ? parseJwtPayload(token) : null;
  return typeof claims?.sub === 'string' &&
    claims.sub &&
    typeof claims.session_id === 'string' &&
    claims.session_id
    ? JSON.stringify([claims.sub, claims.session_id])
    : null;
}
function storedLoginIdentity(): string | null {
  try {
    return loginIdentity(
      JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? 'null')?.access_token
    );
  } catch {
    return null;
  }
}

/**
 * Get JWT auth headers for server requests.
 * Bible V8 §1.3: All game server endpoints require Supabase JWT auth.
 * The server extracts userId from the token — prevents spoofing.
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const owner = storedLoginIdentity();
  const assertOwner = (token?: string | null) => {
    if (!owner || storedLoginIdentity() !== owner || (token && loginIdentity(token) !== owner)) {
      throw new Error('Engine request login changed');
    }
  };
  assertOwner();
  return waitForEngineAuth<Record<string, string>>(
    async (stillWaiting): Promise<Record<string, string>> => {
      try {
        /* 2026-09-04: THE TOKEN CACHE FIRST. This used to call
       supabase.auth.getSession() and fall straight through to a request with
       NO Authorization header when that came back empty - which it does for
       the whole of a token refresh, and for the first moments after a page
       reload while auth-js is still restoring the session from storage. The
       engine answered 401 "Authentication required", and Dan read that toast
       on "I'm Back" thirty seconds after reloading a table he was plainly
       logged in to. getFreshAccessToken() is the path every socket already
       uses: in-memory cache, then getSession() (which refreshes), then the
       raw localStorage session. A refreshSession() is the last resort before
       going out unauthenticated.

       Imported lazily: this file is in the entry chunk and a static import
       pulled authToken.ts (and its tree) into first paint - the entry-chunk
       gate (scripts/ci/entry-chunk-delta.mjs) refused it. The call is on an
       async path, so the import costs nothing the request was not already
       waiting on, and the module is cached after the first. */
        const { getFreshAccessToken } = await import('../lib/authToken');
        if (!stillWaiting()) return { 'Content-Type': 'application/json' };
        assertOwner();
        let token = await getFreshAccessToken();
        if (!stillWaiting()) return { 'Content-Type': 'application/json' };
        assertOwner(token);
        if (!token) {
          const refreshed = await supabase.auth.refreshSession();
          token = refreshed.data.session?.access_token ?? null;
          if (!stillWaiting()) return { 'Content-Type': 'application/json' };
          assertOwner(token);
        }
        if (token) {
          return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };
        }
      } catch (e) {
        reportError(e, 'GameServerAPI.getAuthHeaders');
        assertOwner();
        throw e;
      }
      return { 'Content-Type': 'application/json' };
    }
  );
}

/**
 * fetch() against the engine with ONE retry on 401 (2026-09-04).
 *
 * A 401 from the engine means the request was refused before it ran, so
 * replaying it is safe for every endpoint here, including /action. The retry
 * asks auth-js for a refreshed session and re-sends with the new token; if
 * there is no session to refresh, the original 401 is returned and the caller
 * surfaces it as before. Every engine call in this file goes through it.
 */
async function engineFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const suppliedToken = new Headers(init.headers).get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (
    suppliedToken &&
    (!loginIdentity(suppliedToken) || loginIdentity(suppliedToken) !== storedLoginIdentity())
  ) {
    throw new Error('Engine request login changed');
  }
  const resp = await fetch(url, init);
  if (resp.status !== 401) return resp;
  // A refusal belongs to the login that sent it. The SDK's current session
  // may have changed while fetch or refresh was pending. Never turn an old
  // player's intent into an action for the newly signed-in player.
  const originalToken = new Headers(init.headers).get('Authorization')?.replace(/^Bearer\s+/i, '');
  const original = originalToken ? parseJwtPayload(originalToken) : null;
  const ownsRequest = (token: string | null | undefined): boolean => {
    if (
      !token ||
      typeof original?.sub !== 'string' ||
      typeof original.session_id !== 'string' ||
      !original.sub ||
      !original.session_id
    ) {
      return false;
    }
    const candidate = parseJwtPayload(token);
    return candidate?.sub === original.sub && candidate.session_id === original.session_id;
  };
  const stillOwnsRequest = () => ownsRequest(readLocalSession()?.accessToken);
  if (!stillOwnsRequest()) return resp;
  try {
    const refreshed = await waitForEngineAuth(() => supabase.auth.refreshSession());
    const token = refreshed.data.session?.access_token ?? null;
    if (!stillOwnsRequest()) return resp;
    if (!token) {
      // 2026-09-05: the engine refused us and the refresh could not produce a
      // token either. That is the 2026-09-03 shape - a session revoked out
      // from under a live tab - and it is the point at which retrying is
      // pointless. Ask GoTrue once (throttled inside the handler); a
      // definitively dead session ends in a prompt and a sign-in rather than
      // a table that spins forever. 'unknown' changes nothing.
      // Lazy: this module is only needed once a request has already been
      // refused, and a static import puts it in the entry chunk (CI, 2026-09-05).
      void import('../lib/sessionRevoked')
        .then((m) => (stillOwnsRequest() ? m.handleEngineAuthRejection('http:401') : 'unknown'))
        .catch(() => {
          /* a chunk that will not load must never sign anyone out */
        });
      return resp;
    }
    if (!ownsRequest(token)) return resp;
    const headers = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      Authorization: `Bearer ${token}`,
    };
    return await fetch(url, { ...init, headers });
  } catch {
    return resp;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER — Prevent error spam when game server is unreachable/CORS-blocked
// ═══════════════════════════════════════════════════════════════════════════════

const circuitBreaker = {
  /** Number of consecutive failures before tripping */
  THRESHOLD: 3,
  /** How long to stay tripped before retrying (ms) */
  COOLDOWN_MS: 30_000,
  /** Current consecutive failure count */
  failures: 0,
  /** Timestamp when the circuit tripped */
  trippedAt: 0,
  /** Last error reported timestamp — throttle reportError to 1 per 60s */
  lastReportedAt: 0,

  /** Check if circuit is currently open (blocking requests) */
  isOpen(): boolean {
    if (this.failures < this.THRESHOLD) return false;
    if (Date.now() - this.trippedAt > this.COOLDOWN_MS) {
      // Cooldown expired — allow a retry
      this.failures = 0;
      this.trippedAt = 0;
      return false;
    }
    return true;
  },

  /** Record a successful request — resets the circuit */
  recordSuccess(): void {
    this.failures = 0;
    this.trippedAt = 0;
  },

  /**
   * 2026-08-22: reset when the browser reports the network is back. Without
   * this, the failures accumulated while offline kept the breaker open for up
   * to COOLDOWN_MS AFTER connectivity returned — the first heartbeats and
   * actions of a recovered session were refused by our own client.
   */
  reset(): void {
    this.failures = 0;
    this.trippedAt = 0;
  },

  /** Record a failed request — increments toward tripping */
  recordFailure(err: unknown, context: string): void {
    this.failures++;
    if (this.failures >= this.THRESHOLD && this.trippedAt === 0) {
      this.trippedAt = Date.now();
    }
    // Throttle error reporting to max 1 per 60s to prevent error reporting spam
    const now = Date.now();
    if (now - this.lastReportedAt > 60_000) {
      this.lastReportedAt = now;
      reportError(err, context, { consecutiveFailures: this.failures });
    }
  },
};

// Instant post-outage recovery: clear the breaker the moment the network is
// back so heartbeats/actions are not refused by our own client (see reset()).
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => circuitBreaker.reset());
}

/**
 * 2026-09-04: the engine socket coming back is the other signal the network
 * is back - a laptop that never lost `navigator.onLine` but lost the route to
 * the engine for 40s has a tripped breaker and no 'online' event to clear it.
 * TablePage calls this on the socket's reconnect edge before its first
 * heartbeat.
 */
export function resetEngineCircuitBreaker(): void {
  circuitBreaker.reset();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActionResult {
  success: boolean;
  error?: string;
  code?: string;
  hint?: Record<string, unknown>;
  /**
   * Set by the engine when this answer came from its duplicate guard rather
   * than from applying the action a second time (Phase 3, 2026-09-05). The
   * verdict itself is identical to the first answer, so nothing in the UI
   * needs to branch on it - it exists so a replay is legible in a log and in
   * a test.
   */
  replayed?: boolean;
  /**
   * Dan 2026-08-30: /preaction replies carry this — the price to call that the
   * ENGINE recorded when it armed the pre-action, from its own authoritative
   * state. The client's panel-suppression rule
   * (src/lib/preActionPanelGate.ts) used to judge "can the engine still honour
   * this?" against a price the BROWSER snapshotted at tap time. Two snapshots
   * of one number, taken at two moments on two machines, agree almost always —
   * and the "almost" is a visible flash on a hand the engine was going to act,
   * or no panel on a hand where the arm had already been invalidated. Adopting
   * this collapses the two to one.
   */
  armedToCall?: number;
  /**
   * Dan 2026-08-29: /post-bb replies carry this. true = the player is in
   * between the blinds, so the post has been ACCEPTED AND HELD rather than
   * done — the engine posts it for them once the button is past, and the
   * caller must not ask them again. `error` then carries the sentence to
   * show, which is a status line and not a failure.
   */
  deferred?: boolean;
  /**
   * Dan 2026-08-21: /leave replies carry this. true = the engine has no live
   * hand holding the player (safe for the client to run the DB cashout now);
   * false = a hand is running and the ENGINE will cash the player out at
   * settlement (processLeavePending) — the client must NOT touch the stack.
   */
  immediate?: boolean;
  /**
   * CHIP STANDARD C1 (2026-09-02): /leave replies set this when the engine is
   * NOT going to cash the seat out itself and the browser must - no engine is
   * running for the table, or the engine never had this player in its hand
   * roster (a reserved seat). Absent on a between-hands leave a live engine
   * acknowledged: there the engine cashes out after settlement persists the
   * final stack, and a browser cash-out would race it with a stale one.
   * Older engines say the same thing with `note` on the no-engine reply.
   */
  clientCashout?: boolean;
  note?: string;
  /**
   * Cashier audit 2026-08-27: /addchips replies have ALWAYS carried these two
   * and the client threw them away. `applied` is what the engine actually
   * debited after capping to the seat's headroom — ask for 5,000 with 1,200
   * of room and the wallet moves 1,200, while the client used to subtract
   * the full 5,000 from every session figure. `queued` means the debit
   * committed but the chips land at the END of the current hand
   * (table_pending_addons), not immediately.
   */
  applied?: number;
  queued?: boolean;
}

export interface PlayerActions {
  canAct: boolean;
  actions: string[];
  toCall: number;
  minRaise: number;
  maxRaise: number;
  pot: number;
  error?: string;
}

export interface MaintenancePresentation {
  active: boolean;
  phase: 'last_hand' | 'counting_down' | 'finalizing' | 'resuming' | 'idle';
  break_id: number | null;
  break_ends_at: number | null;
  scheduled_ends_at: number | null;
  reason: string;
  timestamp: number;
}

export interface ServerStatus {
  maintenance?: { presentation?: MaintenancePresentation };
  running: boolean;
  uptime: number;
  activeTables: number;
  activeTournaments: number;
  totalHandsDealt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Submit a player action to the game server.
 * This is the PRIMARY way real players interact with the game engine.
 * Server identifies the player from the JWT token — userId is NOT sent in the body.
 *
 * @param tableId - The table UUID
 * @param _userId - DEPRECATED: Server uses JWT auth. Kept for backward compatibility.
 * @param action - Action type: 'fold', 'check', 'call', 'raise', 'allin'
 * @param amount - Optional amount for raise/bet actions
 * @returns ActionResult with success status and optional error message
 */
/**
 * Serialises action posts per table so the client cannot out-run the engine's
 * own 250ms window. Keyed by table: actions at DIFFERENT tables must never
 * wait on each other, which is the whole point of the per-table limiter on the
 * server side.
 */
const lastActionSentAt = new Map<string, number>();
const ACTION_MIN_SPACING_MS = 260; // engine window is 250ms; 10ms of slack

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ONE KEY PER INTENT (Realtime programme, Phase 3 - 2026-09-05).
 *
 * Generated once per `submitAction` call and reused by every retry inside it -
 * the 429 ladder below and the 401 refresh retry in `engineFetch`, which
 * re-sends the same body. That scope is the whole design: two retries of one
 * tap share a key and can only apply once; two separate taps are two intents,
 * get two keys, and the engine's turn logic judges the second on its merits.
 *
 * WHY IT IS NEEDED EVEN THOUGH BOTH RETRIES ARE "SAFE". They are safe because
 * a 429 and a 401 are refusals - a fact about somebody else's status codes,
 * re-derived by every future reader, guarding a raise that moves real chips.
 * The backoffs below are 300/450/700ms precisely so they clear the engine's
 * 250ms window, which means the one thing that would have collapsed a
 * duplicate is deliberately stepped over. See
 * `server/src/http/actionIdempotency.ts`.
 *
 * `crypto.randomUUID` is present in every browser Club Arena supports; the
 * fallback exists because it is also absent in a non-secure context, and an
 * action must never fail for want of a key.
 */
function newActionKey(): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* fall through to the arithmetic below */
  }
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Submit a player action.
 *
 * Dan 2026-08-19, bug list item 13: "'Server error (429)' popup must never
 * happen on a live game." Three things had to be true for that to hold, and
 * only the weakest of them was in place:
 *
 *  1. The engine must not rate-limit legitimate play. Its window was keyed by
 *     userId alone, so a multi-tabling player folding at one table and calling
 *     at another inside 250ms throttled themselves. Now keyed per user+table
 *     (see server/src/http/rateLimit.ts).
 *  2. The client must not fire faster than the window at a single table. It
 *     now waits out the remainder of the window before sending rather than
 *     sending and hoping.
 *  3. If a 429 still happens, it must be retried, not shown. A 429 means the
 *     request was NOT processed, so retrying is always safe. The old code
 *     retried exactly once and then put the raw status code on screen.
 *
 * The player never sees a status code: if every retry is exhausted the message
 * is in words, and the action is reported as failed so nothing is assumed to
 * have happened.
 */
export async function submitAction(
  tableId: string,
  _userId: string,
  action: string,
  amount?: number,
  actionContext?: string
): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();

    // Wait out the engine's window for THIS table before the first attempt.
    const since = Date.now() - (lastActionSentAt.get(tableId) ?? 0);
    if (since < ACTION_MIN_SPACING_MS) await sleep(ACTION_MIN_SPACING_MS - since);

    // One key for this intent, carried by every attempt below (see
    // newActionKey). In the BODY, not a header: the engine is a different
    // origin and its CORS allows only Content-Type and Authorization, so a
    // custom request header would fail preflight in every browser.
    const idempotencyKey = newActionKey();

    const BACKOFFS_MS = [300, 450, 700]; // 3 retries after the first attempt
    for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
      lastActionSentAt.set(tableId, Date.now());
      const response = await engineFetch(`${GAME_SERVER_URL}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tableId, action, amount, idempotencyKey, actionContext }),
      });

      if (response.ok) {
        const result = await response.json();
        return result as ActionResult;
      }

      if (response.status === 429 && attempt < BACKOFFS_MS.length) {
        await sleep(BACKOFFS_MS[attempt]);
        continue;
      }

      if (response.status === 429) {
        // Every retry exhausted. Never show the number.
        return { success: false, error: 'The table is busy - please try again' };
      }

      if (response.status === 400) {
        const rejected = await response.json();
        return {
          success: false,
          error: typeof rejected.error === 'string' ? rejected.error : 'Action rejected',
          code: rejected.code,
          hint: rejected.hint,
        };
      }

      if (response.status === 409) {
        // The duplicate guard saw this key carrying a different action, which
        // can only be a bug on this side - the key is generated fresh above
        // and never reused. Say it in words (Dan 2026-08-19: a status code is
        // never a message) and report failure, so nothing is assumed to have
        // happened at the table.
        return { success: false, error: 'That action could not be confirmed - please try again' };
      }

      return { success: false, error: `Server error (${response.status})` };
    }
    // Unreachable: the loop returns on every path.
    return { success: false, error: 'The table is busy - please try again' };
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.submitAction');
    return { success: false, error: 'Server unreachable' };
  }
}

/** Test-only: clear the per-table spacing map between cases. */
export function __resetActionSpacingForTests(): void {
  lastActionSentAt.clear();
}

/**
 * Activate the Time Bank for the current player's turn.
 * Asks the game server to extend their authoritative timer.
 * Server identifies the player from JWT — userId is NOT sent in the body.
 *
 * @param tableId - The table UUID
 * @param _userId - DEPRECATED: Server uses JWT auth. Kept for backward compatibility.
 * @returns ActionResult with success status and optional error message
 */
export async function activateTimeBank(tableId: string, _userId?: string): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/timebank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
    });

    if (!response.ok) {
      return { success: false, error: `Server error (${response.status})` };
    }

    const result = await response.json();
    return result as ActionResult;
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.activateTimeBank');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Get available actions for a player at a specific table.
 * Used to populate the ActionPanel with valid options.
 * Server identifies the player from JWT — the userId URL param is ignored by the server.
 *
 * @param tableId - The table UUID
 * @param _userId - DEPRECATED: Server uses JWT auth. Kept for backward compatibility.
 * @returns PlayerActions with available actions and betting limits
 */
export async function getAvailableActions(
  tableId: string,
  _userId?: string
): Promise<PlayerActions> {
  try {
    const headers = await getAuthHeaders();
    // Server ignores the userId URL param and uses JWT — pass 'me' as placeholder
    const response = await engineFetch(`${GAME_SERVER_URL}/actions/${tableId}/me`, { headers });

    if (!response.ok) {
      return {
        canAct: false,
        actions: [],
        toCall: 0,
        minRaise: 0,
        maxRaise: 0,
        pot: 0,
        error: `Server error (${response.status})`,
      };
    }

    const result = await response.json();
    return result as PlayerActions;
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.getActions');
    return {
      canAct: false,
      actions: [],
      toCall: 0,
      minRaise: 0,
      maxRaise: 0,
      pot: 0,
      error: 'Server unreachable',
    };
  }
}

/**
 * Get game server health/status.
 */
export async function getServerStatus(): Promise<ServerStatus | null> {
  try {
    const response = await engineFetch(`${GAME_SERVER_URL}/health`, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as ServerStatus;
  } catch (err) {
    reportError(err, 'GameServerAPI.getStatus');
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER LIFECYCLE — Heartbeat, Sit-Out, Pre-Actions, Straddle
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bible V8 §6.3: Send heartbeat to reset disconnect timer.
 * Must be called every 5 seconds while player is at the table.
 */
export async function sendHeartbeat(
  tableId: string,
  /**
   * PHASE 2 (2026-08-31) — THE DIFFERENCE BETWEEN ONLINE AND WORKING.
   *
   * A heartbeat only proves the app is running and the network is up. It says
   * nothing about whether the player can SEE anything, and on 2026-08-31 that
   * gap cost somebody their seat: his client had erased his own seat from the
   * table, so the engine offered him turns nobody could see, timed each one
   * out, force-sat him out and evicted him — while his heartbeat landed
   * perfectly every five seconds throughout.
   *
   * `turnRendered` closes that gap. When the client has actually DRAWN the
   * action controls for this player, it says so, and the engine can tell an
   * absent player from a broken one. Optional by design: it can only ever
   * make the engine quieter about a player, never harsher, so a client that
   * never sends it is treated exactly as every client is treated today.
   */
  opts?: {
    turnRendered?: boolean;
    /** The bust-rebuy dialog is on screen: the engine's busted-seat sweep
     *  waits for a player who is at the cashier (2026-09-04). */
    rebuyPromptOpen?: boolean;
  }
): Promise<ActionResult> {
  // Circuit breaker: skip if game server is known-unreachable
  if (circuitBreaker.isOpen()) {
    return { success: false, error: 'Circuit breaker open - server unreachable' };
  }
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tableId,
        ...(opts?.turnRendered ? { turnRendered: true } : {}),
        ...(opts?.rebuyPromptOpen ? { rebuyPromptOpen: true } : {}),
      }),
    });
    if (!response.ok) {
      circuitBreaker.recordFailure(new Error(`HTTP ${response.status}`), 'GameServerAPI.heartbeat');
      return { success: false, error: `Server error (${response.status})` };
    }
    circuitBreaker.recordSuccess();
    return (await response.json()) as ActionResult;
  } catch (err: unknown) {
    circuitBreaker.recordFailure(err, 'GameServerAPI.heartbeat');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Dan 2026-08-23: tell the server we are leaving the page or the app.
 *
 * Fires from `pagehide`, the last event a browser reliably delivers before it
 * tears the document down (`unload` does not fire on mobile Safari at all,
 * and an ordinary fetch started there is cancelled with the document).
 *
 * Why this exists when the websocket close already tells the server
 * something: a socket close is ambiguous, so it only opens an 8s grace window
 * in case the player is still there on the HTTP heartbeat. This is
 * unambiguous — the server marks them AWAY immediately and the
 * one-SB-one-BB cap starts counting. Coming back cancels it for free.
 *
 * Uses `fetch(..., { keepalive: true })` rather than `navigator.sendBeacon`
 * deliberately. sendBeacon cannot set an Authorization header, which would
 * force the JWT into the request body and force the SERVER's shared auth
 * helper to learn a second way to receive a token — a change to the one
 * function guarding every money route, for the benefit of the least
 * important route on the server. Not a trade worth making. A keepalive fetch
 * carries the normal Bearer header, is owned by the browser's network stack
 * once dispatched, and outlives the document exactly like a beacon does.
 *
 * Best-effort by design: if it fails, the websocket close still reaches the
 * server, just 8 seconds later via the transport grace window. Nothing is
 * lost, the player is simply marked away slightly less promptly.
 *
 * Takes the token as an argument rather than awaiting `getAuthHeaders()` —
 * `pagehide` handlers must be synchronous, and an `await` there means the
 * request is never dispatched at all.
 */
export function sendAwayBeacon(tableId: string, accessToken: string | null): void {
  if (!tableId || !accessToken) return;
  try {
    void fetch(`${GAME_SERVER_URL}/away`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ tableId }),
      keepalive: true,
    }).catch(() => {
      /* the page is going away; there is nobody left to tell */
    });
  } catch {
    /* never let a teardown path throw */
  }
}

/**
 * Bible V8 §4.15: Set or clear a pre-action (auto-fold, auto-check, etc.)
 * @param action - Pre-action type or 'clear' to remove
 * @param maxCallAmount - Optional max call amount for auto_call
 */
export async function setPreAction(
  tableId: string,
  action: string,
  maxCallAmount?: number
): Promise<ActionResult> {
  // Circuit breaker: skip if game server is known-unreachable
  if (circuitBreaker.isOpen()) {
    return { success: false, error: 'Circuit breaker open - server unreachable' };
  }
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/preaction`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, action, maxCallAmount }),
    });
    if (!response.ok) {
      // HTTP 400 = invalid pre-action (not player's turn, not in hand) —
      // this is an expected user-state mismatch, NOT a server bug. Do not
      // report to error reporting; just return the error for the caller to handle.
      if (response.status === 400) {
        console.debug(
          `[GameServerAPI] setPreAction rejected (HTTP 400) - player not in hand or not their turn`
        );
        return { success: false, error: `Server error (${response.status})` };
      }
      circuitBreaker.recordFailure(
        new Error(`HTTP ${response.status}`),
        'GameServerAPI.setPreAction'
      );
      return { success: false, error: `Server error (${response.status})` };
    }
    circuitBreaker.recordSuccess();
    return (await response.json()) as ActionResult;
  } catch (err: unknown) {
    circuitBreaker.recordFailure(err, 'GameServerAPI.setPreAction');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Add chips to the table stack (mid-hand rebuy or top-up).
 * Send to authoritative engine memory so it doesn't get overwritten on hand sync.
 * @param tableId Table ID
 * @param amount Amount of chips to add
 */
export async function addChips(
  tableId: string,
  amount: number,
  /** Caller-held per-attempt id (Cashier audit 2026-08-27, P0-1): hold it
   *  across retries of the SAME attempt so a re-send after a lost response
   *  de-duplicates server-side instead of debiting twice. */
  opId?: string
): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const res = await engineFetch(`${GAME_SERVER_URL}/addchips`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opId ? { tableId, amount, opId } : { tableId, amount }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to add chips via GameServerAPI');
    }

    const data = await res.json();
    /* `applied` and `queued` propagate — the engine caps the top-up to the
       seat's headroom and says what actually moved; discarding that made the
       client account for the REQUESTED amount (Cashier audit 2026-08-27). */
    return {
      success: data.success,
      error: data.error,
      applied: typeof data.applied === 'number' ? data.applied : undefined,
      queued: data.queued === true,
    };
  } catch (err: any) {
    console.error(`[GameServerAPI] addChips error:`, err);
    /* TRANSPORT means the OUTCOME IS UNKNOWN: the request may have reached
       the engine and committed before the response was lost. Callers must
       not tell the player "your wallet was not charged" on this path —
       that claim is only true for a server refusal (Cashier audit
       2026-08-27, P0-1). */
    return { success: false, error: err.message || 'Network error', code: 'TRANSPORT' };
  }
}

/*
 * CHIP CONTINUITY (2026-09-04): the partial cash-out call (POST /withdrawchips)
 * is gone. Chips on a cash table stay on the table until the player leaves.
 */

/**
 * Bible V8 §7.12: Player sit out or sit back in.
 * @param sitOut - true = sit out, false = sit back in
 */
export async function setSitOut(
  tableId: string,
  sitOut: boolean
): Promise<ActionResult & { willFoldNextHand?: boolean }> {
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/sitout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, sitOut }),
    });
    /* READ THE BODY BEFORE JUDGING THE STATUS (2026-08-28).
     *
     * `handlers/sitout.ts` answers a refusal with HTTP 400 and the REASON in
     * the body. This used to return `Server error (400)` on any non-2xx, so
     * every sit-out refusal the engine could produce was replaced with a status
     * code before a human ever saw it. That was survivable while the only
     * refusal was "Player not found at this table"; it stops being survivable
     * now that a 400 also means "you must play at least one hand before you can
     * sit out" (Dan 2026-08-28), which is a rule the player has to be told or
     * the button just looks broken.
     *
     * The status code is still the fallback for a response with no usable body
     * — a proxy error page, a 502, an empty 500. */
    const body = (await response.json().catch(() => null)) as
      | (ActionResult & { willFoldNextHand?: boolean })
      | null;
    if (body && typeof body.success === 'boolean') return body;
    if (!response.ok) return { success: false, error: `Server error (${response.status})` };
    return { success: false, error: 'Server sent an unreadable response' };
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.setSitOut');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Bible V8 §4.4: Toggle auto-straddle for the player.
 */
export async function toggleStraddle(tableId: string, enabled: boolean): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/straddle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, enabled }),
    });
    if (!response.ok) return { success: false, error: `Server error (${response.status})` };
    return (await response.json()) as ActionResult;
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.toggleStraddle');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Bible V8 §2.4: Get current table state (scrubbed for requesting player).
 */
export async function getTableState(tableId: string): Promise<Record<string, unknown> | null> {
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/state/${tableId}`, { headers });
    if (!response.ok) return null;
    return await response.json();
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.getState');
    return null;
  }
}

/**
 * The engine's two verdicts on a VIEWER of a table (server/src/handlers/state.ts
 * answers GET /state with 403 and one of these codes). The same two the
 * multiplexed socket carries as `subscription refused: <CODE>`
 * (MUX_ACCESS_REFUSAL_CODES in services/EngineSocketMux, pinned equal by
 * tests/a-wake-refusal-is-not-a-slow-engine.test.ts). Declared here rather than
 * imported so this entry-chunk module takes no new static import.
 */
export const TABLE_VIEW_REFUSAL_CODES = [
  'CLUB_MEMBERSHIP_REQUIRED',
  'OBSERVERS_RESTRICTED',
] as const;
export type TableViewRefusal = (typeof TABLE_VIEW_REFUSAL_CODES)[number];

/** What one wake read learned: the engine is up, it refused this viewer, or neither yet. */
export type TableWakeResult =
  | { status: 'awake'; state: Record<string, unknown> }
  | { status: 'refused'; code: TableViewRefusal }
  | { status: 'not_awake' };

/**
 * ═══ A WAKE THAT CAN TELL "NOT YET" FROM "NOT YOU" (2026-09-22) ═══════════
 *
 * The same authenticated GET /state/:id as getTableState - the read that
 * provisions a created table's engine on first demand
 * (GameServer.ensureCashTableEngine) - for the one caller that has to act on
 * WHY it failed: Start in the New Cash Game flow.
 *
 * getTableState answers null for a 403, a 404, a 503 and a dropped request
 * alike, so a union operator who may CREATE a game but may not WATCH its table
 * was retried for four seconds and then told "The Table Is Still Starting", a
 * sentence no amount of waiting makes true. Here a 403 carrying one of the
 * engine's two access codes is a verdict; everything else - including a 403
 * without a code this client knows - is "not awake yet", which is exactly what
 * getTableState's null meant. Never throws.
 *
 * A sibling rather than a change to getTableState, so that no other caller
 * (TableWebSocket's resync, anything reaching it through the default export)
 * sees a different answer.
 */
export async function wakeTable(tableId: string): Promise<TableWakeResult> {
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/state/${tableId}`, { headers });
    if (response.ok) {
      const state: unknown = await response.json();
      return state && typeof state === 'object'
        ? { status: 'awake', state: state as Record<string, unknown> }
        : { status: 'not_awake' };
    }
    if (response.status === 403) {
      const code = await viewRefusalOf(response);
      if (code) return { status: 'refused', code };
    }
    return { status: 'not_awake' };
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.wakeTable');
    return { status: 'not_awake' };
  }
}

/** The access code a 403 body names, if it is one of the engine's two. */
async function viewRefusalOf(response: Response): Promise<TableViewRefusal | null> {
  try {
    const body = (await response.json()) as { code?: unknown } | null;
    const code = body && typeof body === 'object' ? body.code : null;
    return (TABLE_VIEW_REFUSAL_CODES as readonly unknown[]).includes(code)
      ? (code as TableViewRefusal)
      : null;
  } catch {
    // An unreadable body is not a verdict; the caller treats it as not awake.
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADVANCED FEATURES — RIT, Insurance, Show Hand
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FIX 96: Bible V8 §4.20 + Dan's rules: Run It Twice 2-phase flow.
 *
 * Phase 1 — CHOOSER (best hand): Call with `runs` param (1=decline, 2=twice, 3=three times)
 * Phase 2 — OTHER PLAYERS: Call with `response` param ('accept' or 'decline')
 *
 * @param tableId - The table UUID
 * @param options.response - 'accept' or 'decline' (for non-chooser players)
 * @param options.runs - 1, 2, or 3 (for the chooser only)
 */
export async function respondToRIT(
  tableId: string,
  options: { response?: 'accept' | 'decline'; runs?: 1 | 2 | 3 }
): Promise<ActionResult & { status?: string }> {
  try {
    const headers = await getAuthHeaders();
    const body: Record<string, unknown> = { tableId };
    if (options.runs !== undefined) body.runs = options.runs;
    if (options.response !== undefined) body.response = options.response;

    const resp = await engineFetch(`${GAME_SERVER_URL}/rit`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return await resp.json();
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.respondToRIT');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Bible V8 §4.19: Respond to an insurance offer.
 * @param response - 'accept' or 'decline'
 * @param coveragePercent - 1-100 (default 100). Partial insurance via slider.
 * @param declineForHand - true = "Decline for Hand" (never re-offer on later streets).
 *                         false = "Decline Now" (may be re-offered if equity shifts).
 */
export async function respondToInsurance(
  tableId: string,
  // EV CASHOUT 2026-08-28: 'cashout' locks pot x equity (minus fee) now.
  response: 'accept' | 'decline' | 'cashout',
  coveragePercent: number = 100,
  declineForHand: boolean = false
): Promise<ActionResult & { status?: string; premium?: number; insuredAmount?: number }> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(`${GAME_SERVER_URL}/insurance`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, response, coveragePercent, declineForHand }),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return await resp.json();
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.respondToInsurance');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Bible V8 §4.19: Preview insurance cost for a given coverage percentage.
 * Used by the client slider to show real-time cost/payout as user adjusts.
 */
export async function previewInsurance(
  tableId: string,
  coveragePercent: number = 100
): Promise<ActionResult & { premium?: number; insuredAmount?: number; coveragePercent?: number }> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(
      `${GAME_SERVER_URL}/insurance-preview?tableId=${encodeURIComponent(tableId)}&coveragePercent=${coveragePercent}`,
      { method: 'GET', headers }
    );
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return await resp.json();
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.previewInsurance');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Bible V8 §4.21: Voluntarily show hand at showdown.
 */
export async function showHand(tableId: string): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(`${GAME_SERVER_URL}/showhand`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return (await resp.json()) as ActionResult;
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.showHand');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * FIX 120: Crazy Pineapple — submit discard action
 * @param tableId - The table
 * @param cardIndex - Which card to discard (0, 1, or 2)
 */
export async function submitDiscard(tableId: string, cardIndex: number): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(`${GAME_SERVER_URL}/discard`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, cardIndex }),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return (await resp.json()) as ActionResult;
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.submitDiscard');
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * POST /leave — Notify the game server that a player is leaving the table.
 * The server will auto-fold if mid-hand, then mark leave_pending for cashout.
 */
export async function notifyServerKickOccupancy(
  tableId: string,
  userId: string,
  seatNumber: number,
  occupancyId: string,
  reason: string
): Promise<unknown> {
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(GAME_SERVER_URL + '/admin/kick-occupancy', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, userId, seatNumber, occupancyId, reason }),
    });
    const body: unknown = await response.json();
    if (!response.ok && body && typeof body === 'object') return { ...body, success: false };
    return body;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could Not Confirm Removal',
    };
  }
}

export async function notifyServerLeaveOccupancy(
  tableId: string,
  seatNumber: number,
  occupancyId: string
): Promise<unknown> {
  try {
    const headers = await getAuthHeaders();
    const response = await engineFetch(`${GAME_SERVER_URL}/leave-occupancy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, seatNumber, occupancyId }),
    });
    const body: unknown = await response.json();
    if (!response.ok && body && typeof body === 'object') {
      return { ...body, success: false };
    }
    return body;
  } catch {
    return { success: false, error: 'Could Not Confirm The Leave. Please Try Again.' };
  }
}

export async function notifyServerLeave(tableId: string): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(`${GAME_SERVER_URL}/leave`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
    });
    if (!resp.ok) {
      // Dan 2026-08-20 (leave-stuck fix): surface the engine's structured
      // error instead of a bare status code — TableService shows this to the
      // player when it refuses the cashout, and "Server error (400)" told
      // nobody anything.
      try {
        const body = (await resp.json()) as ActionResult;
        return {
          success: false,
          error: body?.error || `Server error (${resp.status})`,
          code: body?.code,
        };
      } catch {
        return { success: false, error: `Server error (${resp.status})` };
      }
    }
    return (await resp.json()) as ActionResult;
  } catch (err: unknown) {
    // Non-fatal — client-side leave still works via Supabase
    console.warn('[GameServerAPI] notifyServerLeave failed:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * POST /reject_rebuy — Notify the game server that a player rejected the rebuy modal.
 */
export async function notifyServerRejectRebuy(tableId: string): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(`${GAME_SERVER_URL}/reject_rebuy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return (await resp.json()) as ActionResult;
  } catch (err: unknown) {
    console.warn('[GameServerAPI] notifyServerRejectRebuy failed:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * POST /post-bb — Bible V8 §4.2: Post the BB to enter the next hand
 * immediately, skipping the normal "wait for BB to rotate to your seat" delay.
 *
 * THIS COMMENT WAS STALE AND SAID THE OPPOSITE OF THE TRUTH (corrected
 * 2026-08-29). It read "NOTHING IN THE UI CALLS THIS ANY MORE, deliberately...
 * cash entry is free", which was the 2026-08-25 rule Dan reversed on
 * 2026-08-26: "Every single player needs to either wait for the BB or post
 * when entering a cash game... no free hands." TablePage has called this from
 * two places ever since — the post-or-wait modal and the on-felt overlay.
 *
 * Three outcomes, and the caller must read them in this order:
 *   deferred:true          in between the blinds. Accepted and HELD; the
 *                          engine posts it when the button passes. Do not
 *                          ask again. `error` is the status line to show.
 *   success:true           posted; dealt into the next hand, billed one BB.
 *   success:false          not held out at all (already in the rotation).
 */
export async function postBBToEnter(tableId: string): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(`${GAME_SERVER_URL}/post-bb`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return (await resp.json()) as ActionResult;
  } catch (err: unknown) {
    console.warn('[GameServerAPI] postBBToEnter failed:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * POST /rabbit-hunt — buy the cards that would have come. Dan 2026-08-25.
 *
 * This is the ONLY way the rabbit-hunt cards reach a client. They are not in
 * any broadcast and never have been since this endpoint existed: the engine
 * used to put all five into the room-wide `rabbit_hunt_available` event, so
 * every opponent received them in cleartext and the charge was a client-side
 * `if` anyone could skip.
 *
 * The server charges first (VIP monthly pool, then a purchased pack, then five
 * diamonds) and returns the cards only to the caller that paid. So the response
 * is the reveal — there is nothing to re-fetch and nothing to bill afterwards.
 */
export interface RabbitHuntResult {
  success: boolean;
  error?: string;
  cards?: { rank: string; suit: string }[];
  board_length?: number;
  source?: string;
  diamonds_spent?: number;
  diamonds_remaining?: number | null;
  vip_remaining?: number | null;
  /** Uses left on a purchased rabbit-hunt pack, when a pack paid for this one. */
  uses_remaining?: number | null;
}

export async function requestRabbitHunt(
  tableId: string,
  handNumber?: number
): Promise<RabbitHuntResult> {
  try {
    const headers = await getAuthHeaders();
    const resp = await engineFetch(`${GAME_SERVER_URL}/rabbit-hunt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, handNumber }),
    });
    // A 400 carries a real, human-readable reason from the engine ("Not Enough
    // Diamonds", "You Were Not Dealt Into That Hand"), so parse the body rather
    // than flattening every non-200 into a generic failure.
    const data = (await resp.json().catch(() => null)) as RabbitHuntResult | null;
    if (data) return data;
    return { success: false, error: `Server error (${resp.status})` };
  } catch (err: unknown) {
    console.warn('[GameServerAPI] requestRabbitHunt failed:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CONNECTIVITY
// -----------------------------------------------------------------------------
// Round 56 (2026-05-01): the legacy `connectTableWebSocket` /
// ReconnectingWebSocket / DeltaSyncService trio was removed. It was an old
// duplicate of the engine WS wiring that:
//   • didn't send the `bearer` Sec-WebSocket-Protocol auth header,
//   • never replied to server PING (server would close after 60s),
//   • used non-existent message types (REQUEST_SNAPSHOT, nested RESYNC).
// Nothing imported it externally (verified via grep), so deleting it removes
// a footgun without behaviour change. The production reconnect path lives in
// `services/EngineStateClient.ts` driven by `hooks/useEngineTableState.ts`.
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  submitAction,
  activateTimeBank,
  getAvailableActions,
  getServerStatus,
  sendHeartbeat,
  setPreAction,
  setSitOut,
  toggleStraddle,
  addChips,
  getTableState,
  respondToRIT,
  respondToInsurance,
  previewInsurance,
  showHand,
  submitDiscard, // FIX 120: Crazy Pineapple
  notifyServerRejectRebuy,
  // Was the only member of this module missing from the default export, so
  // anyone reaching for GameServerAPI.requestRabbitHunt got undefined while
  // its seventeen siblings resolved.
  requestRabbitHunt,
  postBBToEnter,
};
