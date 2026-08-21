/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DISCONNECT ENGINE — Player Timeout & Reconnection Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages player disconnect detection and automated responses:
 * - Per-player disconnect timer (configurable, default 30s)
 * - Auto-fold on timeout (auto-check if free action available)
 * - Reconnection state recovery
 * - Integration with ServerTableEngine via turn-change hook
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/DisconnectEngine.ts
 * Server adaptation: No masterBus — uses injected PreciseActionTimer + callbacks.
 */

import { PreciseActionTimer } from './PreciseActionTimer.js';
import { reportError } from '../services/errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DisconnectConfig {
  /** Seconds before auto-action on disconnect (default: 30) */
  disconnectTimeoutSeconds: number;
  /** Number of consecutive timeouts before auto-sit-out (default: 3) */
  maxConsecutiveTimeouts: number;
  /** If true, auto-check when possible instead of auto-fold (default: true) */
  preferCheckOverFold: boolean;
  /** Grace period in seconds for reconnection after timeout (default: 5) */
  reconnectGraceSeconds: number;
}

export interface PlayerConnectionState {
  playerId: string;
  tableId: string;
  isConnected: boolean;
  lastHeartbeat: number;
  consecutiveTimeouts: number;
  isSittingOut: boolean;
  /**
   * Dan 2026-08-21: epoch ms the CURRENT sit-out began, or null when in the
   * game. Drives the 5-minute half of "removed after the button passes them
   * twice OR after 5 minutes, whichever happens first". Keyed per
   * (table, player) so sitting out here never touches other tables.
   */
  sitOutSince?: number | null;
  /** Hands dealt at this table since the sit-out began (button-pass proxy). */
  sitOutOrbits?: number;
  /** Timestamp when disconnect was detected */
  disconnectedAt?: number;
  /** Timestamp when player reconnected (for grace period tracking — Bible V8 §6.3) */
  reconnectedAt?: number;
  /**
   * Phase 1.2 PR-E: formal FSM state for persistence + client UX.
   *   CONNECTED    — WS alive, heartbeat fresh
   *   MISSING      — WS dropped, still within grace window
   *   DISCONNECTED — grace exhausted, no turn clock
   *   SAT_OUT      — explicit sit-out
   * Derived from isConnected + isSittingOut + disconnectedAt at read time
   * (see getFsmState / getFsmStatesForTable). We do NOT add a standalone
   * field because every existing code path already sets the booleans; the
   * FSM is just a named projection.
   */
}

/** Phase 1.2 PR-E: FSM state label. Mirrors supabase DisconnectFsmState. */
export type DisconnectFsmState = 'CONNECTED' | 'MISSING' | 'DISCONNECTED' | 'SAT_OUT';

export interface DisconnectFsmEntry {
  state: DisconnectFsmState;
  sinceMs: number;
  graceDeadlineMs: number | null;
}

export interface DisconnectAction {
  playerId: string;
  tableId: string;
  action: 'fold' | 'check';
  reason: 'timeout' | 'sitting_out';
}

export type DisconnectEventType =
  | 'PLAYER_DISCONNECTED'
  | 'PLAYER_RECONNECTED'
  | 'PLAYER_TIMED_OUT'
  | 'PLAYER_SAT_OUT'
  | 'PLAYER_SAT_BACK'
  | 'DISCONNECT_TIMER_STARTED';

export interface DisconnectEvent {
  type: DisconnectEventType;
  tableId: string;
  playerId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCONNECT ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class DisconnectEngine {
  /** Sit-out eviction limits (Dan 2026-08-21): button passes, then minutes. */
  static readonly SITOUT_MAX_ORBITS = 2;
  static readonly SITOUT_MAX_MS = 5 * 60 * 1000;

  private tableConfigs: Map<string, DisconnectConfig> = new Map();
  private playerStates: Map<string, PlayerConnectionState> = new Map();
  private actionCallbacks: Map<string, (action: DisconnectAction) => void> = new Map();
  private preciseTimer: PreciseActionTimer;
  private onEvent?: (event: DisconnectEvent) => void;

  private readonly DEFAULT_CONFIG: DisconnectConfig = {
    disconnectTimeoutSeconds: 30,
    maxConsecutiveTimeouts: 3,
    preferCheckOverFold: true,
    reconnectGraceSeconds: 5,
  };

  constructor(preciseTimer: PreciseActionTimer, onEvent?: (event: DisconnectEvent) => void) {
    this.preciseTimer = preciseTimer;
    this.onEvent = onEvent;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Configure disconnect handling for a table
   */
  configure(tableId: string, config: Partial<DisconnectConfig>): void {
    this.tableConfigs.set(tableId, { ...this.DEFAULT_CONFIG, ...config });
  }

  /**
   * Register a callback for when an auto-action should be performed.
   * Called by ServerTableEngine to wire disconnect actions into the hand.
   */
  onAutoAction(tableId: string, callback: (action: DisconnectAction) => void): void {
    this.actionCallbacks.set(tableId, callback);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a player at a table for disconnect tracking
   */
  registerPlayer(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    this.playerStates.set(key, {
      playerId,
      tableId,
      isConnected: true,
      lastHeartbeat: Date.now(),
      consecutiveTimeouts: 0,
      isSittingOut: false,
      sitOutSince: null,
      sitOutOrbits: 0,
    });
  }

  /**
   * Remove a player from disconnect tracking (left table)
   */
  unregisterPlayer(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    this.preciseTimer.cancelTimer(tableId, `disconnect:${playerId}`);
    this.playerStates.delete(key);
  }

  /**
   * Process a heartbeat from a connected player.
   * Should be called periodically (e.g., every 5s via WebSocket ping).
   */
  heartbeat(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state) return;

    const wasDisconnected = !state.isConnected;
    state.isConnected = true;
    state.lastHeartbeat = Date.now();

    if (wasDisconnected) {
      state.disconnectedAt = undefined;
      state.consecutiveTimeouts = 0;
      // Bible V8 §6.3: Track reconnect time for grace period (5s before auto-action)
      state.reconnectedAt = Date.now();

      // Cancel the disconnect timeout timer — player is back
      this.preciseTimer.cancelTimer(tableId, `disconnect:${playerId}`);

      this.emitEvent({
        type: 'PLAYER_RECONNECTED',
        tableId,
        playerId,
      });
    }
  }

  /**
   * Mark a player as disconnected.
   * Called when WebSocket connection drops or heartbeat times out.
   */
  markDisconnected(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state || !state.isConnected) return;

    state.isConnected = false;
    state.disconnectedAt = Date.now();

    this.emitEvent({
      type: 'PLAYER_DISCONNECTED',
      tableId,
      playerId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEARTBEAT STALENESS CHECK (Bible V8 §6.3)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check all players at a table for stale heartbeats and mark them as disconnected.
   * Should be called periodically by ServerTableEngine (e.g., every 10s or before each hand).
   * Bible V8 §6.3: "Disconnect detected: no heartbeat for disconnect_timeout_seconds"
   */
  checkStaleHeartbeats(tableId: string): void {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    const now = Date.now();
    const timeoutMs = config.disconnectTimeoutSeconds * 1000;

    for (const [key, state] of this.playerStates) {
      if (!key.startsWith(`${tableId}:`)) continue;
      if (!state.isConnected) continue; // Already marked disconnected

      if (now - state.lastHeartbeat > timeoutMs) {
        this.markDisconnected(tableId, state.playerId);
      }
    }
  }

  /**
   * Bible V8 §6.3: Check if player is within reconnect grace period.
   * Returns true if the player recently reconnected and should be given extra time.
   */
  isInReconnectGrace(tableId: string, playerId: string): boolean {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state || !state.reconnectedAt) return false;
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    return Date.now() - state.reconnectedAt < config.reconnectGraceSeconds * 1000;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TURN MANAGEMENT (called by ServerTableEngine)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when it becomes a player's turn to act.
   * If the player is disconnected, starts the timeout countdown.
   *
   * @param canCheck - Whether the player can check (no outstanding bet)
   * @returns true if player is connected and can act normally
   */
  onPlayerTurn(tableId: string, playerId: string, canCheck: boolean): boolean {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;

    if (!state) return true; // Untracked player — let them act

    // Player is sitting out — auto-fold immediately
    if (state.isSittingOut) {
      this.executeAutoAction(tableId, playerId, canCheck, 'sitting_out');
      return false;
    }

    // Player is connected — they can act normally
    if (state.isConnected) {
      this.preciseTimer.cancelTimer(tableId, `disconnect:${playerId}`);
      return true;
    }

    // Player is disconnected — start timeout countdown
    this.startTimeoutCountdown(tableId, playerId, canCheck, config);
    return false;
  }

  /**
   * Cancel any active timeout for a player (e.g., they reconnected and acted)
   */
  cancelTimeout(tableId: string, playerId: string): void {
    this.preciseTimer.cancelTimer(tableId, `disconnect:${playerId}`);
  }

  /**
   * AUDIT FIX 2026-07-19: a CONNECTED player who lets the action timer expire
   * (app open but AFK) was never counted toward auto-sit-out — only the
   * disconnect path incremented consecutiveTimeouts — so an AFK player sat at
   * the table forever, posting blinds and stalling every hand. Call this from
   * the connected-player timer-expiry path so the same cap applies to everyone.
   */
  recordConnectedTimeout(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state) return;
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    state.consecutiveTimeouts++;
    if (state.consecutiveTimeouts >= config.maxConsecutiveTimeouts) {
      this.sitOut(tableId, playerId, 'forced');
    }
  }

  /** A player acted voluntarily — clear their consecutive-timeout streak. */
  recordPlayerActed(tableId: string, playerId: string): void {
    const state = this.playerStates.get(`${tableId}:${playerId}`);
    if (state) state.consecutiveTimeouts = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIT OUT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Player requests to sit out (voluntary or forced by consecutive timeouts)
   */
  sitOut(tableId: string, playerId: string, reason: 'voluntary' | 'forced' = 'voluntary'): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state) return;

    // Stamp the clock only on the TRANSITION into sitting out, so a repeated
    // sitOut() call cannot keep resetting the 5-minute eviction window.
    if (!state.isSittingOut) {
      state.sitOutSince = Date.now();
      state.sitOutOrbits = 0;
    }
    state.isSittingOut = true;

    this.emitEvent({
      type: 'PLAYER_SAT_OUT',
      tableId,
      playerId,
      reason,
      consecutiveTimeouts: state.consecutiveTimeouts,
    });
  }

  /**
   * Player returns from sitting out
   */
  sitBack(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state) return;

    state.isSittingOut = false;
    state.consecutiveTimeouts = 0;
    state.sitOutSince = null;
    state.sitOutOrbits = 0;

    this.emitEvent({
      type: 'PLAYER_SAT_BACK',
      tableId,
      playerId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  isConnected(tableId: string, playerId: string): boolean {
    const key = `${tableId}:${playerId}`;
    return this.playerStates.get(key)?.isConnected ?? true;
  }

  /**
   * Dan 2026-08-21, BINDING: "IF A PLAYER IS SITTING OUT THEY MUST BE REMOVED
   * AFTER THE BUTTON PASSES THEM TWICE, OR AFTER 5 MINUTES, WHICHEVER HAPPENS
   * FIRST." Called once per hand start with the players seated at THIS table.
   */
  tickSitOutsAndCollectEvictions(tableId: string, playerIds: string[]): string[] {
    const evict: string[] = [];
    const now = Date.now();
    for (const playerId of playerIds) {
      const state = this.playerStates.get(`${tableId}:${playerId}`);
      if (!state || !state.isSittingOut) continue;
      state.sitOutOrbits = (state.sitOutOrbits ?? 0) + 1;
      const orbitsUp = (state.sitOutOrbits ?? 0) > DisconnectEngine.SITOUT_MAX_ORBITS;
      const timeUp =
        state.sitOutSince != null && now - state.sitOutSince >= DisconnectEngine.SITOUT_MAX_MS;
      if (orbitsUp || timeUp) evict.push(playerId);
    }
    return evict;
  }

  isSittingOut(tableId: string, playerId: string): boolean {
    const key = `${tableId}:${playerId}`;
    return this.playerStates.get(key)?.isSittingOut ?? false;
  }

  getState(tableId: string, playerId: string): PlayerConnectionState | null {
    const key = `${tableId}:${playerId}`;
    return this.playerStates.get(key) ?? null;
  }

  getConnectedPlayers(tableId: string): string[] {
    const connected: string[] = [];
    for (const [key, state] of this.playerStates) {
      if (key.startsWith(`${tableId}:`) && state.isConnected && !state.isSittingOut) {
        connected.push(state.playerId);
      }
    }
    return connected;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Remove all state for a table
   */
  dispose(tableId: string): void {
    for (const [key, state] of this.playerStates) {
      if (key.startsWith(`${tableId}:`)) {
        this.preciseTimer.cancelTimer(tableId, `disconnect:${state.playerId}`);
        this.playerStates.delete(key);
      }
    }
    this.tableConfigs.delete(tableId);
    this.actionCallbacks.delete(tableId);
  }

  disposeAll(): void {
    this.playerStates.clear();
    this.tableConfigs.clear();
    this.actionCallbacks.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1.2 PR-E: FSM state projection for snapshot persistence + UI
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Derive the FSM state for a single player.
   * Rules:
   *   isSittingOut                       -> SAT_OUT
   *   isConnected                        -> CONNECTED
   *   !isConnected, within grace         -> MISSING
   *   !isConnected, grace exhausted      -> DISCONNECTED
   *
   * Grace window = disconnectTimeoutSeconds from disconnectedAt (same window
   * used by the auto-fold countdown).
   */
  getFsmState(tableId: string, playerId: string): DisconnectFsmEntry | null {
    const key = `${tableId}:${playerId}`;
    const s = this.playerStates.get(key);
    if (!s) return null;
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;

    if (s.isSittingOut) {
      return { state: 'SAT_OUT', sinceMs: s.lastHeartbeat, graceDeadlineMs: null };
    }
    if (s.isConnected) {
      return { state: 'CONNECTED', sinceMs: s.lastHeartbeat, graceDeadlineMs: null };
    }
    const dAt = s.disconnectedAt ?? s.lastHeartbeat;
    const graceDeadlineMs = dAt + config.disconnectTimeoutSeconds * 1000;
    if (Date.now() < graceDeadlineMs) {
      return { state: 'MISSING', sinceMs: dAt, graceDeadlineMs };
    }
    return { state: 'DISCONNECTED', sinceMs: dAt, graceDeadlineMs };
  }

  /**
   * Get the full per-user FSM map for a table in the shape
   * hand_state_snapshots.disconnect_states expects. Used by
   * ServerTableEngine to persist alongside pending_deadlines.
   */
  getFsmStatesForTable(tableId: string): Record<string, DisconnectFsmEntry> {
    const out: Record<string, DisconnectFsmEntry> = {};
    for (const [key, s] of this.playerStates) {
      if (!key.startsWith(`${tableId}:`)) continue;
      const fsm = this.getFsmState(tableId, s.playerId);
      if (fsm) out[s.playerId] = fsm;
    }
    return out;
  }

  /**
   * B10 FIX (2026-08-20): restore the FSM from a persisted snapshot.
   *
   * getFsmStatesForTable has been writing disconnect_states into every hand
   * snapshot for a long time, and nothing ever read it back — the engine
   * restarted believing every seated player was CONNECTED. That is not
   * cosmetic: a player who dropped before the crash then got a full turn clock
   * on every orbit after it, so each absent seat cost the table its entire
   * think-time before auto-folding, on every hand, until the heartbeat checker
   * noticed them missing again.
   *
   * Restoring the projection is safe in a way that resuming the HAND is not:
   * these entries describe a player's connectivity, which survives the process
   * that observed it, and any player who is genuinely back re-registers on
   * their next heartbeat within seconds.
   *
   * SAT_OUT and CONNECTED are seeded as-is. MISSING/DISCONNECTED are seeded
   * with their original disconnectedAt, so the grace window continues from when
   * the player actually dropped rather than restarting from the crash — a
   * restart must not hand an absent player a fresh grace period.
   */
  restoreFsmStates(tableId: string, states: Record<string, DisconnectFsmEntry>): number {
    let restored = 0;
    for (const [playerId, entry] of Object.entries(states || {})) {
      if (!entry || !entry.state) continue;
      const key = `${tableId}:${playerId}`;
      // Never clobber live state: if this player has already been registered
      // (they reconnected during startup) the fresh observation wins.
      if (this.playerStates.has(key)) continue;

      const connected = entry.state === 'CONNECTED';
      const sittingOut = entry.state === 'SAT_OUT';
      this.playerStates.set(key, {
        playerId,
        tableId,
        isConnected: connected || sittingOut,
        lastHeartbeat: entry.sinceMs || Date.now(),
        consecutiveTimeouts: 0,
        isSittingOut: sittingOut,
        disconnectedAt: connected || sittingOut ? undefined : entry.sinceMs || Date.now(),
      });
      restored++;
    }
    return restored;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private startTimeoutCountdown(
    tableId: string,
    playerId: string,
    canCheck: boolean,
    config: DisconnectConfig
  ): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state) return;

    this.emitEvent({
      type: 'DISCONNECT_TIMER_STARTED',
      tableId,
      playerId,
      timeoutSeconds: config.disconnectTimeoutSeconds,
    });

    // Use PreciseActionTimer for the countdown (deadline-based, drift-immune)
    const durationMs = config.disconnectTimeoutSeconds * 1000;
    this.preciseTimer.startTimer(tableId, `disconnect:${playerId}`, durationMs, () => {
      // Check if player reconnected during the countdown
      if (state.isConnected) return;

      this.executeAutoAction(tableId, playerId, canCheck, 'timeout');
    });
  }

  private executeAutoAction(
    tableId: string,
    playerId: string,
    canCheck: boolean,
    reason: 'timeout' | 'sitting_out'
  ): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;

    const action: 'fold' | 'check' = canCheck && config.preferCheckOverFold ? 'check' : 'fold';

    if (state && reason === 'timeout') {
      state.consecutiveTimeouts++;

      // Auto sit-out after too many consecutive timeouts
      if (state.consecutiveTimeouts >= config.maxConsecutiveTimeouts) {
        this.sitOut(tableId, playerId, 'forced');
      }
    }

    const disconnectAction: DisconnectAction = {
      playerId,
      tableId,
      action,
      reason,
    };

    this.emitEvent({
      type: 'PLAYER_TIMED_OUT',
      tableId,
      playerId,
      action,
      reason,
      consecutiveTimeouts: state?.consecutiveTimeouts ?? 0,
    });

    // Execute the callback to perform the action in the hand
    const callback = this.actionCallbacks.get(tableId);
    if (callback) {
      callback(disconnectAction);
    }
  }

  private emitEvent(event: DisconnectEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'DisconnectEngine.Event_handler_error');
      }
    }
  }
}
