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

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// Server URL — Railway for production, localhost for development.
// The game server runs on Railway.app as a dedicated Node.js process with persistent
// WebSocket connections. Never use Vercel serverless for this (cold starts, no WS).
const GAME_SERVER_URL =
  import.meta.env.VITE_GAME_SERVER_URL ||
  (import.meta.env.PROD
    ? 'https://smarter-poker-game-server-production.up.railway.app'
    : 'http://localhost:8080');

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
  } catch {
    // Silent — fall through to no-auth headers
  }
  return { 'Content-Type': 'application/json' };
}

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
 *
 * @param tableId - The table UUID
 * @param userId - The player's user UUID
 * @param action - Action type: 'fold', 'check', 'call', 'raise', 'allin'
 * @param amount - Optional amount for raise/bet actions
 * @returns ActionResult with success status and optional error message
 */
export async function submitAction(
  tableId: string,
  userId: string,
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
    console.error('[GameServerAPI] Failed to submit action:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Activate the Time Bank for the current player's turn.
 * Asks the game server to extend their authoritative timer.
 *
 * @param tableId - The table UUID
 * @param userId - The player's user UUID
 * @returns ActionResult with success status and optional error message
 */
export async function activateTimeBank(tableId: string, userId: string): Promise<ActionResult> {
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
    console.error('[GameServerAPI] Failed to activate time bank:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Get available actions for a player at a specific table.
 * Used to populate the ActionPanel with valid options.
 *
 * @param tableId - The table UUID
 * @param userId - The player's user UUID
 * @returns PlayerActions with available actions and betting limits
 */
export async function getAvailableActions(tableId: string, userId: string): Promise<PlayerActions> {
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${GAME_SERVER_URL}/actions/${tableId}/${userId}`, { headers });

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
    console.error('[GameServerAPI] Failed to get actions:', err);
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
    console.error('[GameServerAPI] Error:', err);
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
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${GAME_SERVER_URL}/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId }),
    });
    if (!response.ok) return { success: false, error: `Server error (${response.status})` };
    return (await response.json()) as ActionResult;
  } catch (err: unknown) {
    console.error('[GameServerAPI] Heartbeat failed:', err);
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
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${GAME_SERVER_URL}/preaction`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, action, maxCallAmount }),
    });
    if (!response.ok) return { success: false, error: `Server error (${response.status})` };
    return (await response.json()) as ActionResult;
  } catch (err: unknown) {
    console.error('[GameServerAPI] Set pre-action failed:', err);
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
    console.error('[GameServerAPI] Sit out failed:', err);
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
    console.error('[GameServerAPI] Toggle straddle failed:', err);
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
    console.error('[GameServerAPI] Get state failed:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADVANCED FEATURES — RIT, Insurance, Show Hand
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bible V8 §4.20: Respond to a Run It Twice offer.
 * @param response - 'accept' or 'decline'
 */
export async function respondToRIT(
  tableId: string,
  response: 'accept' | 'decline'
): Promise<ActionResult & { status?: string }> {
  try {
    const headers = await getAuthHeaders();
    const resp = await fetch(`${GAME_SERVER_URL}/rit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, response }),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return await resp.json();
  } catch (err: unknown) {
    console.error('[GameServerAPI] RIT response failed:', err);
    return { success: false, error: 'Server unreachable' };
  }
}

/**
 * Bible V8 §4.19: Respond to an insurance offer.
 * @param response - 'accept' or 'decline'
 */
export async function respondToInsurance(
  tableId: string,
  response: 'accept' | 'decline'
): Promise<ActionResult & { status?: string }> {
  try {
    const headers = await getAuthHeaders();
    const resp = await fetch(`${GAME_SERVER_URL}/insurance`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tableId, response }),
    });
    if (!resp.ok) return { success: false, error: `Server error (${resp.status})` };
    return await resp.json();
  } catch (err: unknown) {
    console.error('[GameServerAPI] Insurance response failed:', err);
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
    console.error('[GameServerAPI] Show hand failed:', err);
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
  showHand,
  connectTableWebSocket,
  disconnectTableWebSocket,
  getWebSocketStatus,
};
