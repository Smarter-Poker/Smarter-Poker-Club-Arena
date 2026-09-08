/**
 * NEXT-HAND GAP - what the felt actually waited between one hand's completion
 * and the next hand's deal, as a number on /health.
 *
 * Dan 2026-09-07: "LOTS OF HANDS ARE NOT STARTING THE NEXT HAND 2 SECONDS
 * AFTER THE HAND IS COMPLETED ... SOME UP TO 10 SECONDS+." Nothing in the
 * process measured that gap; it was inferred from hand_history timestamps by
 * hand, and from a one-second poll of /health's loopPhase strings, neither of
 * which an alert can read. This is the measurement: every engine records the
 * wall-clock distance from the end of its completion hold (the hand IS
 * completed - Dan 2026-08-21) to the instant it hands the roster to dealHand,
 * and how that distance split across loop phases. The fleet-wide window is
 * summarised on /health as `nextHandGap`.
 *
 * The number to watch is `over`: gaps that exceeded the rest by more than the
 * slack. The rest itself (HAND_COMPLETION.NEXT_HAND_REST_MS) is Dan's number
 * and a gap equal to it is the design; a gap well past it means the
 * bookkeeping did not fit inside the rest and the felt waited on a database.
 * The rebuy pause is excluded from the sample on purpose: it is a beat Dan
 * asked for, five seconds long, and counting it would page about a feature.
 */

export interface NextHandGapSample {
  readonly tableId: string;
  /** ms from completion to the deal. */
  readonly gapMs: number;
  /** ms spent in each loop phase between completion and the deal. */
  readonly phases: Readonly<Record<string, number>>;
  /** True when the gap contained a rebuy pause; such samples are kept but reported separately. */
  readonly rebuyPaused: boolean;
  readonly at: number;
}

export interface NextHandGapSnapshot {
  samples: number;
  restMs: number;
  p50Ms: number | null;
  p90Ms: number | null;
  maxMs: number | null;
  /** Samples (without a rebuy pause) whose gap exceeded restMs + slackMs. */
  over: number;
  slackMs: number;
  withRebuyPause: number;
  /** p50 of each phase's share, over the samples that visited it. */
  phaseP50Ms: Record<string, number>;
  windowMs: number;
}

const WINDOW_MS = 10 * 60_000;
const MAX_SAMPLES = 2000;
/** How far past the rest a gap may run before it counts as over. */
export const NEXT_HAND_GAP_SLACK_MS = 500;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}

export class NextHandGapRecorder {
  private samples: NextHandGapSample[] = [];

  constructor(private readonly restMs: number) {}

  record(sample: NextHandGapSample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES)
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  snapshot(now: number = Date.now()): NextHandGapSnapshot {
    const cutoff = now - WINDOW_MS;
    this.samples = this.samples.filter((s) => s.at >= cutoff);
    const plain = this.samples.filter((s) => !s.rebuyPaused);
    const gaps = plain.map((s) => s.gapMs).sort((a, b) => a - b);
    const phaseValues = new Map<string, number[]>();
    for (const s of plain) {
      for (const [phase, ms] of Object.entries(s.phases)) {
        const arr = phaseValues.get(phase) ?? [];
        arr.push(ms);
        phaseValues.set(phase, arr);
      }
    }
    const phaseP50Ms: Record<string, number> = {};
    for (const [phase, arr] of phaseValues) {
      arr.sort((a, b) => a - b);
      phaseP50Ms[phase] = Math.round(percentile(arr, 0.5) ?? 0);
    }
    return {
      samples: this.samples.length,
      restMs: this.restMs,
      p50Ms: percentile(gaps, 0.5),
      p90Ms: percentile(gaps, 0.9),
      maxMs: gaps.length ? gaps[gaps.length - 1] : null,
      over: gaps.filter((g) => g > this.restMs + NEXT_HAND_GAP_SLACK_MS).length,
      slackMs: NEXT_HAND_GAP_SLACK_MS,
      withRebuyPause: this.samples.length - plain.length,
      phaseP50Ms,
      windowMs: WINDOW_MS,
    };
  }
}
