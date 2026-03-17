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

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// Server URL — Fly.io for production, localhost for development.
// CRITICAL FIX: The old fallback was 'http://localhost:8080' which silently broke ALL
// poker actions in production (fold/call/raise/check/all-in hit localhost and failed,
// but the .catch(() => {}) in TablePage swallowed every error).
const GAME_SERVER_URL =
  import.meta.env.VITE_GAME_SERVER_URL ||
  (import.meta.env.PROD ? 'https://smarter-poker-game-server.fly.dev' : 'http://localhost:8080');

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
    const response = await fetch(`${GAME_SERVER_URL}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, userId, action, amount }),
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
    const response = await fetch(`${GAME_SERVER_URL}/timebank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, userId }),
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
    const response = await fetch(`${GAME_SERVER_URL}/actions/${tableId}/${userId}`);

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
  connectTableWebSocket,
  disconnectTableWebSocket,
  getWebSocketStatus,
};
