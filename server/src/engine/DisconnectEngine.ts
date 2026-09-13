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

import { reconnectProtectionSeconds, type ReconnectMembership } from './reconnectProtection.js';
import { thawTableReconnectClock } from '../maintenance/reconnectFreeze.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { sitOutAutoActionDelayMs } from './sitOutBeat.js';
import { reportError } from '../services/errorReporter.js';
import * as EngineMetrics from '../observability/engineInstruments.js';

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
  reconnectMembership?: ReconnectMembership;
  reconnectDeadlineMs?: number;
  reconnectGrantedAtMs?: number;
  reconnectThawedAtMs?: number;
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
  /**
   * 2026-09-04 (disconnect audit item 3): WHY the current sit-out began.
   * 'forced' is three consecutive timeouts; 'voluntary' is the player's own
   * Sit Out. The client shows a different sentence for each; until today it
   * could not tell them apart and told a player who never chose to sit out
   * that they were "sitting out".
   */
  sitOutReason?: 'voluntary' | 'forced' | null;
  /**
   * Dan 2026-08-23: BLIND CAP WHILE AWAY.
   * "You can't keep blinding out a player who has disconnected." An away
   * player at a CASH table may be charged at most one small blind and one
   * big blind. Once both have been taken they are stood up and cashed out.
   * Each flag is set the first time that blind is charged while away, and
   * both are cleared the moment the player proves they are back (heartbeat
   * reconnect, sit-in, or a voluntary action).
   */
  awayBlindSbCharged?: boolean;
  awayBlindBbCharged?: boolean;
  /**
   * Epoch ms the client reported it was leaving the page/app (pagehide, tab
   * close, app backgrounded past freeze). Treated as away IMMEDIATELY — no
   * transport grace — because the client is telling us rather than us
   * inferring it from silence. Cleared on the next heartbeat.
   */
  pageLeftAt?: number | null;
  /* ═══ THE SILENT-CLIENT CANARY (Dan 2026-08-31, phase 2) ══════════════════
     Three counters that together separate "a player wandered off" from "a
     player's client is broken" — which the auto-sit-out ladder cannot tell
     apart, and therefore punishes identically.

     On 2026-08-31 a player sat in seat 7 of a 9-max table and his own client
     erased him from his screen. From in here it was indistinguishable from
     AFK: the heartbeat kept landing, the turn timer kept expiring, three
     strikes forced a sit-out and the five-minute clock took the seat. He was
     at his desk the whole time, looking at a table that would not show him
     his cards.

     The tell is the COMBINATION, and a genuine AFK human almost never
     produces it: heartbeat healthy, turns offered, and NOT ONE voluntary
     action, ever, at this table. Somebody who plays and then walks away has
     acted at least once. Somebody whose client cannot show them the action
     never does.

     NO HORSE BRANCH, DELIBERATELY. A horse acts through the same
     `performAction` path as anybody else (HorseLogic -> scheduleHorseAction
     -> performAction -> recordPlayerActed), so it sets `everActed` on its
     first decision and can never trip this. The signal is BEHAVIOURAL rather
     than an identity test, which is why the HORSES ARE PLAYERS law needs no
     exemption here: a horse is measured by exactly the same yardstick as a
     human, and passes it for exactly the same reason. */

  /** True once this player has taken any voluntary action at this table. */
  everActed?: boolean;
  /** How many times the action has legitimately reached this player here. */
  turnsOffered?: number;
  /**
   * Epoch ms the CLIENT last confirmed it rendered a turn to the human
   * (optional; only newer clients send it). Present means the action bar
   * genuinely reached a screen, which sharpens the canary from "never acted"
   * to "never even saw it" — the difference between an absent player and a
   * broken one. Absent on older clients, so it is never required.
   */
  lastTurnRenderedAt?: number | null;
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
  reconnectDeadlineMs?: number;
  reconnectGrantedAtMs?: number;
  reconnectThawedAtMs?: number;
  /* ═══ 2026-09-04 (disconnect audit items 2, 3, 4): THE ENTRY CARRIES WHAT
     THE RESTORE NEEDS. Until today it was three fields, `sinceMs` was
     `lastHeartbeat` for a sat-out player (so a restore reset their 5-minute
     eviction clock to the moment of the crash), and the strike count, the
     away-blind budget, the sit-out reason and the /away stamp were dropped
     on every restart. All optional: an older snapshot without them restores
     exactly as it did before. */
  /** Epoch ms the CURRENT sit-out began (SAT_OUT only). */
  sitOutSinceMs?: number | null;
  sitOutOrbits?: number;
  sitOutReason?: 'voluntary' | 'forced' | null;
  /** consecutiveTimeouts - the strikes toward a forced sit-out. */
  strikes?: number;
  awayBlindSbCharged?: boolean;
  awayBlindBbCharged?: boolean;
  pageLeftAtMs?: number | null;
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
  /**
   * Dan 2026-08-23, BINDING: an AWAY player at a cash table pays at most ONE
   * small blind and ONE big blind, then is removed. Sit-out already costs
   * nothing (a sat-out cash player is not dealt in at all) — this closes the
   * other door, the window between "went away" and "auto-sat-out after
   * `maxConsecutiveTimeouts` strikes", which is the only place a disconnected
   * player's stack could be ground down.
   *
   * How many consecutive action-clock expiries make a CONNECTED player count
   * as away. Not 1: letting one clock run out is something present players do
   * — a deep tank, a misclick, a two-second lag spike — and treating it as
   * absence would start charging blinds against somebody sitting right there.
   * Two in a row with no voluntary action between them (any action resets the
   * streak) is nobody home. The third strike force-sits them out anyway, at
   * which point they stop being dealt in and pay nothing more regardless.
   */
  static readonly AFK_AWAY_MIN_STRIKES = 2;

  private tableConfigs: Map<string, DisconnectConfig> = new Map();
  private playerStates: Map<string, PlayerConnectionState> = new Map();

  /**
   * ── The false disconnect alarm (2026-08-22) ──
   *
   * A player has TWO independent transports to this table: the websocket, and
   * the HTTP heartbeat their client posts every 5s. The websocket close is the
   * fast signal — round 2 wired it up precisely so a player who closes their
   * tab starts the auto-action ladder in milliseconds instead of waiting out
   * the 30s stale-heartbeat sweep.
   *
   * But it fired on the socket dying, not on the PLAYER being gone. A websocket
   * blip on a player whose heartbeat is landing normally marked them
   * disconnected, and their next heartbeat — at most 5s later — marked them
   * back. That pair is not a log line. On the client it is
   * `ConnectionHUD`: the disconnect warning banner, `soundService.playDisconnect()`,
   * a double haptic buzz, then a reconnect sound, another buzz, a "Connection
   * restored" toast and a stale-data banner. A jarring false alarm, mid-hand,
   * for somebody who never lost their connection.
   *
   * So the websocket close now opens a short window instead of concluding.
   * Anything from EITHER transport inside it cancels the conclusion. Nothing
   * from either, and the player really is gone — marked at 8s, still four
   * times faster than the sweep it replaced.
   *
   * These timers live here rather than on PreciseActionTimer deliberately:
   * transport presence is a property of the PLAYER, not of a hand, and the
   * namespaced countdowns on PreciseActionTimer are cancelled at every hand
   * boundary.
   */
  private transportGraceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Just over the client's 5s heartbeat period, so one missed beat is forgiven. */
  private static readonly TRANSPORT_GRACE_MS = 8_000;
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
    // Owner directive: game and table settings cannot alter disconnect protection.
    void config;
    this.tableConfigs.set(tableId, { ...this.DEFAULT_CONFIG });
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
   * Register a player at a table for disconnect tracking.
   *
   * IDEMPOTENT (2026-08-22): this is called for every dealt-in player at the
   * start of EVERY hand. It used to unconditionally re-create the state, which
   * wiped isConnected/isSittingOut/consecutiveTimeouts/sitOut* each hand and
   * silently disabled the entire auto-sit-out ladder (an AFK player was never
   * sat out, and a sat-out tournament player burned the full clock every
   * orbit). Now: create only when absent; an existing player keeps all
   * accumulated disconnect/sit-out/strike state across hands.
   */
  registerPlayer(tableId: string, playerId: string, membership?: ReconnectMembership): void {
    const key = `${tableId}:${playerId}`;
    const existing = this.playerStates.get(key);
    if (existing) {
      if (membership) existing.reconnectMembership = { ...membership };
      return;
    }
    this.playerStates.set(key, {
      reconnectMembership: membership ? { ...membership } : undefined,
      playerId,
      tableId,
      isConnected: true,
      lastHeartbeat: Date.now(),
      consecutiveTimeouts: 0,
      isSittingOut: false,
      sitOutSince: null,
      sitOutOrbits: 0,
      awayBlindSbCharged: false,
      awayBlindBbCharged: false,
      pageLeftAt: null,
      // Phase 2 canary. Seeded here so "never acted" is a fact about THIS
      // seat at THIS table, reset when the seat is released and re-taken.
      everActed: false,
      turnsOffered: 0,
      lastTurnRenderedAt: null,
    });
  }

  /**
   * Remove a player from disconnect tracking (left table)
   */
  unregisterPlayer(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    this.preciseTimer.cancelTimer(tableId, `disconnect:${playerId}`);
    this.cancelTransportGrace(key);
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

    // Proof of life from the other transport. Cancel any open websocket window
    // BEFORE it can conclude — this is the line that removes the false alarm.
    this.cancelTransportGrace(key);

    const wasDisconnected = !state.isConnected;
    state.isConnected = true;
    state.lastHeartbeat = Date.now();
    // Dan 2026-08-23: a beat is proof the page/app is back. Clear the
    // page-left flag unconditionally (not only on the wasDisconnected edge) —
    // a pagehide followed by a resume never opened a disconnect, so there is
    // no edge to hang the reset on, and a stale flag would keep charging
    // away-blinds against a player who is sitting right there.
    state.pageLeftAt = null;

    if (wasDisconnected) {
      state.disconnectedAt = undefined;
      /* A HEARTBEAT IS PROOF OF A SOCKET, NOT PROOF OF A PLAYER (2026-09-09).

         This branch used to clear `consecutiveTimeouts` and both
         `awayBlind*Charged` flags on every reconnect EDGE, on the reasoning
         that "the blind cap is a budget for ONE absence - they came back".

         A backgrounded mobile client produces one of those edges per orbit.
         The socket dies when the tab is frozen, a beat lands when the OS wakes
         it, and neither event involves the person: the ladder was zeroed
         several times an hour, `maxConsecutiveTimeouts = 3` was never reached,
         and `awayBlindSbCharged && awayBlindBbCharged` - the away-blind
         eviction budget - could never both be true at once. The seat was
         auto-folded every single hand, for ever, was never sat out, never
         evicted, and kept posting blinds while every other seat waited out the
         full clock. That is precisely the symptom the AUDIT FIX 2026-07-19
         note under recordConnectedTimeout says was closed, re-opened by the
         one path that resets the counter it depends on.

         Both budgets are spent by ABSENCE and refunded by PRESENCE, and only a
         voluntary action proves presence. `recordPlayerActed` clears all three
         (and says why), and so does `sitBack`. Nothing here does any more. */
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
  /**
   * A player's LAST websocket for this table closed. See transportGraceTimers.
   *
   * This does NOT mark them disconnected. It starts a short window; a heartbeat
   * or a new socket inside it cancels the whole thing and nothing is ever
   * emitted, so a blip costs the player nothing at all.
   */
  markTransportGone(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state || !state.isConnected) return;
    if (this.transportGraceTimers.has(key)) return; // window already open

    const timer = setTimeout(() => {
      this.transportGraceTimers.delete(key);
      const current = this.playerStates.get(key);
      if (!current || !current.isConnected) return;
      // Defence in depth: heartbeat() cancels this timer, so reaching here with
      // a fresh beat should be impossible. Standing down is the safe way to be
      // wrong — a false disconnect is felt by the player, a late one is not.
      if (Date.now() - current.lastHeartbeat < DisconnectEngine.TRANSPORT_GRACE_MS) return;
      this.markDisconnected(tableId, playerId);
    }, DisconnectEngine.TRANSPORT_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.transportGraceTimers.set(key, timer);
  }

  /** Close the transport window: the player proved they are still here. */
  private cancelTransportGrace(key: string): void {
    const timer = this.transportGraceTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.transportGraceTimers.delete(key);
  }

  markDisconnected(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    // Whoever concluded first wins; a pending window has nothing left to decide.
    this.cancelTransportGrace(key);
    const state = this.playerStates.get(key);
    if (!state || !state.isConnected) return;

    state.isConnected = false;
    state.disconnectedAt = Date.now();
    // A heartbeat alone does not replenish the allowance. A voluntary action does.
    if (state.reconnectDeadlineMs === undefined) {
      state.reconnectGrantedAtMs = state.disconnectedAt;
      state.reconnectDeadlineMs =
        state.disconnectedAt + reconnectProtectionSeconds(state.reconnectMembership ?? {}) * 1000;
    }

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

    // Player is sitting out - auto-act, on the same beat as every other seat.
    //
    // 2026-09-01: this used to call executeAutoAction() straight from here, at
    // zero milliseconds, while a horse floors at 350/1250 ms and a pre-action
    // waits 900. Heads-up against a disconnected opponent that resolved every
    // hand at machine speed. See engine/sitOutBeat.ts for why the rhythm is
    // part of the treatment and not a detail.
    //
    // The caller already reads `false` as "DisconnectEngine will handle the
    // auto-action via callback", so deferring changes nothing for it, and the
    // timer is keyed `disconnect:<playerId>` like the timeout countdown - so
    // cancelTimeout and cancelAllCountdowns already reach it, and a beat can
    // never leak past the hand boundary.
    if (state.isSittingOut) {
      this.scheduleSitOutAutoAction(tableId, playerId, canCheck);
      return false;
    }

    /* Phase 2 canary: the action genuinely reached this player. Counted AFTER
       the sit-out branch above, because a sat-out seat is auto-folded rather
       than offered anything — counting it there would make a sat-out player
       look like somebody being ignored by their own client. */
    state.turnsOffered = (state.turnsOffered ?? 0) + 1;

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
   * THE CLOCK THE ENGINE ACTUALLY ARMED for a seat onPlayerTurn declined to
   * hand the turn to (2026-09-04, disconnect audit item 1).
   *
   * When onPlayerTurn returns false it has scheduled one of two things under
   * `disconnect:<playerId>`: the 30s timeout countdown for a MISSING seat, or
   * the 350/1250ms beat for a sat-out one. Until today the engine broadcast
   * neither - ServerTableEngineHandEvents had already stamped the ordinary
   * 15s deadline before handleTurnChange ran, so every client drew a full
   * 15s ring for a seat the engine would act for in 1s, or watched the ring
   * hit zero and then waited another 15s for the 30s clock. The table looked
   * hung for the difference. This returns the real deadline so the caller can
   * re-stamp the published one; 0 when nothing is armed.
   */
  armedAutoActionDeadlineMs(tableId: string, playerId: string): number {
    return this.preciseTimer.getDeadline(tableId, `disconnect:${playerId}`) || 0;
  }

  /**
   * Cancel any active timeout for a player (e.g., they reconnected and acted)
   */
  cancelTimeout(tableId: string, playerId: string): void {
    this.preciseTimer.cancelTimer(tableId, `disconnect:${playerId}`);
  }

  /**
   * HAND-BOUNDARY CLEANUP (2026-08-22 review): cancel every pending
   * disconnect countdown for the table WITHOUT touching connection or strike
   * state. Called at HAND_COMPLETE. A countdown that leaks across the hand
   * boundary fires up to 30s into the NEXT hand and increments the player's
   * consecutiveTimeouts (the strike mutation happens before the engine's
   * seat guard) — with idempotent registerPlayer that now compounds into a
   * premature forced sit-out.
   */
  cancelAllCountdowns(tableId: string): void {
    for (const [key, state] of this.playerStates) {
      if (!key.startsWith(`${tableId}:`)) continue;
      this.preciseTimer.cancelTimer(tableId, `disconnect:${state.playerId}`);
      /* THE PROTECTION DEADLINE IS SPENT ON THE HAND IT WAS GRANTED FOR
         (2026-09-09). `reconnectDeadlineMs` is an ABSOLUTE instant, granted
         once by markDisconnected and - until today - cleared in exactly one
         place, recordPlayerActed. heartbeat() does not clear it, and
         markDisconnected refuses to re-grant while it is set, so a player who
         dropped and came back WITHOUT taking a voluntary action (they returned
         between hands, or the seat folded/checked automatically while they were
         away) carried the already-expired instant into every later hand.

         ServerTableEngineTurns then reads it on the reconnect path, sees
         `protection <= Date.now()`, and force-resolves the seat the moment the
         socket comes back - a fold, on a hand the player is present for, with
         the full action clock unspent. The absence was over hands ago; the
         paperwork was not.

         A completed hand ends the decision the grant was protecting, so the
         grant ends with it - but only for a seat that is actually BACK. A
         player still disconnected at the hand boundary is mid-absence and must
         keep counting down the window they were given, or the ladder restarts
         from zero every hand and the seat is protected for ever. */
      if (state.isConnected === true) {
        state.reconnectDeadlineMs = undefined;
        state.reconnectGrantedAtMs = undefined;
      }
    }
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
      /* PHASE 2 CANARY — fired BEFORE the sit-out, while the evidence is
         still assembled. This is the exact moment the 2026-08-31 seat-7
         player was condemned, and the exact moment nobody was told. */
      this.reportSuspectedSilentClient(tableId, playerId, state);
      this.sitOut(tableId, playerId, 'forced');
    }
  }

  /** A player acted voluntarily — clear their consecutive-timeout streak. */
  recordPlayerActed(tableId: string, playerId: string): void {
    const state = this.playerStates.get(`${tableId}:${playerId}`);
    if (!state) return;
    state.consecutiveTimeouts = 0;
    state.reconnectDeadlineMs = undefined;
    state.reconnectGrantedAtMs = undefined;
    // A deliberate action is the strongest possible proof of presence — it
    // outranks a missing heartbeat. Clear the away-blind budget with it.
    state.awayBlindSbCharged = false;
    state.awayBlindBbCharged = false;
    state.pageLeftAt = null;
    /* Phase 2 canary: one action, ever, is enough to prove the client can
       show this player the game. It is never unset while the seat is held —
       a player who plays and THEN goes AFK is an ordinary AFK, and the canary
       must not accuse their client of being broken. */
    state.everActed = true;
  }

  /**
   * IS THIS A PLAYER WHO LEFT, OR A PLAYER WHOSE CLIENT IS BROKEN?
   * (Dan 2026-08-31, phase 2 — the silent-client canary)
   *
   * Called at the instant the consecutive-timeout ladder decides to force a
   * sit-out, which is the last moment anybody could still tell the difference.
   * Returns the verdict rather than only logging it, so tests can assert on it
   * and callers can act on it later without re-deriving the rule.
   *
   * The fingerprint of a BROKEN CLIENT, all three at once:
   *   - the heartbeat is landing, so the app is open and the network is fine;
   *   - the action reached this seat at least as many times as the strike cap,
   *     so they were genuinely given the chance;
   *   - and they have never once acted here. Not "not lately" — NEVER.
   *
   * A real AFK human breaks the third condition almost every time: they sat
   * down, played, and then wandered off. The player who has literally never
   * acted while connected is the one being shown nothing.
   *
   * `lastTurnRenderedAt` sharpens it when a newer client supplies it: a client
   * that positively confirmed it drew the action bar is an ordinary AFK, and
   * saying otherwise would cry wolf. Absent, we fall back to the weaker (but
   * still rare) signal, which is why old clients are not a blind spot.
   *
   * DIAGNOSIS ONLY. It changes nothing about what happens to the player: the
   * sit-out still fires, the eviction clock still runs. Making this alter the
   * outcome would let a broken client hold a seat forever, which is a worse
   * bug than the one it reports.
   */
  reportSuspectedSilentClient(
    tableId: string,
    playerId: string,
    state: PlayerConnectionState
  ): { suspected: boolean; reason: string } {
    if (!state.isConnected) {
      return { suspected: false, reason: 'disconnected - ordinary timeout ladder' };
    }
    if (state.everActed) {
      return { suspected: false, reason: 'has acted here before - ordinary AFK' };
    }
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if ((state.turnsOffered ?? 0) < config.maxConsecutiveTimeouts) {
      return { suspected: false, reason: 'not enough turns offered to judge' };
    }
    if (state.lastTurnRenderedAt) {
      return { suspected: false, reason: 'client confirmed it rendered the turn - AFK' };
    }

    const detail =
      `connected player never acted at this table: ` +
      `${state.turnsOffered} turn(s) offered, ${state.consecutiveTimeouts} timeout(s), ` +
      `heartbeat ${Math.round((Date.now() - state.lastHeartbeat) / 1000)}s ago, ` +
      `no client turn-render ack`;

    reportError(new Error(`[silent-client] ${detail}`), 'DisconnectEngine.SuspectedSilentClient', {
      tableId,
      playerId,
    });
    try {
      EngineMetrics.metricsRegistry
        .counter(
          'poker_suspected_silent_client_total',
          'Forced sit-outs where the player was connected but had never acted'
        )
        .inc(1, { table_id: tableId });
    } catch {
      /* metrics must never break the ladder */
    }
    return { suspected: true, reason: detail };
  }

  /**
   * THE CLIENT SAYS IT PUT THE ACTION IN FRONT OF A HUMAN (phase 2).
   *
   * Optional, and deliberately so: only newer clients send it, and the canary
   * is designed to work without it. What it adds is the distinction between
   * the two ways of never acting — a player who was SHOWN the action and
   * ignored it (ordinary AFK) versus one whose client never rendered it at
   * all (the seat-7 failure). Without this, both look the same from here.
   *
   * Never used to punish: it can only make the engine quieter about a player,
   * never harsher. A client that lies about rendering merely suppresses a
   * diagnostic about itself.
   */
  noteTurnRendered(tableId: string, playerId: string): void {
    const state = this.playerStates.get(`${tableId}:${playerId}`);
    if (!state) return;
    state.lastTurnRenderedAt = Date.now();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AWAY BLIND CAP (Dan 2026-08-23)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The client told us it is going away — pagehide, tab close, or the app
   * being frozen by the OS. Unlike `markTransportGone` this concludes
   * immediately: silence is ambiguous, but "I am leaving" is not.
   *
   * The player keeps their seat. They are simply AWAY, which means the blind
   * cap now applies to them: one SB + one BB and they are stood up.
   */
  markPageLeft(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state) return;
    state.pageLeftAt = Date.now();
    // Conclude the disconnect now rather than waiting out TRANSPORT_GRACE_MS.
    this.markDisconnected(tableId, playerId);
  }

  /**
   * Is this player AWAY, in the sense Dan defined for the blind cap?
   *
   * Three ways in, all of them "the seat is warm but nobody is behind it":
   *   1. transport gone / heartbeat stale  → `isConnected === false`
   *   2. connected but not acting (AFK)    → `consecutiveTimeouts >= 2`
   *   3. client said it is leaving         → `pageLeftAt !== null`
   *
   * Deliberately NOT included: a voluntary sit-out. That is a player making a
   * choice, it costs them nothing (sat-out cash players are never dealt in),
   * and it already has its own 2-hand / 5-minute eviction rule.
   */
  isAway(tableId: string, playerId: string): boolean {
    const state = this.playerStates.get(`${tableId}:${playerId}`);
    if (!state) return false;
    if (state.isSittingOut) return false;
    if (!state.isConnected) return true;
    if (state.pageLeftAt != null) return true;
    return (state.consecutiveTimeouts ?? 0) >= DisconnectEngine.AFK_AWAY_MIN_STRIKES;
  }

  /**
   * Record that a blind was taken from a player. A no-op unless they are away
   * — a present player may be blinded all night, that is poker.
   *
   * Idempotent per blind: charging the same blind twice in one absence still
   * only burns one slot of the two-blind budget, so a re-deal or a hand that
   * is voided and re-dealt cannot evict somebody early.
   */
  noteBlindChargedWhileAway(tableId: string, playerId: string, which: 'sb' | 'bb'): void {
    if (!this.isAway(tableId, playerId)) return;
    const state = this.playerStates.get(`${tableId}:${playerId}`);
    if (!state) return;
    if (which === 'sb') state.awayBlindSbCharged = true;
    else state.awayBlindBbCharged = true;
  }

  /**
   * Players who have now spent their whole away-blind budget (one SB AND one
   * BB) and must be stood up and cashed out. Called from the dealing loop
   * alongside the sit-out eviction sweep, so removal happens between hands.
   *
   * The `isAway` re-check is not redundant with the flags. Coming back clears
   * them, but "coming back" and "the dealing loop sweeping" are two different
   * clocks: a player whose reconnect lands microseconds after this sweep
   * starts would otherwise be cashed out of a table they are actively sitting
   * at. Presence is checked at the moment of the decision, and it wins.
   */
  collectAwayBlindEvictions(tableId: string, playerIds: string[]): string[] {
    const evict: string[] = [];
    for (const playerId of playerIds) {
      const state = this.playerStates.get(`${tableId}:${playerId}`);
      if (!state) continue;
      if (state.awayBlindSbCharged !== true || state.awayBlindBbCharged !== true) continue;
      if (!this.isAway(tableId, playerId)) continue;
      evict.push(playerId);
    }
    return evict;
  }

  /**
   * ABANDONED SEATS (2026-09-04, the disconnect audit's first finding).
   *
   * A player who is gone but never sat out fell through every eviction rule:
   * the sit-out clock needs `isSittingOut`, the away-blind cap needs blinds to
   * actually be charged, and the forced sit-out needs three TURNS to time out.
   * At a table below the deal minimum, or heads-up after the other player
   * left, none of those ever happen - so a phone that died at a quiet table
   * held its seat, and its chips, forever. `isAway()` was true the whole
   * time and nothing consumed it.
   *
   * Dan's rule for a sat-out seat is "2 orbits or 5 minutes, whichever comes
   * first". A seat nobody is behind gets the same 5 minutes, measured from
   * the moment the engine concluded they were gone (`disconnectedAt`, or the
   * /away beacon's `pageLeftAt`, whichever is older). A sat-out player is
   * excluded here because the sit-out rule already owns them, and a player
   * whose heartbeat lands before the sweep is not away, so presence wins at
   * the moment of the decision exactly as it does for the blind cap.
   */
  collectAbandonedSeatEvictions(tableId: string, playerIds: string[]): string[] {
    const evict: string[] = [];
    const now = Date.now();
    for (const playerId of playerIds) {
      const state = this.playerStates.get(`${tableId}:${playerId}`);
      if (!state || state.isSittingOut) continue;
      if (!this.isAway(tableId, playerId)) continue;
      const stamps = [state.disconnectedAt, state.pageLeftAt].filter(
        (t): t is number => typeof t === 'number' && Number.isFinite(t)
      );
      if (stamps.length === 0) continue; // AFK-by-timeouts alone: the strike path owns it
      const goneSince = Math.min(...stamps);
      if (now - goneSince >= DisconnectEngine.SITOUT_MAX_MS) evict.push(playerId);
    }
    return evict;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIT OUT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Player requests to sit out (voluntary or forced by consecutive timeouts).
   *
   * `sinceMs` seeds the eviction clock from a stamp that already exists —
   * `table_seats.sit_out_at` — rather than from now(). Only the restore path
   * passes it. See restoreSitOutsFromSeats().
   */
  sitOut(
    tableId: string,
    playerId: string,
    reason: 'voluntary' | 'forced' = 'voluntary',
    sinceMs?: number
  ): void {
    const key = `${tableId}:${playerId}`;
    let state = this.playerStates.get(key);

    /* REGISTRATION GAP 2026-08-28 — half of why the 5-minute boot never fired.
     *
     * This was `if (!state) return;`. `playerStates` is populated by
     * registerPlayer(), and registerPlayer() had exactly two callers: inside
     * dealHand(), and inside restoreSitOutsFromSeats() — which itself only runs
     * for a seat that is ALREADY flagged is_sitting_out in the database.
     *
     * So a player who tapped Sit Out at a table that had not dealt a hand since
     * the engine booted hit this guard and fell straight out. No state, no
     * PLAYER_SAT_OUT event, therefore no `is_sitting_out` write to table_seats,
     * therefore nothing for restoreSitOutsFromSeats to bootstrap from on the
     * next pass, therefore tickSitOutsAndCollectEvictions skipped them forever
     * (`if (!state || !state.isSittingOut) continue`).
     *
     * A chicken-and-egg deadlock, and it was SILENT in both directions: the
     * HTTP handler still answered `{ success: true }` and the client happily
     * rendered them as sitting out. The seat was then held indefinitely — which
     * is exactly the bug reported. It bit hardest on a quiet table, which is
     * also precisely where a seat being held forever matters most.
     *
     * Registering on demand is correct rather than merely convenient: being
     * asked to sit a player out IS the proof that they are at this table. */
    if (!state) {
      this.registerPlayer(tableId, playerId);
      state = this.playerStates.get(key);
      if (!state) return;
    }

    // Stamp the clock only on the TRANSITION into sitting out, so a repeated
    // sitOut() call cannot keep resetting the 5-minute eviction window.
    if (!state.isSittingOut) {
      state.sitOutSince = Number.isFinite(sinceMs as number) ? (sinceMs as number) : Date.now();
      state.sitOutOrbits = 0;
      state.sitOutReason = reason;
    } else if (Number.isFinite(sinceMs as number)) {
      /* A restore for somebody already marked sitting out in memory must not
         push the clock FORWARD, but it may pull it back to the persisted truth:
         the database stamp is older than anything this process invented. */
      state.sitOutSince = Math.min(state.sitOutSince ?? Infinity, sinceMs as number);
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
    state.sitOutReason = null;
    // Sitting back in is a return to the game — the away-blind budget resets
    // with everything else. Without this, a player who went away, paid a
    // blind, sat out and sat back in would carry the charge into their next
    // absence and be evicted after a single blind.
    state.awayBlindSbCharged = false;
    state.awayBlindBbCharged = false;
    state.pageLeftAt = null;

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
  tickSitOutsAndCollectEvictions(
    tableId: string,
    playerIds: string[],
    opts: { countOrbit?: boolean } = {}
  ): string[] {
    // Dan 2026-08-25: "IF YOU ARE SITTING OUT IT NEVER KICKS YOU OFF THE TABLE.
    // YOU CAN LITERALLY HOLD THAT SEAT FOREVER. IT SHOULD BE 2 ORBITS OR 5
    // MINUTES, WHICHEVER IS FIRST."
    //
    // Two things were wrong, and they hid each other.
    //
    // `countOrbit` exists because this used to increment on EVERY call, and the
    // caller is the dealing loop — which runs once per hand while dealing and
    // once per 3-second idle tick while not. So "2 orbits" was really "3 hands"
    // OR "about nine seconds of sitting at an idle table", depending on
    // something the rule never mentions.
    //
    // 2026-08-29: the caller now passes `countOrbit` only on a genuine BUTTON
    // WRAP, not on every deal. Counting hands made "2 orbits" mean 3 hands,
    // which at 6-max is a third of one orbit — a player removed roughly four
    // times sooner than the rule they were told. The wrap was already being
    // detected one line away for time-bank refills.
    //
    // The 5-minute half is still evaluated on EVERY call, deal or not. That is
    // the half that has to work when the table has gone quiet, which is exactly
    // when a seat gets held forever.
    const evict: string[] = [];
    const now = Date.now();
    for (const playerId of playerIds) {
      const state = this.playerStates.get(`${tableId}:${playerId}`);
      if (!state || !state.isSittingOut) continue;
      if (opts.countOrbit) {
        state.sitOutOrbits = (state.sitOutOrbits ?? 0) + 1;
      }
      /* `>=`, not `>` (2026-08-29). Strictly-greater-than 2 fires on the THIRD
         orbit, so a constant named SITOUT_MAX_ORBITS = 2 was enforcing three.
         Dan's rule is "removed after the button passes them TWICE": the second
         pass is the one that removes them. Paired with the caller now counting
         a real button wrap rather than a hand — see the note at its call site
         in ServerTableEngineDealing. */
      const orbitsUp = (state.sitOutOrbits ?? 0) >= DisconnectEngine.SITOUT_MAX_ORBITS;
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
        // 2026-09-04 (audit item 10): the 8s transport-grace timer was left
        // running for a disposed table; it fired markDisconnected against a
        // key that no longer existed. Harmless, and a leak all the same.
        this.cancelTransportGrace(key);
        this.playerStates.delete(key);
      }
    }
    this.tableConfigs.delete(tableId);
    this.actionCallbacks.delete(tableId);
  }

  disposeAll(): void {
    for (const timer of this.transportGraceTimers.values()) clearTimeout(timer);
    this.transportGraceTimers.clear();
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
    thawTableReconnectClock(tableId, s);
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;

    // Everything a restore needs to continue rather than restart (item 2/4).
    const carried = {
      sitOutSinceMs: s.sitOutSince ?? null,
      sitOutOrbits: s.sitOutOrbits ?? 0,
      sitOutReason: s.sitOutReason ?? null,
      strikes: s.consecutiveTimeouts,
      awayBlindSbCharged: s.awayBlindSbCharged === true,
      awayBlindBbCharged: s.awayBlindBbCharged === true,
      pageLeftAtMs: s.pageLeftAt ?? null,
      reconnectDeadlineMs: s.reconnectDeadlineMs,
      reconnectGrantedAtMs: s.reconnectGrantedAtMs,
      reconnectThawedAtMs: s.reconnectThawedAtMs,
    };
    if (s.isSittingOut) {
      // sinceMs is the sit-out's own start (item 4). It used to be
      // lastHeartbeat, so a crash-recovered sit-out restarted its 5-minute
      // eviction clock at the moment of the crash.
      return {
        state: 'SAT_OUT',
        sinceMs: s.sitOutSince ?? s.lastHeartbeat,
        graceDeadlineMs: null,
        ...carried,
      };
    }
    if (s.isConnected) {
      return { state: 'CONNECTED', sinceMs: s.lastHeartbeat, graceDeadlineMs: null, ...carried };
    }
    const dAt = s.disconnectedAt ?? s.lastHeartbeat;
    const graceDeadlineMs =
      s.reconnectDeadlineMs ?? dAt + reconnectProtectionSeconds(s.reconnectMembership ?? {}) * 1000;
    if (Date.now() < graceDeadlineMs) {
      return { state: 'MISSING', sinceMs: dAt, graceDeadlineMs, ...carried };
    }
    return { state: 'DISCONNECTED', sinceMs: dAt, graceDeadlineMs, ...carried };
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
        reconnectDeadlineMs: Number.isFinite(entry.reconnectDeadlineMs)
          ? entry.reconnectDeadlineMs
          : !connected && !sittingOut && Number.isFinite(entry.graceDeadlineMs)
            ? entry.graceDeadlineMs!
            : undefined,
        reconnectGrantedAtMs: entry.reconnectGrantedAtMs,
        reconnectThawedAtMs: entry.reconnectThawedAtMs,
        lastHeartbeat: entry.sinceMs || Date.now(),
        // 2026-09-04 (item 2): strikes, the blind budget, the sit-out reason
        // and the /away stamp survive a restart when the snapshot carries
        // them. A restart used to be a free reset of all four.
        consecutiveTimeouts: Number.isFinite(entry.strikes) ? (entry.strikes as number) : 0,
        sitOutReason: sittingOut ? (entry.sitOutReason ?? 'voluntary') : null,
        isSittingOut: sittingOut,
        disconnectedAt: connected || sittingOut ? undefined : entry.sinceMs || Date.now(),
        // These five were omitted, and one of them mattered. Dan's rule is "a
        // player sitting out is removed after the button passes them twice, OR
        // after 5 minutes, whichever comes first" — and the 5-minute half is
        // gated on `state.sitOutSince != null` in tickSitOutsAndCollectEvictions.
        // Leaving it `undefined` meant a crash-recovered sit-out could only ever
        // be evicted by the orbit counter, so on a table that stopped dealing
        // they sat there forever. Seeded from when the sit-out actually began,
        // not from now, or every restart would restart their clock.
        // Item 4: the entry's own sitOutSinceMs when present (sinceMs is
        // now the same number for SAT_OUT, but an older snapshot's sinceMs
        // was the last heartbeat, so the dedicated field is preferred).
        sitOutSince: sittingOut ? (entry.sitOutSinceMs ?? entry.sinceMs ?? Date.now()) : null,
        sitOutOrbits: sittingOut ? (entry.sitOutOrbits ?? 0) : 0,
        awayBlindSbCharged: entry.awayBlindSbCharged === true,
        awayBlindBbCharged: entry.awayBlindBbCharged === true,
        pageLeftAt: connected || sittingOut ? null : (entry.pageLeftAtMs ?? null),
      });
      restored++;
    }
    return restored;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The beat a sitting-out seat waits before the engine acts for it.
   *
   * Re-checked at the deadline rather than trusted from the top of the beat:
   * a player who sits back in during those few hundred milliseconds gets their
   * turn, which is the whole point of not folding them instantly. If they are
   * still out, the auto-action runs exactly as it always did.
   */
  private scheduleSitOutAutoAction(tableId: string, playerId: string, canCheck: boolean): void {
    const delayMs = sitOutAutoActionDelayMs(canCheck);
    this.preciseTimer.startTimer(tableId, `disconnect:${playerId}`, delayMs, () => {
      const state = this.playerStates.get(`${tableId}:${playerId}`);
      if (!state || !state.isSittingOut) return; // they came back - the turn is theirs
      this.executeAutoAction(tableId, playerId, canCheck, 'sitting_out');
    });
  }

  private startTimeoutCountdown(
    tableId: string,
    playerId: string,
    canCheck: boolean,
    config: DisconnectConfig
  ): void {
    const key = `${tableId}:${playerId}`;
    const state = this.playerStates.get(key);
    if (!state) return;

    thawTableReconnectClock(tableId, state);

    this.emitEvent({
      type: 'DISCONNECT_TIMER_STARTED',
      tableId,
      playerId,
      timeoutSeconds: reconnectProtectionSeconds(state.reconnectMembership ?? {}),
    });

    // Use PreciseActionTimer for the countdown (deadline-based, drift-immune)
    const deadline =
      state.reconnectDeadlineMs ??
      (state.disconnectedAt ?? Date.now()) +
        reconnectProtectionSeconds(state.reconnectMembership ?? {}) * 1000;
    state.reconnectDeadlineMs = deadline;
    this.preciseTimer.startTimerAt(tableId, `disconnect:${playerId}`, deadline, () => {
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
        /* THE SECOND DOOR (phase 2 audit, 2026-08-31). The canary was wired
           into `recordConnectedTimeout` and stopped there — but a player can
           also be condemned HERE, from the disconnect countdown. Usually that
           is a genuinely disconnected player and the canary declines to
           accuse anybody, because it checks `isConnected` for itself.

           The case that makes wiring it worthwhile is narrower and real: a
           player whose countdown was armed while the socket was down and who
           has since RECONNECTED, so the timer fires against somebody now back
           at the table. Leaving one of the two sentencing paths unwatched is
           how a diagnostic quietly ends up covering half of what it claims
           to. The function decides suspicion itself, so calling it here can
           only add evidence, never a false accusation. */
        this.reportSuspectedSilentClient(tableId, playerId, state);
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
