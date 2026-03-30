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

/**
 * Get JWT auth headers for server requests.
 * Bible V8 §1.3: All game server endpoints require Supabase JWT auth.
 * The server extracts userId from the token — prevents spoofing.
 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      };
    }
  } catch (e) {
    reportError(e, 'GameServerAPI.getAuthHeaders');
    // Silent — fall through to no-auth headers
  }
  return { 'Content-Type': 'application/json' };
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
      this.failures = 0;
      return false;
    }
    return true;
  },

  /** Record a successful request — resets the circuit */
  recordSuccess(): void {
    this.failures = 0;
    this.trippedAt = 0;
  },

  /** Record a failed request — increments toward tripping */
  recordFailure(err: unknown, context: string): void {
    this.failures++;
    if (this.failures >= this.THRESHOLD && this.trippedAt === 0) {
      this.trippedAt = Date.now();
    }
    // Throttle error reporting to max 1 per 60s to prevent Sentry spam
    const now = Date.now();
    if (now - this.lastReportedAt > 60_000) {
      this.lastReportedAt = now;
      reportError(err, context, { consecutiveFailures: this.failures });
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActionResult {
  success: boolean;
  error?: string;
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

export interface ServerStatus {
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
export async function submitAction(
  tableId: string,
  _userId: string,
  action: string,
  amount?: number
): Promise<ActionResult> {
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${GAME_SERVER_URL}/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, action, amount }),
    });

    if (!response.ok) {
      return { success: false, error: `Server error (${response.status})` };
    }

    const result = await response.json();
    return result as ActionResult;
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.submitAction');
    return { success: false, error: 'Server unreachable' };
  }
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
    const response = await fetch(`${GAME_SERVER_URL}/timebank`, {
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
    const response = await fetch(`${GAME_SERVER_URL}/actions/${tableId}/me`, { headers });

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
    const response = await fetch(`${GAME_SERVER_URL}/health`);
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
export async function sendHeartbeat(tableId: string): Promise<ActionResult> {
  // Circuit breaker: skip if game server is known-unreachable
  if (circuitBreaker.isOpen()) {
    return { success: false, error: 'Circuit breaker open — server unreachable' };
  }
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${GAME_SERVER_URL}/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
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
    return { success: false, error: 'Circuit breaker open — server unreachable' };
  }
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${GAME_SERVER_URL}/preaction`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, action, maxCallAmount }),
    });
    if (!response.ok) {
      circuitBreaker.recordFailure(new Error(`HTTP ${response.status}`), 'GameServerAPI.setPreAction');
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
 * Bible V8 §7.12: Player sit out or sit back in.
 * @param sitOut - true = sit out, false = sit back in
 */
export async function setSitOut(
  tableId: string,
  sitOut: boolean
): Promise<ActionResult & { willFoldNextHand?: boolean }> {
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${GAME_SERVER_URL}/sitout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, sitOut }),
    });
    if (!response.ok) return { success: false, error: `Server error (${response.status})` };
    return await response.json();
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
    const response = await fetch(`${GAME_SERVER_URL}/straddle`, {
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
    const response = await fetch(`${GAME_SERVER_URL}/state/${tableId}`, { headers });
    if (!response.ok) return null;
    return await response.json();
  } catch (err: unknown) {
    reportError(err, 'GameServerAPI.getState');
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

    const resp = await fetch(`${GAME_SERVER_URL}/rit`, {
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
  response: 'accept' | 'decline',
  coveragePercent: number = 100,
  declineForHand: boolean = false
): Promise<ActionResult & { status?: string; premium?: number; insuredAmount?: number }> {
  try {
    const headers = await getAuthHeaders();
    const resp = await fetch(`${GAME_SERVER_URL}/insurance`, {
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
    const resp = await fetch(
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
    const resp = await fetch(`${GAME_SERVER_URL}/showhand`, {
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
    const resp = await fetch(`${GAME_SERVER_URL}/discard`, {
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

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CONNECTIVITY — Real-time table state sync
// ═══════════════════════════════════════════════════════════════════════════════

import { ReconnectingWebSocket, type WSMessage } from './ReconnectingWebSocket';
import { DeltaSyncService, type DeltaMessage } from './DeltaSyncService';

let activeWS: ReconnectingWebSocket | null = null;
let activeDeltaSync: DeltaSyncService<Record<string, unknown>> | null = null;

/**
 * Connect WebSocket to a table for real-time state updates.
 * Uses ReconnectingWebSocket with exponential backoff.
 */
export function connectTableWebSocket(
  tableId: string,
  onStateUpdate: (state: Record<string, unknown>, changedKeys: string[]) => void
): ReconnectingWebSocket {
  // Disconnect any existing connection
  disconnectTableWebSocket();

  const wsUrl = GAME_SERVER_URL.replace(/^http/, 'ws') + `/ws/table/${tableId}`;

  // Create delta sync service for incremental state updates
  activeDeltaSync = new DeltaSyncService<Record<string, unknown>>({});
  activeDeltaSync.onChange(onStateUpdate);

  // Create reconnecting WebSocket
  activeWS = new ReconnectingWebSocket(wsUrl, {
    maxRetries: 10,
    initialDelay: 1000,
    maxDelay: 30000,
    heartbeatInterval: 30000,
    resyncPayload: () => ({
      type: 'RESYNC',
      tableId,
      lastVersion: activeDeltaSync?.getVersion() ?? 0,
    }),
  });

  // Handle incoming messages through delta sync
  activeWS.onMessage((msg: WSMessage) => {
    if (msg.type === 'DELTA' || msg.type === 'SNAPSHOT') {
      activeDeltaSync?.processMessage(msg as DeltaMessage);
    }
  });

  // Request snapshot on version gap
  activeDeltaSync.onSnapshotRequest(() => {
    activeWS?.send({ type: 'REQUEST_SNAPSHOT', payload: { tableId } });
  });

  activeWS.connect();
  return activeWS;
}

/**
 * Disconnect the active table WebSocket
 */
export function disconnectTableWebSocket(): void {
  if (activeWS) {
    activeWS.disconnect();
    activeWS = null;
  }
  activeDeltaSync = null;
}

/**
 * Get current WebSocket connection status
 */
export function getWebSocketStatus(): string | null {
  return activeWS?.getStatus() ?? null;
}

export default {
  submitAction,
  activateTimeBank,
  getAvailableActions,
  getServerStatus,
  sendHeartbeat,
  setPreAction,
  setSitOut,
  toggleStraddle,
  getTableState,
  respondToRIT,
  respondToInsurance,
  previewInsurance,
  showHand,
  submitDiscard, // FIX 120: Crazy Pineapple
  connectTableWebSocket,
  disconnectTableWebSocket,
  getWebSocketStatus,
};
