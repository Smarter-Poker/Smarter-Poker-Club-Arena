/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SHADOW RECORDER — Zero-Behavior-Change Integration Path
 * ═══════════════════════════════════════════════════════════════════════════════
 * The SAFE way to introduce event sourcing into the live engine. The live
 * ServerTableEngine keeps running exactly as today; alongside it, it calls
 * `record(...)` for each lifecycle milestone. At hand end, ShadowRecorder:
 *   1. replays the recorded events through the pure HandReducer,
 *   2. runs the ChipConservationVerifier over the stream,
 *   3. compares the replayed final stacks/pot to the engine's ACTUAL final
 *      state, and logs/reports any divergence.
 *
 * It NEVER throws into the caller and NEVER mutates engine state — a bug in the
 * shadow path can only produce a log line, never a gameplay change. This makes
 * the eventual "flip the switch" (drive state FROM events) a de-risked, purely
 * mechanical follow-up.
 *
 * Timestamps ARE generated here (via the injected `now()`), which is why the
 * reducer stays pure: the impure boundary lives in this recorder, not the fold.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRING PLAN — where the ~8 record() calls go in ServerTableEngine.ts
 * (mechanical follow-up; DO NOT edit ServerTableEngine now). Line numbers are
 * from the 2026-07-24 revision and are indicative.
 *
 *   #  ServerTableEngine location                          record() call
 *   ── ──────────────────────────────────────────────────  ─────────────────────
 *   1  startHand(): right after `new HandController(...)`    recordHandStarted(seed,
 *        (~L2478) — construct a ShadowRecorder per hand and    button, players, stakes)
 *        seed it with the deck seed used by HandController.
 *   2  handleHandEvent() case 'BLINDS_POSTED' (~L2616)       recordBlindsPosted(postings)
 *   3  handleHandEvent() case 'CARDS_DEALT'   (~L2636)       recordHoleCardsDealt(...)
 *        (aggregate per-seat CARDS_DEALT into one deal, or
 *         record one HoleCardsDealt per seat — either works)
 *   4  handleHandEvent() case 'PLAYER_ACTION' (~L2726)       recordPlayerActed(seat,
 *                                                              action, amount)
 *   5  handleHandEvent() case 'COMMUNITY_CARDS' (~L2770)     recordStreetAdvanced(street,
 *                                                              board)
 *   6  handleHandEvent() case 'SHOWDOWN'      (~L2826)       recordShowdownRevealed(reveals)
 *   7  handleHandEvent() case 'WINNERS'       (~L2860)       recordPotAwarded(payouts, rake)
 *   8  handleHandEvent() case 'HAND_COMPLETE' (~L2547 in the recordHandEnded(handNumber)
 *        onEvent closure, before `this.handController = null`) then finalize(actual)
 *
 * The engine's HandEvent union already emits every one of these milestones, so
 * each call is a one-liner inside an existing switch case. Nothing else changes.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { Card, ActionType } from '../../types.js';
import {
  HAND_EVENT_SCHEMA_VERSION,
  type HandEvent,
  type BlindPosting,
  type DealtHand,
  type EventPlayerSeat,
  type Payout,
  type RevealedHand,
  type Stakes,
  type Street,
} from './events.js';
import { EventLog, type EventSink } from './EventLog.js';
import { replay, type HandState, type ReducerDeps } from './HandReducer.js';
import { verifyStream, type ConservationReport } from './ChipConservationVerifier.js';

// ─────────────────────────────────────────────────────────────────────────────
// Divergence reporting
// ─────────────────────────────────────────────────────────────────────────────

/** The engine's ACTUAL final state, as observed at hand end. */
export interface EngineFinalState {
  seats: { seat: number; userId: string; stack: number }[];
  pot?: number;
}

export interface SeatDivergence {
  seat: number;
  userId: string;
  replayedStack: number;
  actualStack: number;
  diff: number;
}

export interface DivergenceReport {
  handId: string;
  /** True when replay matches the engine AND chip conservation held. */
  ok: boolean;
  seatDivergences: SeatDivergence[];
  potDivergence?: { replayed: number; actual: number; diff: number };
  conservation: ConservationReport;
  eventCount: number;
}

export interface ShadowRecorderOptions {
  /** Where to persist events. Defaults to an internal in-memory log. */
  log?: EventLog;
  /** Durable sink to attach if creating the default log. */
  sink?: EventSink;
  /** Impure time source (the boundary). Defaults to Date.now. */
  now?: () => number;
  /** Reducer deps (custom shuffle). Must MATCH the engine's deck derivation. */
  reducer?: ReducerDeps;
  /** Divergence callback (telemetry / Sentry). Never throws into the recorder. */
  onDivergence?: (report: DivergenceReport) => void;
  /** Logger. Defaults to console. */
  logger?: Pick<Console, 'warn' | 'error'>;
  /** Tolerance for stack/pot comparison. */
  tolerance?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ShadowRecorder
// ─────────────────────────────────────────────────────────────────────────────

export class ShadowRecorder {
  private readonly handId: string;
  private readonly log: EventLog;
  private readonly now: () => number;
  private readonly reducer: ReducerDeps;
  private readonly onDivergence?: (report: DivergenceReport) => void;
  private readonly logger: Pick<Console, 'warn' | 'error'>;
  private readonly tolerance: number;
  private seq = 0;

  constructor(handId: string, opts: ShadowRecorderOptions = {}) {
    this.handId = handId;
    this.log = opts.log ?? new EventLog(opts.sink);
    this.now = opts.now ?? (() => Date.now());
    this.reducer = opts.reducer ?? {};
    this.onDivergence = opts.onDivergence;
    this.logger = opts.logger ?? console;
    this.tolerance = opts.tolerance ?? 0.005;
  }

  /** Events recorded so far for this hand, in seq order. */
  events(): readonly HandEvent[] {
    return this.log.forHand(this.handId);
  }

  // ── stamping ──────────────────────────────────────────────────────────────

  private stamp<T extends { type: HandEvent['type'] }>(body: T) {
    return {
      ...body,
      handId: this.handId,
      seq: this.seq++,
      ts: this.now(),
      v: HAND_EVENT_SCHEMA_VERSION,
    };
  }

  /**
   * Record any event. Swallows all errors — the shadow path must never affect
   * the live hand. Returns the stamped event (or null on failure).
   */
  private safeAppend(event: HandEvent): HandEvent | null {
    try {
      this.log.append(event);
      return event;
    } catch (err) {
      this.logger.warn(
        `[ShadowRecorder ${this.handId}] failed to record '${event.type}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  }

  // ── typed record helpers (the ~8 call sites) ────────────────────────────────

  recordHandStarted(input: {
    seed: number;
    handNumber: number;
    buttonSeat: number;
    players: EventPlayerSeat[];
    stakes: Stakes;
  }): void {
    this.safeAppend(this.stamp({ type: 'HandStarted', ...input }) as HandEvent);
  }

  recordBlindsPosted(postings: BlindPosting[]): void {
    this.safeAppend(this.stamp({ type: 'BlindsPosted', postings }) as HandEvent);
  }

  recordHoleCardsDealt(cardsPerPlayer: number, hands?: DealtHand[]): void {
    this.safeAppend(this.stamp({ type: 'HoleCardsDealt', cardsPerPlayer, hands }) as HandEvent);
  }

  recordPlayerActed(seat: number, action: ActionType, amount: number): void {
    this.safeAppend(this.stamp({ type: 'PlayerActed', seat, action, amount }) as HandEvent);
  }

  recordStreetAdvanced(street: Street, board?: Card[]): void {
    this.safeAppend(this.stamp({ type: 'StreetAdvanced', street, board }) as HandEvent);
  }

  recordShowdownRevealed(reveals: RevealedHand[]): void {
    this.safeAppend(this.stamp({ type: 'ShowdownRevealed', reveals }) as HandEvent);
  }

  recordPotAwarded(payouts: Payout[], rake?: number): void {
    this.safeAppend(this.stamp({ type: 'PotAwarded', payouts, rake }) as HandEvent);
  }

  recordHandEnded(handNumber: number): void {
    this.safeAppend(this.stamp({ type: 'HandEnded', handNumber }) as HandEvent);
  }

  // ── finalize: replay + verify + diverge ─────────────────────────────────────

  /**
   * Replay the recorded stream, verify conservation, and compare against the
   * engine's actual final state. Returns a report and fires onDivergence if the
   * two disagree. NEVER throws — a shadow failure only produces a log line.
   */
  finalize(actual: EngineFinalState): DivergenceReport {
    const events = [...this.events()];
    const conservation = verifyStream(events, this.reducer);

    let replayed: HandState | undefined;
    try {
      replayed = replay(events, this.reducer);
    } catch (err) {
      const report: DivergenceReport = {
        handId: this.handId,
        ok: false,
        seatDivergences: [],
        conservation,
        eventCount: events.length,
      };
      this.logger.error(
        `[ShadowRecorder ${this.handId}] replay threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      this.emit(report);
      return report;
    }

    const seatDivergences: SeatDivergence[] = [];
    for (const actualSeat of actual.seats) {
      const r = replayed.seats.find((s) => s.seat === actualSeat.seat);
      const replayedStack = r?.stack ?? NaN;
      const diff = Math.round((replayedStack - actualSeat.stack) * 100) / 100;
      if (!r || Math.abs(diff) > this.tolerance) {
        seatDivergences.push({
          seat: actualSeat.seat,
          userId: actualSeat.userId,
          replayedStack,
          actualStack: actualSeat.stack,
          diff,
        });
      }
    }

    let potDivergence: DivergenceReport['potDivergence'];
    if (actual.pot !== undefined) {
      const diff = Math.round((replayed.pot - actual.pot) * 100) / 100;
      if (Math.abs(diff) > this.tolerance) {
        potDivergence = { replayed: replayed.pot, actual: actual.pot, diff };
      }
    }

    const ok = conservation.ok && seatDivergences.length === 0 && !potDivergence;
    const report: DivergenceReport = {
      handId: this.handId,
      ok,
      seatDivergences,
      potDivergence,
      conservation,
      eventCount: events.length,
    };

    if (!ok) {
      this.logger.warn(
        `[ShadowRecorder ${this.handId}] DIVERGENCE: ` +
          `${seatDivergences.length} seat(s), pot=${potDivergence ? 'MISMATCH' : 'ok'}, ` +
          `conservation=${conservation.ok ? 'ok' : conservation.violations.length + ' violation(s)'}`
      );
    }
    this.emit(report);
    return report;
  }

  private emit(report: DivergenceReport): void {
    if (!this.onDivergence) return;
    try {
      this.onDivergence(report);
    } catch (err) {
      this.logger.error(
        `[ShadowRecorder ${this.handId}] onDivergence handler threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
