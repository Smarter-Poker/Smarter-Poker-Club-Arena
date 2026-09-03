/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Bible V8 §1.6, §3.1, §3.2 — Formal State Machine with Explicit Transitions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FIX-225: Resolves PARTIAL items 1.6, 3.1, 3.2 from COMPLIANCE-TRACKER.
 *
 * Every state has explicit:
 *   - Entry conditions (what must be true to enter)
 *   - Valid transitions (which states can follow)
 *   - Failure conditions (invalid transition attempts)
 *
 * The StateMachine class is generic — used for both Table and Hand state machines.
 * Invalid transitions throw or return error, NEVER silently succeed.
 */

import { reportError } from '../services/errorReporter.js';
import type { HandStage, TableStatus } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════

export interface StateTransition<S extends string> {
  from: S;
  to: S;
  /** Optional guard — transition only allowed if guard returns true */
  guard?: () => boolean;
}

export class StateMachine<S extends string> {
  private _state: S;
  private readonly transitions: Map<S, Set<S>> = new Map();
  private readonly guards: Map<string, () => boolean> = new Map();
  private readonly name: string;

  constructor(name: string, initialState: S, validTransitions: StateTransition<S>[]) {
    this.name = name;
    this._state = initialState;

    // Build transition graph
    for (const t of validTransitions) {
      let fromSet = this.transitions.get(t.from);
      if (!fromSet) {
        fromSet = new Set();
        this.transitions.set(t.from, fromSet);
      }
      fromSet.add(t.to);

      if (t.guard) {
        this.guards.set(`${t.from}->${t.to}`, t.guard);
      }
    }
  }

  get state(): S {
    return this._state;
  }

  /**
   * Attempt to transition to a new state.
   * Returns true if successful, false if transition is invalid.
   * Logs a warning on invalid transition (never throws in production).
   */
  transition(to: S): boolean {
    const validTargets = this.transitions.get(this._state);

    if (!validTargets || !validTargets.has(to)) {
      const msg = `[${this.name}] Invalid transition: ${this._state} → ${to}`;
      console.warn(msg);
      reportError(msg, `StateMachine.${this.name}.invalidTransition`);
      return false;
    }

    // Check guard if one exists
    const guardKey = `${this._state}->${to}`;
    const guard = this.guards.get(guardKey);
    if (guard && !guard()) {
      const msg = `[${this.name}] Guard failed: ${this._state} → ${to}`;
      console.warn(msg);
      return false;
    }

    this._state = to;
    return true;
  }

  /**
   * Check if a transition is valid without performing it.
   */
  canTransition(to: S): boolean {
    const validTargets = this.transitions.get(this._state);
    if (!validTargets || !validTargets.has(to)) return false;

    const guardKey = `${this._state}->${to}`;
    const guard = this.guards.get(guardKey);
    if (guard && !guard()) return false;

    return true;
  }

  /**
   * Force state (for recovery scenarios only). Logs a warning.
   */
  forceState(state: S): void {
    console.warn(`[${this.name}] FORCED state: ${this._state} → ${state}`);
    this._state = state;
  }

  /**
   * Get all valid transitions from current state.
   */
  getValidTransitions(): S[] {
    const validTargets = this.transitions.get(this._state);
    return validTargets ? Array.from(validTargets) : [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3.1 TABLE STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// States: EMPTY → WAITING → SEATING → RUNNING → PAUSED → CLOSING → CLOSED
//
// Transitions:
//   EMPTY → WAITING:     first player sits
//   WAITING → SEATING:   second player sits (buy-in phase)
//   SEATING → RUNNING:   both bought in, hand starts
//   RUNNING → RUNNING:   hand completes, next hand starts
//   RUNNING → PAUSED:    admin pause, break, or hand-for-hand
//   PAUSED → RUNNING:    resume
//   RUNNING → WAITING:   player count drops below 2
//   RUNNING → CLOSING:   admin close or all leave
//   CLOSING → CLOSED:    cleanup complete
//   WAITING → CLOSING:   admin close while waiting
//   EMPTY → CLOSING:     admin close empty table
// ═══════════════════════════════════════════════════════════════════════════════

const TABLE_TRANSITIONS: StateTransition<TableStatus>[] = [
  { from: 'empty', to: 'waiting' },
  { from: 'waiting', to: 'seating' },
  { from: 'seating', to: 'running' },
  { from: 'running', to: 'running' }, // self-transition: next hand
  { from: 'running', to: 'paused' },
  { from: 'paused', to: 'running' },
  { from: 'running', to: 'waiting' },
  { from: 'running', to: 'closing' },
  { from: 'closing', to: 'closed' },
  { from: 'waiting', to: 'closing' },
  { from: 'empty', to: 'closing' },
  { from: 'waiting', to: 'empty' }, // last player leaves
  { from: 'seating', to: 'waiting' }, // player leaves during seating
];

export function createTableStateMachine(
  initialState: TableStatus = 'empty'
): StateMachine<TableStatus> {
  return new StateMachine('TableFSM', initialState, TABLE_TRANSITIONS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3.2 HAND STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// States: idle → posting_blinds → dealing → preflop → flop → pineapple_discard
//         → turn → river → showdown → settlement → idle
//
// Each stage has a deterministic successor. The only branching is:
//   - All fold during any betting round → settlement
//   - Pineapple variant → pineapple_discard between flop and turn
//   - All-in runout skips betting rounds
// ═══════════════════════════════════════════════════════════════════════════════

export type HandFSMState =
  | 'idle'
  | 'posting_blinds'
  | 'dealing'
  | 'preflop'
  | 'flop'
  | 'pineapple_discard'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'settlement';

const HAND_TRANSITIONS: StateTransition<HandFSMState>[] = [
  // Normal progression
  { from: 'idle', to: 'posting_blinds' },
  { from: 'posting_blinds', to: 'dealing' },
  { from: 'dealing', to: 'preflop' },
  { from: 'preflop', to: 'flop' },
  { from: 'flop', to: 'pineapple_discard' }, // Pineapple variant
  { from: 'flop', to: 'turn' }, // Normal variants
  { from: 'pineapple_discard', to: 'turn' },
  // AUDIT V2 (2026-07-23): HandController enters the discard phase right after
  // DEALING the flop and returns to 'flop' for the flop BETTING round. This
  // edge was missing, so every pineapple hand logged an
  // "Invalid transition: pineapple_discard -> flop" FSM violation to Sentry.
  { from: 'pineapple_discard', to: 'flop' },
  // Pineapple all-in runout can also complete straight from the discard phase.
  { from: 'pineapple_discard', to: 'showdown' },
  { from: 'turn', to: 'river' },
  { from: 'river', to: 'showdown' },
  { from: 'showdown', to: 'settlement' },
  { from: 'settlement', to: 'idle' },

  // Early termination (all fold)
  { from: 'preflop', to: 'settlement' },
  { from: 'flop', to: 'settlement' },
  { from: 'pineapple_discard', to: 'settlement' },
  { from: 'turn', to: 'settlement' },
  { from: 'river', to: 'settlement' },

  // All-in runout (skip betting, go straight to next community)
  { from: 'preflop', to: 'showdown' },
  { from: 'flop', to: 'showdown' },
  { from: 'turn', to: 'showdown' },
  { from: 'river', to: 'showdown' },

  // Bomb pot: skip preflop entirely
  { from: 'dealing', to: 'flop' },
];

export function createHandStateMachine(
  initialState: HandFSMState = 'idle'
): StateMachine<HandFSMState> {
  return new StateMachine('HandFSM', initialState, HAND_TRANSITIONS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3.3 TURN STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// States: waiting → timer_running → time_bank_active → expired/action_received
//         → processing → complete → waiting
//
// Unifies PreciseActionTimer + TimeBankEngine + PreActionEngine + DisconnectEngine
// into a single state transition graph.
//
// Transitions:
//   waiting → timer_running:         turn starts, primary shot clock begins
//   timer_running → action_received: player submits a valid action
//   timer_running → time_bank_active: primary timer expires, time bank kicks in
//   timer_running → expired:          primary timer expires, no time bank available
//   time_bank_active → action_received: player acts during time bank
//   time_bank_active → expired:       time bank fully consumed
//   action_received → processing:     server validates and applies the action
//   expired → processing:             auto-fold/auto-check triggered
//   processing → complete:            action fully applied, state updated
//   complete → waiting:               turn advances to next player
// ═══════════════════════════════════════════════════════════════════════════════

export type TurnFSMState =
  | 'waiting'
  | 'timer_running'
  | 'time_bank_active'
  | 'expired'
  | 'action_received'
  | 'processing'
  | 'complete';

const TURN_TRANSITIONS: StateTransition<TurnFSMState>[] = [
  { from: 'waiting', to: 'timer_running' },
  { from: 'timer_running', to: 'action_received' },
  { from: 'timer_running', to: 'time_bank_active' },
  { from: 'timer_running', to: 'expired' },
  { from: 'time_bank_active', to: 'action_received' },
  { from: 'time_bank_active', to: 'expired' },
  { from: 'action_received', to: 'processing' },
  { from: 'expired', to: 'processing' },
  { from: 'processing', to: 'complete' },
  { from: 'complete', to: 'waiting' },
  // Recovery: force back to waiting from any terminal state
  { from: 'complete', to: 'timer_running' }, // next turn starts immediately
];

export function createTurnStateMachine(
  initialState: TurnFSMState = 'waiting'
): StateMachine<TurnFSMState> {
  return new StateMachine('TurnFSM', initialState, TURN_TRANSITIONS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3.4 DISCONNECT STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// States: connected → heartbeat_missed → disconnected → reconnecting → reconnected
//
// Transitions:
//   connected → heartbeat_missed:      missed heartbeat threshold
//   heartbeat_missed → disconnected:   consecutive misses exceed threshold
//   heartbeat_missed → connected:      heartbeat resumed in time
//   disconnected → reconnecting:       reconnect attempt detected
//   reconnecting → reconnected:        reconnect successful, state recovered
//   reconnecting → disconnected:       reconnect failed/timed out
//   reconnected → connected:           full state sync complete
// ═══════════════════════════════════════════════════════════════════════════════

export type DisconnectFSMState =
  | 'connected'
  | 'heartbeat_missed'
  | 'disconnected'
  | 'reconnecting'
  | 'reconnected';

const DISCONNECT_TRANSITIONS: StateTransition<DisconnectFSMState>[] = [
  { from: 'connected', to: 'heartbeat_missed' },
  { from: 'heartbeat_missed', to: 'disconnected' },
  { from: 'heartbeat_missed', to: 'connected' },
  { from: 'disconnected', to: 'reconnecting' },
  { from: 'reconnecting', to: 'reconnected' },
  { from: 'reconnecting', to: 'disconnected' },
  { from: 'reconnected', to: 'connected' },
];

export function createDisconnectStateMachine(
  initialState: DisconnectFSMState = 'connected'
): StateMachine<DisconnectFSMState> {
  return new StateMachine('DisconnectFSM', initialState, DISCONNECT_TRANSITIONS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3.4 PRE-ACTION STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// States: idle → queued → validating → executing → executed/invalidated → idle
//
// Formalizes the PreActionEngine lifecycle:
//   idle → queued:           player sets a pre-action (auto-fold, auto-check, etc.)
//   queued → validating:     player's turn arrives, pre-action checked for legality
//   validating → executing:  pre-action is still valid, being applied
//   validating → invalidated: game state changed (bet placed), pre-action no longer valid
//   executing → executed:    pre-action successfully applied as real action
//   executed → idle:         reset for next turn
//   invalidated → idle:      reset for next turn
//   queued → idle:           player manually clears pre-action, or new hand starts
// ═══════════════════════════════════════════════════════════════════════════════

export type PreActionFSMState =
  | 'idle'
  | 'queued'
  | 'validating'
  | 'executing'
  | 'executed'
  | 'invalidated';

const PRE_ACTION_TRANSITIONS: StateTransition<PreActionFSMState>[] = [
  { from: 'idle', to: 'queued' },
  { from: 'queued', to: 'validating' },
  { from: 'queued', to: 'idle' }, // cleared by player or new hand
  { from: 'validating', to: 'executing' },
  { from: 'validating', to: 'invalidated' },
  { from: 'executing', to: 'executed' },
  { from: 'executed', to: 'idle' },
  { from: 'invalidated', to: 'idle' },
];

export function createPreActionStateMachine(
  initialState: PreActionFSMState = 'idle'
): StateMachine<PreActionFSMState> {
  return new StateMachine('PreActionFSM', initialState, PRE_ACTION_TRANSITIONS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3.5 ERROR/RECOVERY STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// States: healthy → desync_detected → resync_required → resyncing
//         → resync_complete → healthy
//         OR → recovery_failed → manual_intervention
//
// Formalizes error detection and recovery:
//   healthy → desync_detected:       StateVerifier detects chip/card/pot mismatch
//   desync_detected → resync_required: server confirms desync is real (not transient)
//   resync_required → resyncing:     server initiates state resync to client
//   resyncing → resync_complete:     client acknowledges new state
//   resync_complete → healthy:       normal operation resumes
//   resyncing → recovery_failed:     resync attempt failed (timeout, reject)
//   recovery_failed → resync_required: retry resync
//   recovery_failed → manual_intervention: max retries exceeded
// ═══════════════════════════════════════════════════════════════════════════════

export type RecoveryFSMState =
  | 'healthy'
  | 'desync_detected'
  | 'resync_required'
  | 'resyncing'
  | 'resync_complete'
  | 'recovery_failed'
  | 'manual_intervention';

const RECOVERY_TRANSITIONS: StateTransition<RecoveryFSMState>[] = [
  { from: 'healthy', to: 'desync_detected' },
  { from: 'desync_detected', to: 'resync_required' },
  { from: 'desync_detected', to: 'healthy' }, // transient — resolved itself
  { from: 'resync_required', to: 'resyncing' },
  { from: 'resyncing', to: 'resync_complete' },
  { from: 'resyncing', to: 'recovery_failed' },
  { from: 'resync_complete', to: 'healthy' },
  { from: 'recovery_failed', to: 'resync_required' }, // retry
  { from: 'recovery_failed', to: 'manual_intervention' }, // give up
];

export function createRecoveryStateMachine(
  initialState: RecoveryFSMState = 'healthy'
): StateMachine<RecoveryFSMState> {
  return new StateMachine('RecoveryFSM', initialState, RECOVERY_TRANSITIONS);
}
