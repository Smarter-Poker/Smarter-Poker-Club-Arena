/** Bounded evidence for one hand, never an authority, timer or operation owner. */
const STAGES = new Set([
  'hand_history',
  'rake_distribution',
  'bbj_contribution',
  'promo_playthrough',
  'insurance_ledger',
  'bbj_mini_payout',
  'bbj_payout',
  'tournament_chip_sync',
  'pending_addons',
  'horse_rebuys',
  'horse_top_ups',
  'chip_continuity',
  'horse_cashouts',
  'horse_table_talk',
  'deferred_sitouts',
  'leave_pending',
  'table_unlock',
  'post_commit_obligations',
  'committed_seat_refresh',
  'addon_announcement',
  'lane_join',
]);
const LANES = new Set(['record', 'seats', 'barrier']);
const OUTCOMES = new Set(['queued', 'pending', 'returned', 'threw', 'lifecycle_denied', 'handoff']);
const MAX_STAGES = 24;
const MAX_MS = 24 * 60 * 60_000;
export type PostHandLane = 'record' | 'seats' | 'barrier';
export type PostHandOutcome = 'returned' | 'threw' | 'lifecycle_denied' | 'handoff';
export interface CompletionHoldStamp {
  handNumber: number;
  atMs: number;
  monotonicMs: number;
}
interface StageRow {
  name: string;
  lane: PostHandLane;
  outcome: string;
  queued: number | null;
  started: number | null;
  finished: number | null;
}
export interface PostHandStageSnapshot {
  schema: 'post-hand-stages/v1';
  handNumber: number;
  pipelineComplete: boolean;
  holdEndedAtMs: number | null;
  captureIncomplete: boolean;
  truncated: boolean;
  /** These spans may overlap. Their durations must never be added as a gap. */
  overlappingStages: true;
  stages: Array<{
    name: string;
    lane: PostHandLane;
    outcome: string;
    queuedOffsetMs: number | null;
    startedOffsetMs: number | null;
    finishedOffsetMs: number | null;
    elapsedMs: number | null;
    postHoldMs: number | null;
  }>;
}
const noopSpan = { start() {}, finish(_outcome: PostHandOutcome) {} };

export class PostHandStageTiming {
  private rows: StageRow[] = [];
  private incomplete = false;
  private truncated = false;
  private pipelineComplete = false;
  constructor(
    readonly handNumber: number,
    private readonly now = () => performance.now()
  ) {}

  private clock(): number | null {
    try {
      const value = this.now();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* A failed diagnostic clock must not interrupt settlement. */
    }
    this.incomplete = true;
    return null;
  }

  queue(name: string, lane: PostHandLane) {
    if (!STAGES.has(name) || !LANES.has(lane) || this.rows.length >= MAX_STAGES) {
      this.truncated = true;
      return noopSpan;
    }
    const row: StageRow = {
      name,
      lane,
      outcome: 'queued',
      queued: this.clock(),
      started: null,
      finished: null,
    };
    this.rows.push(row);
    return {
      start: () => {
        if (row.outcome !== 'queued') return;
        row.started = this.clock();
        row.outcome = 'pending';
      },
      finish: (outcome: PostHandOutcome) => {
        if (row.outcome !== 'queued' && row.outcome !== 'pending') return;
        row.finished = this.clock();
        row.outcome = outcome;
      },
    };
  }

  start(name: string, lane: PostHandLane) {
    const span = this.queue(name, lane);
    span.start();
    return span.finish;
  }

  complete(): void {
    this.pipelineComplete = true;
  }

  snapshot(anchor?: CompletionHoldStamp | null): PostHandStageSnapshot | null {
    if (!Number.isSafeInteger(this.handNumber) || this.handNumber < 0) return null;
    const now = this.clock();
    const hold =
      anchor?.handNumber === this.handNumber &&
      Number.isFinite(anchor.monotonicMs) &&
      Number.isFinite(anchor.atMs)
        ? anchor
        : null;
    let incomplete = this.incomplete;
    const delta = (
      end: number | null | undefined,
      start: number | null | undefined,
      signed = false
    ) => {
      if (end == null || start == null) return null;
      const value = end - start;
      if (!Number.isFinite(value) || Math.abs(value) > MAX_MS || (!signed && value < 0)) {
        incomplete = true;
        return null;
      }
      return Math.round(value * 1000) / 1000;
    };
    const stages = this.rows.map((row) => {
      const until = row.outcome === 'pending' ? now : row.finished;
      return {
        name: row.name,
        lane: row.lane,
        outcome: row.outcome,
        queuedOffsetMs: delta(row.queued, hold?.monotonicMs, true),
        startedOffsetMs: delta(row.started, hold?.monotonicMs, true),
        finishedOffsetMs: delta(row.finished, hold?.monotonicMs, true),
        elapsedMs: delta(until, row.started),
        postHoldMs:
          hold && until != null && row.started != null
            ? delta(Math.max(until, hold.monotonicMs), Math.max(row.started, hold.monotonicMs))
            : null,
      };
    });
    return {
      schema: 'post-hand-stages/v1',
      handNumber: this.handNumber,
      pipelineComplete: this.pipelineComplete,
      holdEndedAtMs: hold?.atMs ?? null,
      captureIncomplete: incomplete,
      truncated: this.truncated,
      overlappingStages: true,
      stages,
    };
  }
}

/** Copy a fixed public contract, never the engine object or arbitrary metadata. */
export function copyPostHandStageSnapshot(value: unknown): PostHandStageSnapshot | null {
  try {
    const v = value as PostHandStageSnapshot | null;
    const number = (n: unknown, signed = false): n is number | null =>
      n === null ||
      (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_MS && (signed || n >= 0));
    if (
      !v ||
      v.schema !== 'post-hand-stages/v1' ||
      !Number.isSafeInteger(v.handNumber) ||
      v.handNumber < 0 ||
      typeof v.pipelineComplete !== 'boolean' ||
      typeof v.captureIncomplete !== 'boolean' ||
      typeof v.truncated !== 'boolean' ||
      v.overlappingStages !== true ||
      (v.holdEndedAtMs !== null &&
        (typeof v.holdEndedAtMs !== 'number' ||
          !Number.isFinite(v.holdEndedAtMs) ||
          v.holdEndedAtMs < 0)) ||
      !Array.isArray(v.stages) ||
      v.stages.length > MAX_STAGES
    )
      return null;
    const stages: PostHandStageSnapshot['stages'] = [];
    for (const s of v.stages) {
      if (
        !s ||
        !STAGES.has(s.name) ||
        !LANES.has(s.lane) ||
        !OUTCOMES.has(s.outcome) ||
        !number(s.queuedOffsetMs, true) ||
        !number(s.startedOffsetMs, true) ||
        !number(s.finishedOffsetMs, true) ||
        !number(s.elapsedMs) ||
        !number(s.postHoldMs)
      )
        return null;
      stages.push({
        name: s.name,
        lane: s.lane,
        outcome: s.outcome,
        queuedOffsetMs: s.queuedOffsetMs,
        startedOffsetMs: s.startedOffsetMs,
        finishedOffsetMs: s.finishedOffsetMs,
        elapsedMs: s.elapsedMs,
        postHoldMs: s.postHoldMs,
      });
    }
    return {
      schema: v.schema,
      handNumber: v.handNumber,
      pipelineComplete: v.pipelineComplete,
      holdEndedAtMs: v.holdEndedAtMs,
      captureIncomplete: v.captureIncomplete,
      truncated: v.truncated,
      overlappingStages: true,
      stages,
    };
  } catch {
    return null;
  }
}
