/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CHIP CONSERVATION VERIFIER
 * ═══════════════════════════════════════════════════════════════════════════════
 * The invariant StateVerifier LACKS: on EVERY event in a hand's stream,
 *
 *      Σ stacks  +  Σ bets  +  pot  +  rakeTaken  ==  initial buy-in total
 *
 * StateVerifier only compares Σstacks against a baseline between hands, and it
 * deliberately excludes bets (FIX 204) because the legacy pot double-counts
 * live bets. This verifier folds the event stream through the pure reducer and
 * asserts conservation after each step, pinpointing the exact offending event.
 *
 * Chips are created out of thin air (or vanish) the instant this fails.
 */

import type { HandEvent } from './events.js';
import { apply, type HandState, type ReducerDeps } from './HandReducer.js';

/** Whole-chip play uses cents; half a cent can never mask a real leak. */
export const CONSERVATION_TOLERANCE = 0.005;

export interface ConservationViolation {
  /** seq of the event after which conservation broke. */
  seq: number;
  eventType: HandEvent['type'];
  /** The offending event, verbatim. */
  event: HandEvent;
  expected: number;
  actual: number;
  diff: number;
  message: string;
}

export interface ConservationReport {
  ok: boolean;
  initialChipTotal: number;
  checkedEvents: number;
  violations: ConservationViolation[];
}

/** Σstacks + Σbets + pot + rakeTaken for a reduced state. */
export function conservedTotal(state: HandState): number {
  const stacks = state.seats.reduce((sum, s) => sum + s.stack, 0);
  const bets = state.seats.reduce((sum, s) => sum + s.bet, 0);
  return Math.round((stacks + bets + state.pot + state.rakeTaken) * 100) / 100;
}

/**
 * Fold the stream and assert conservation after EACH event. Returns every
 * violation found (does not stop at the first) with the event that caused it.
 */
export function verifyStream(events: HandEvent[], deps: ReducerDeps = {}): ConservationReport {
  const violations: ConservationViolation[] = [];

  if (events.length === 0) {
    return { ok: false, initialChipTotal: 0, checkedEvents: 0, violations: [] };
  }

  if (events[0].type !== 'HandStarted') {
    // Cannot establish a baseline — the whole stream is untrustworthy.
    return {
      ok: false,
      initialChipTotal: 0,
      checkedEvents: 0,
      violations: [
        {
          seq: events[0].seq,
          eventType: events[0].type,
          event: events[0],
          expected: NaN,
          actual: NaN,
          diff: NaN,
          message: `Stream must begin with HandStarted, got '${events[0].type}'`,
        },
      ],
    };
  }

  let state: HandState | undefined;
  let initialChipTotal = 0;
  let checked = 0;

  for (const event of events) {
    try {
      state = apply(state, event, deps);
    } catch (err) {
      violations.push({
        seq: event.seq,
        eventType: event.type,
        event,
        expected: initialChipTotal,
        actual: NaN,
        diff: NaN,
        message: `Reducer threw while applying '${event.type}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      break;
    }

    if (event.type === 'HandStarted') {
      initialChipTotal = state.initialChipTotal;
    }

    checked++;
    const actual = conservedTotal(state);
    const diff = Math.round((actual - initialChipTotal) * 100) / 100;
    if (Math.abs(diff) > CONSERVATION_TOLERANCE) {
      violations.push({
        seq: event.seq,
        eventType: event.type,
        event,
        expected: initialChipTotal,
        actual,
        diff,
        message: `Chip conservation broken after '${event.type}' (seq ${event.seq}): expected ${initialChipTotal}, got ${actual} (diff ${diff})`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    initialChipTotal,
    checkedEvents: checked,
    violations,
  };
}

/**
 * Convenience assertion — throws on the first violation. Use in tests / guards
 * where a leak should hard-fail rather than be collected.
 */
export function assertConservation(events: HandEvent[], deps: ReducerDeps = {}): void {
  const report = verifyStream(events, deps);
  if (!report.ok) {
    const first = report.violations[0];
    throw new Error(
      `ChipConservationVerifier: ${report.violations.length} violation(s). First: ${first?.message}`
    );
  }
}
