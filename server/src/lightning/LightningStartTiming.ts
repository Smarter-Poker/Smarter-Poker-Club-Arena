/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHERE A LIGHTNING HAND'S START SPENDS ITS TIME (2026-10-26)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `match_to_hand` measured ~1.74 s at p50, almost all of it fixed overhead in
 * LightningHandHost.start(). One number cannot say whether that is the
 * database or this process: a round trip that answered in 200 ms and a
 * callback that ran 600 ms late look the same from the outside.
 *
 * This is the fold timing's pattern (LightningFoldTiming) for the start path:
 * a mark per step (begin_dealing, hand number, bind, participants, rules,
 * time banks, dealt), each on the monotonic clock, plus how late a 50 ms
 * interval ran while the start was in flight - the event loop's own delay,
 * which no round trip can produce. A slow start is logged as one bounded JSON
 * line; nothing else is recorded (no card, no stack, no player id), nothing
 * is retried and nothing here can change the start's outcome.
 */
import { performance } from 'node:perf_hooks';

const MAX_MS = 900_000;
/** A start this slow (from its formation) is worth a line. */
const SLOW_MS = 1_000;
const MAX_LINES = 20;
const WINDOW_MS = 60_000;
const INTERVAL_MS = 50;
const MAX_MARKS = 16;

const bounded = (n: number): number =>
  Number.isFinite(n) ? Math.round(Math.max(0, Math.min(MAX_MS, n)) * 10) / 10 : 0;

export interface LightningStartSpan {
  /** A step finished: its offset from the start() call. The first mark of a name wins. */
  mark(step: string): void;
  /** The start is over (dealt, abandoned or failed). Idempotent; logs a slow one. */
  finish(outcome: string): void;
}

export function createLightningStartTiming(
  deps: { now?: () => number; log?: (line: string) => void; wallNow?: () => number } = {}
) {
  const now = deps.now ?? (() => performance.now());
  const wallNow = deps.wallNow ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let windowStart = now();
  let emitted = 0;
  let omitted = 0;

  /**
   * One start. `formedAtMs` is the wall-clock moment the formation pass
   * returned (LightningFormedHand.formedAtMs): the gap to this call is time
   * the formed hand waited in this process before its host ran at all.
   */
  function begin(handId: string, formedAtMs: number): LightningStartSpan {
    const startedAt = now();
    const formedToStartMs = bounded(wallNow() - formedAtMs);
    const marks: Array<[string, number]> = [];
    let timerLateMs = 0;
    let expected = startedAt + INTERVAL_MS;
    let done = false;
    const timer = setInterval(() => {
      const sampledAt = now();
      timerLateMs = Math.max(timerLateMs, bounded(sampledAt - expected));
      expected = sampledAt + INTERVAL_MS;
    }, INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
    return {
      mark(step) {
        if (done || marks.length >= MAX_MARKS || marks.some(([s]) => s === step)) return;
        marks.push([step, bounded(now() - startedAt)]);
      },
      finish(outcome) {
        if (done) return;
        done = true;
        clearInterval(timer);
        const finishedAt = now();
        // A blocked loop can finish the start before its overdue interval runs.
        timerLateMs = Math.max(timerLateMs, bounded(finishedAt - expected));
        const startMs = bounded(finishedAt - startedAt);
        if (formedToStartMs + startMs < SLOW_MS) return;
        if (finishedAt - windowStart >= WINDOW_MS) {
          windowStart = finishedAt;
          emitted = 0;
        }
        if (emitted >= MAX_LINES) {
          omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
          return;
        }
        emitted++;
        const report = {
          version: 1,
          handId,
          outcome,
          formedToStartMs,
          startMs,
          timerLateMs: bounded(timerLateMs),
          steps: Object.fromEntries(marks),
          omitted,
        };
        omitted = 0;
        try {
          log('[LightningStartTiming] ' + JSON.stringify(report));
        } catch {
          /* observer only */
        }
      },
    };
  }

  return { begin };
}

const processTiming = createLightningStartTiming();

/** The process-wide start timing (LightningHandHost.start). */
export function beginLightningStartTiming(handId: string, formedAtMs: number): LightningStartSpan {
  return processTiming.begin(handId, formedAtMs);
}
