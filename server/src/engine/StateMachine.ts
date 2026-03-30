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
  { from: 'waiting', to: 'empty' },  // last player leaves
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
  { from: 'flop', to: 'turn' },              // Normal variants
  { from: 'pineapple_discard', to: 'turn' },
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
// §3.3 TURN STATE MACHINE (already implemented in PreciseActionTimer + TimeBankEngine)
// §3.4 DISCONNECT STATE MACHINE (already implemented in DisconnectEngine)
// These are documented here for completeness but are implemented inline.
// ═══════════════════════════════════════════════════════════════════════════════

export type TurnFSMState =
  | 'waiting'
  | 'timer_running'
  | 'time_bank_active'
  | 'expired'
  | 'action_received'
  | 'processing'
  | 'complete';

export type DisconnectFSMState =
  | 'connected'
  | 'heartbeat_missed'
  | 'disconnected'
  | 'reconnecting'
  | 'reconnected';
