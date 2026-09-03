/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INTEGRITY FEED — observe-only anti-cheat data feed (WIRE #5, anti-cheat)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ADDITIVE wiring glue. At hand completion the live engine hands the just-logged
 * hand_history-shaped row to `integrityFeed.ingestRow(row)`. The feed:
 *   1. normalizes it via the foundation's HandEventAdapter,
 *   2. accumulates it into a bounded in-memory store (the detectors' signal), and
 *   3. periodically runs BotDetector + CollusionDetector over the store,
 *      logging any flags for human review.
 *
 * OBSERVE-ONLY. No enforcement, no auto-action, no gameplay/money effect, and
 * every path swallows its own errors — a bug here can only produce a log line.
 * Gated by the caller on INTEGRITY_FEED === 'on' (default OFF).
 */

import { fromHandHistoryRow, type HandHistoryRow } from './HandEventAdapter.js';
import { detectBots } from './BotDetector.js';
import { detectCollusion } from './CollusionDetector.js';
import type { IntegrityFlag, NormalizedHand } from './types.js';

/** True only when the operator explicitly opts in. Default OFF. */
export const INTEGRITY_FEED_ENABLED = process.env.INTEGRITY_FEED === 'on';

export interface IntegrityFeedOptions {
  /** Max hands retained in the rolling store. */
  maxHands?: number;
  /** Run the detectors once this many hands have accumulated since the last run. */
  analyzeEvery?: number;
  logger?: Pick<Console, 'warn'>;
}

/**
 * Bounded, in-memory accumulator + periodic detector runner. One process-wide
 * instance (exported below) is shared by every table's engine.
 */
export class IntegrityFeed {
  private readonly hands: NormalizedHand[] = [];
  private readonly maxHands: number;
  private readonly analyzeEvery: number;
  private readonly logger: Pick<Console, 'warn'>;
  private sinceAnalyze = 0;
  private handsIngested = 0;

  constructor(opts: IntegrityFeedOptions = {}) {
    this.maxHands = opts.maxHands ?? 5000;
    this.analyzeEvery = opts.analyzeEvery ?? 250;
    this.logger = opts.logger ?? console;
  }

  /** Fire-and-forget ingest of one persisted hand_history-shaped row. Never throws. */
  ingestRow(row: HandHistoryRow): void {
    try {
      const normalized = fromHandHistoryRow(row);
      this.hands.push(normalized);
      this.handsIngested++;
      if (this.hands.length > this.maxHands) this.hands.shift();
      if (++this.sinceAnalyze >= this.analyzeEvery) {
        this.sinceAnalyze = 0;
        this.analyze();
      }
    } catch {
      // observe-only: never surface into the caller
    }
  }

  /** Run detectors over the current store. Observe-only — logs flags, never acts. */
  analyze(): IntegrityFlag[] {
    try {
      const flags: IntegrityFlag[] = [...detectBots(this.hands), ...detectCollusion(this.hands)];
      if (flags.length > 0) {
        this.logger.warn(
          `[IntegrityFeed] ${flags.length} integrity flag(s) across ${this.hands.length} hands ` +
            `(observe-only, no enforcement): ` +
            flags
              .map((f) => `${f.type}:${f.severity}(${f.score.toFixed(2)})[${f.userIds.join(',')}]`)
              .join(' ')
        );
      }
      return flags;
    } catch {
      return [];
    }
  }

  /** Diagnostics: number of hands currently retained in the store. */
  size(): number {
    return this.hands.length;
  }

  /** Diagnostics: total hands ever ingested. */
  totalIngested(): number {
    return this.handsIngested;
  }
}

/** Process-wide singleton shared by every table engine. */
export const integrityFeed = new IntegrityFeed();
