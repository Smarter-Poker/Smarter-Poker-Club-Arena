/**
 * StatsHealthMonitor - the stats pipeline's pulse, read once a minute and
 * published on /health (`stats`) and /metrics (`poker_stats_*`).
 *
 * WHY THIS EXISTS (Stats Page Programme, phase 1, 2026-09-04)
 * ------------------------------------------------------------
 * On 2026-09-03 the player -> hand index (`ca_hand_player_idx`) was found
 * SEVENTEEN HOURS behind the hands it indexes. "Hands Played" on every stats
 * page was stale by that much, and nothing on the platform said so: the
 * roller lives in pg_cron and an Open Claw route, neither of which has an
 * alert path, and the engine - the one process that does - never looked.
 *
 * So the engine looks. `ca_stats_health()` is a ~150 ms SECURITY DEFINER read
 * (service_role only) that returns:
 *
 *   indexLagSeconds          now() minus the index ceiling
 *   recentHandsWithoutStat   hands from the last 3.5 minutes (less a 90 s
 *                            write grace) that have no ca_hand_player_stat
 *                            row - the live trigger failed if this is > 0
 *   repair.*                 where the money repair cursor is
 *   lastAudit.*              what the 15-minute witness audit last found:
 *                            button_seat vs the blind posts, the derived
 *                            showdown flag vs the engine's showdown roster,
 *                            and the three coverage gaps (no stat row, no
 *                            index row, no settlement row)
 *
 * The monitor raises through the same engine alert path as clock skew
 * (raiseEngineAlert / resolveEngineAlert), so a lagging index or a witness
 * disagreement lands in Sentry and Alertmanager within a minute of the read
 * that saw it, and resolves itself on the next healthy read.
 *
 * TWO THINGS IT MUST NEVER DO
 *   - Block anything. A slow or failed read leaves the last snapshot in place
 *     with `stale: true`; the engine's own liveness is not this.
 *   - Page about the maintenance break. During the hourly :55 freeze no hands
 *     are written, so the index ceiling stops moving for five minutes and the
 *     lag climbs to ~600 s. The threshold is 30 minutes, six times the break,
 *     and `paused()` (wired to MaintenanceBreak.isActive) suppresses the raise
 *     outright while a break is on (CLAUDE.md 13, rule 6).
 *
 * WHO WRITES THE STAT ROW, AND WHY THIS MONITOR HAD TO BE REWRITTEN
 * ------------------------------------------------------------------
 * When this file was written the answer was "the AFTER INSERT trigger
 * `trg_ca_stats_live_from_hand`, in the hand's own transaction". That stopped
 * being true on 2026-09-08. Migration
 * `20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path`
 * took five synchronous AFTER INSERT triggers off `hand_history` because they
 * were cancelling the hand they described (726 INSERTs cancelled in one
 * five-minute window on 2026-09-07), and moved their effects behind a durable
 * outbox. Every one of those trigger bodies now opens with
 *
 *     IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on'
 *       THEN RETURN NEW; END IF;
 *
 * and the accepted-hand RPC sets that GUC immediately before inserting the
 * hand. So on the path that deals 99.9998% of hands (548,234 of 548,235 in
 * the 24 h to 2026-09-12 05:00 UTC carried an atomic-commit receipt) the
 * trigger deliberately declines, a row lands in `hand_projection_outbox`, and
 * `fn_project_hand_side_effects` - woken by LISTEN/Realtime and drained by
 * `services/supabase/handProjection.ts` - writes `ca_hand_player_stat` seconds
 * later, in its own transaction.
 *
 * THREE CONSEQUENCES THIS MONITOR NOW HONOURS:
 *
 *   1. `recentHandsWithoutStat` is no longer "the trigger failed". It is "the
 *      projector has not caught up yet", and the 90 s grace in
 *      `ca_stats_health()` is the only allowance it gets. Under load that is
 *      routinely not enough, which is why this alert raised and resolved 32
 *      times in one night (2026-09-11) in a ~15-minute sawtooth: the
 *      compensating `ca_roll_hand_stats_forward` runs every 15 minutes, wipes
 *      the window clean for a read or two, and the window refills. Hysteresis
 *      (below) is what stops a 15-minute compensator driving a 60-second
 *      alarm.
 *   2. A COUNT cannot be read without its denominator. The old summary said
 *      "1 recent hand(s) have no stat row" while the real window held 1,109 -
 *      identical prose for 0.09% and for 100%. It reports the SHARE now.
 *   3. "The roll has not run" and "the live writer is not writing" are
 *      different incidents and must be distinguishable. `liveWriterBacklog`
 *      (the `hand_projection_outbox` sample that `HandOutboxMetrics` already
 *      takes once a minute) answers which: a gap with a backed-up outbox is
 *      the projector; a gap with an empty outbox is a writer defect. A sample
 *      that is missing or stale renders as UNKNOWN, never as clean.
 */

/**
 * The live writer's queue, as `HandOutboxMetrics` last sampled it. Structurally
 * the same object that class returns, so GameServer can hand it straight over.
 */
export interface StatsWriterBacklog {
  /** Rows pending in hand_projection_outbox; -1 until the first sample. */
  depth: number;
  /** Seconds the oldest pending row has waited; 0 when the outbox is empty. */
  oldestAgeSeconds: number;
  /** Epoch ms of the last SUCCESSFUL sample; 0 means never. */
  sampledAt: number;
}

/** What the monitor concluded about the writer, for the alert's own words. */
export type LiveWriterVerdict = 'current' | 'behind' | 'unknown';

export interface StatsHealthSnapshot {
  checkedAt: string;
  indexCeil: string | null;
  indexLagSeconds: number | null;
  indexBackfillComplete: boolean | null;
  indexRows: number | null;
  recentHands: number | null;
  recentHandsWithoutStat: number | null;
  repair: {
    done: boolean | null;
    cursorAt: string | null;
    ceilingAt: string | null;
    handsSeen: number | null;
    rowsChanged: number | null;
    updatedAt: string | null;
  } | null;
  seatBackfill: {
    done: boolean | null;
    cursorAt: string | null;
    rowsAdded: number | null;
  } | null;
  /**
   * Phase 3: all-in equity coverage over the last 7 days, from the last audit.
   * A seat that was all-in before the river, reached showdown, and saw no
   * further betting after the hand's last all-in was in an all-in RUNOUT and
   * owes an equity figure (the EV line on the stats page is built from it).
   * River all-ins have nothing left to run out; a side pot that kept betting
   * was never a runout. Neither is counted.
   */
  evCoverage7d: {
    allInShowdowns: number | null;
    withoutEquity: number | null;
    ratio: number | null;
  } | null;
  lastAudit: {
    ranAt: string | null;
    hands: number | null;
    buttonDisagree: number | null;
    showdownDisagree: number | null;
    handsWithoutStat: number | null;
    playerHandsWithoutIdx: number | null;
    humanPlayerHands: number | null;
    humanWithoutFacts: number | null;
    durationMs: number | null;
  } | null;
}

export interface StatsHealthPublished extends StatsHealthSnapshot {
  /** True when the last read failed and this snapshot is older than one period. */
  stale: boolean;
  /** Milliseconds since the snapshot was taken, at publish time. */
  ageMs: number;
  lastError: string | null;
}

export interface StatsHealthAlert {
  alertname: string;
  severity: 'warning' | 'critical';
  component: string;
  summary: string;
  description?: string;
  labels?: Record<string, string>;
}

export interface StatsHealthMonitorDeps {
  /** One round trip to `ca_stats_health()`; resolves to the jsonb it returns. */
  read: () => Promise<unknown>;
  raise: (alert: StatsHealthAlert) => Promise<unknown> | unknown;
  resolve: (alertname: string, component: string, note: string) => Promise<unknown> | unknown;
  /** True while a maintenance break is on; suppresses the lag alert. */
  paused: () => boolean;
  /**
   * The hand-projection outbox sample, or null when this engine does not take
   * one. It is what separates "the projector is behind" from "a writer is
   * broken", and its ABSENCE is a third answer, not a clean bill of health.
   */
  liveWriterBacklog?: () => StatsWriterBacklog | null;
  now?: () => number;
  log?: (msg: string) => void;
}

export const STATS_HEALTH_COMPONENT = 'club-arena-stats';
export const STATS_INDEX_LAG_ALERT = 'ClubArenaStatsIndexLag';
export const STATS_TRIGGER_GAP_ALERT = 'ClubArenaStatsTriggerGap';
export const STATS_WITNESS_ALERT = 'ClubArenaStatsWitnessDisagree';
export const STATS_EV_COVERAGE_ALERT = 'ClubArenaStatsEvCoverage';

/** 30 minutes: six maintenance breaks, two Open Claw ticks. */
export const STATS_INDEX_LAG_THRESHOLD_S = 30 * 60;
export const STATS_HEALTH_PERIOD_MS = 60 * 1000;
/**
 * EV coverage: raise when fewer than 99% of the week's all-in RUNOUTS carry
 * an equity figure, once there are enough of them to mean anything. The
 * audit counts a seat as owed equity only when it was all-in before the
 * river, reached showdown, and no check, bet or raise followed the hand's
 * last all-in (a side pot that keeps betting is not a runout and the engine
 * correctly prices nothing). Measured 2026-09-04: 715 owed, 1 missing,
 * 0.9986. The 99% bar is the programme's (item 1.4); fifty is the sample
 * floor so a quiet week cannot page on one hand.
 */
export const STATS_EV_COVERAGE_MIN_RATIO = 0.99;
export const STATS_EV_COVERAGE_MIN_SAMPLE = 50;

/**
 * THE STAT-GAP BAR, AND EVERY NUMBER IN IT IS MEASURED (CLAUDE.md 10.84).
 *
 * Source: `ca_stats_witness_audit_log`, the durable 15-minute record, read on
 * production 2026-09-12 05:05 UTC over the preceding 24 hours.
 *
 * SHARE (0.05). The audit reports `hands` and `hands_without_stat` for its
 * window, which is the same question this alert asks. Across 30 consecutive
 * runs the answer was bimodal with nothing in between: 22 runs read EXACTLY
 * 0/205, 0/5499, 0/216 ... 0.00%, and the 8 runs inside the 2026-09-11
 * 21:39-23:39 stall read 2556/3605, 2396/3423, 3519/3519, 10163/10163,
 * 6850/8246, 4597/6623, 1375/1375, 1793/2488 - 69.4% to 100%. Any bar between
 * 0 and 69% is equally defensible against that record; 0.05 sits just above
 * the noise floor so that a handful of hands still in flight at the edge of
 * the window cannot page, while the observed failure mode clears it 14x over.
 * A raw `> 0` (what this used to be) cannot tell those two apart at all.
 *
 * SAMPLE FLOOR (20 hands). `ca_stats_health()` looks at hands aged 90 s to
 * 3 m 30 s, so the window is two minutes of dealing. At the quietest measured
 * hour of the day (1,665 hands/h on 2026-09-12 03:00 UTC) that is ~55 hands;
 * at the peak (43,301 hands/h at 19:00 UTC) ~1,443. 20 is below even the
 * quiet-hour floor, so this excludes only a fleet that has effectively stopped
 * dealing - which is `ClubArenaFleetSilent`'s alarm, not this one. It is also
 * why the old summary could say "1 recent hand": during the 2026-09-11 kill
 * storm the window held single digits.
 *
 * HYSTERESIS (5 breaching reads to raise, 5 clean reads to clear). The alert
 * flapped 32 times in one night with a period of about 15 minutes. That is not
 * noise, it is the shape of the system: when the live writer stalls, the
 * compensating `ca_roll_hand_stats_forward` (every 15 minutes, Open Claw)
 * backfills up to now() and leaves the window clean for one or two 60-second
 * reads before it refills. Five consecutive CLEAN reads cannot be collected
 * inside that sawtooth, so a stall can no longer resolve itself every quarter
 * hour; five consecutive BREACHING reads mean a single slow projector drain
 * cannot page. Five reads is five minutes: a third of the compensator's period
 * and twice the width of its clean phase.
 */
export const STATS_TRIGGER_GAP_MIN_SHARE = 0.05;
export const STATS_TRIGGER_GAP_MIN_HANDS = 20;
export const STATS_TRIGGER_GAP_RAISE_TICKS = 5;
export const STATS_TRIGGER_GAP_CLEAR_TICKS = 5;

/**
 * How long the hand projector may be behind before its backlog is the answer
 * to "why is the window dirty". `ca_stats_health()` already excuses the newest
 * 90 seconds, so anything the outbox has still not drained after 120 s is
 * outside the allowance the gap measure itself gives.
 */
export const STATS_LIVE_WRITER_BACKLOG_GRACE_S = 120;
/**
 * `HandOutboxMetrics` samples once a minute and never zeroes a good sample on
 * failure - the sample just stops moving. Past five minutes (five missed
 * samples) it is no longer evidence about now, and this monitor must say
 * UNKNOWN rather than read a stale zero as "the projector is current".
 */
export const STATS_LIVE_WRITER_SAMPLE_MAX_AGE_S = 300;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Shape the jsonb from ca_stats_health() defensively; never throw on it. */
export function parseStatsHealth(raw: unknown, fallbackCheckedAt: string): StatsHealthSnapshot {
  const r = obj(raw) ?? {};
  const repair = obj(r.repair);
  const seatfill = obj(r.seatBackfill);
  const ev = obj(r.evCoverage7d);
  const audit = obj(r.lastAudit);
  return {
    checkedAt: str(r.checkedAt) ?? fallbackCheckedAt,
    indexCeil: str(r.indexCeil),
    indexLagSeconds: num(r.indexLagSeconds),
    indexBackfillComplete: bool(r.indexBackfillComplete),
    indexRows: num(r.indexRows),
    recentHands: num(r.recentHands),
    recentHandsWithoutStat: num(r.recentHandsWithoutStat),
    repair: repair
      ? {
          done: bool(repair.done),
          cursorAt: str(repair.cursorAt),
          ceilingAt: str(repair.ceilingAt),
          handsSeen: num(repair.handsSeen),
          rowsChanged: num(repair.rowsChanged),
          updatedAt: str(repair.updatedAt),
        }
      : null,
    seatBackfill: seatfill
      ? {
          done: bool(seatfill.done),
          cursorAt: str(seatfill.cursorAt),
          rowsAdded: num(seatfill.rowsAdded),
        }
      : null,
    evCoverage7d: ev
      ? {
          allInShowdowns: num(ev.allInShowdowns),
          withoutEquity: num(ev.withoutEquity),
          ratio: num(ev.ratio),
        }
      : null,
    lastAudit: audit
      ? {
          ranAt: str(audit.ranAt),
          hands: num(audit.hands),
          buttonDisagree: num(audit.buttonDisagree),
          showdownDisagree: num(audit.showdownDisagree),
          handsWithoutStat: num(audit.handsWithoutStat),
          playerHandsWithoutIdx: num(audit.playerHandsWithoutIdx),
          humanPlayerHands: num(audit.humanPlayerHands),
          humanWithoutFacts: num(audit.humanWithoutFacts),
          durationMs: num(audit.durationMs),
        }
      : null,
  };
}

export class StatsHealthMonitor {
  private snapshot: StatsHealthSnapshot | null = null;
  private snapshotAt = 0;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  /** Tick reads are local, but evaluate() posts durable alert transitions. */
  private readonly lifecycleJobs = new Set<Promise<unknown>>();
  private lifecycleGeneration = 0;
  private stopOperation: Promise<void> | null = null;
  /** Direct tick() probes are valid before start, but not after stop. */
  private acceptingTicks = true;
  private inFlight = false;
  /** Consecutive reads whose stat-gap share was at or above the bar. */
  private gapBreachingTicks = 0;
  /** Consecutive reads whose stat-gap share was below it. */
  private gapClearTicks = 0;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: StatsHealthMonitorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((m) => console.warn(m));
  }

  private lifecycleIsCurrent(generation: number): boolean {
    return this.isRunning && this.lifecycleGeneration === generation;
  }

  private lifecycleEnded(generation: number | null): boolean {
    return generation !== null && !this.lifecycleIsCurrent(generation);
  }

  private trackLifecycleJob<T>(job: Promise<T>): Promise<T> {
    const tracked = job.finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
    return tracked;
  }

  private openLifecycleScope(): () => void {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    void this.trackLifecycleJob(completion);
    return release;
  }

  private launchTick(generation: number): void {
    if (!this.lifecycleIsCurrent(generation)) return;
    void this.trackLifecycleJob(this.tick()).catch((error) =>
      this.log(`[StatsHealthMonitor] detached tick failed: ${(error as Error)?.message ?? error}`)
    );
  }

  /**
   * Own an alert POST independently from the surrounding tick. If shutdown
   * starts while the POST is in flight, stop joins it and this returns false
   * so evaluate() cannot publish a later transition from the stale snapshot.
   */
  private async deliverAlert(
    generation: number | null,
    work: () => Promise<unknown> | unknown
  ): Promise<boolean> {
    if (this.lifecycleEnded(generation)) return false;
    await this.trackLifecycleJob(
      Promise.resolve().then(() => {
        // The microtask itself is an admission boundary: stop can run after
        // deliverAlert queues it but before the callback begins.
        if (this.lifecycleEnded(generation)) return;
        return work();
      })
    );
    return !this.lifecycleEnded(generation);
  }

  private async drainLifecycleJobs(): Promise<void> {
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  start(periodMs = STATS_HEALTH_PERIOD_MS): void {
    if (this.stopOperation) {
      this.log('[StatsHealthMonitor] start refused while the prior generation is stopping');
      return;
    }
    if (this.timer) return;
    this.isRunning = true;
    this.acceptingTicks = true;
    const generation = ++this.lifecycleGeneration;
    this.launchTick(generation);
    this.timer = setInterval(() => this.launchTick(generation), periodMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;

    this.isRunning = false;
    this.acceptingTicks = false;
    this.lifecycleGeneration++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    const drain = this.drainLifecycleJobs();
    const trackedStop = drain.finally(() => {
      if (this.stopOperation === trackedStop) this.stopOperation = null;
    });
    this.stopOperation = trackedStop;
    return trackedStop;
  }

  /** One read + one evaluation. Public so a test can drive it without timers. */
  async tick(): Promise<void> {
    if (!this.acceptingTicks) return;
    const releaseLifecycle = this.openLifecycleScope();
    const generation = this.isRunning ? this.lifecycleGeneration : null;
    try {
      if (this.inFlight || this.lifecycleEnded(generation)) return;
      this.inFlight = true;
      try {
        const raw = await this.deps.read();
        if (this.lifecycleEnded(generation)) return;
        this.snapshot = parseStatsHealth(raw, new Date(this.now()).toISOString());
        this.snapshotAt = this.now();
        this.lastError = null;
        await this.evaluate(this.snapshot, generation);
      } catch (err) {
        if (this.lifecycleEnded(generation)) return;
        // A failed read is not a stats failure and never an engine failure:
        // keep the last snapshot, mark it stale, say why.
        this.lastError = (err as Error)?.message ?? String(err);
        this.log(`[StatsHealthMonitor] read failed: ${this.lastError}`);
      } finally {
        this.inFlight = false;
      }
    } finally {
      releaseLifecycle();
    }
  }

  /**
   * The share of the window's hands with no stat row, or null when the window
   * cannot answer: no denominator, or too few hands to mean anything. Null is
   * "could not tell" and is handled as its own outcome everywhere below.
   */
  private statGapShare(s: StatsHealthSnapshot): number | null {
    const hands = s.recentHands;
    const gap = s.recentHandsWithoutStat;
    if (hands === null || gap === null) return null;
    if (hands < STATS_TRIGGER_GAP_MIN_HANDS) return null;
    if (hands <= 0) return null;
    return gap / hands;
  }

  /**
   * Which writer the gap belongs to, in the alert's own words. The stat row on
   * the atomic path is written by `fn_project_hand_side_effects`, drained from
   * `hand_projection_outbox`; a backed-up outbox IS the explanation, an empty
   * one rules it out, and an unsampled one is not evidence either way.
   */
  private liveWriterVerdict(): { verdict: LiveWriterVerdict; phrase: string; depth: number } {
    const sample = this.deps.liveWriterBacklog?.() ?? null;
    if (sample === null)
      return {
        verdict: 'unknown',
        phrase:
          'the hand projection backlog is not sampled by this process, so which writer is behind is UNKNOWN',
        depth: -1,
      };
    if (sample.sampledAt === 0 || sample.depth < 0)
      return {
        verdict: 'unknown',
        phrase:
          'the hand projection backlog has never been sampled, so which writer is behind is UNKNOWN',
        depth: sample.depth,
      };
    const ageS = Math.max(0, Math.round((this.now() - sample.sampledAt) / 1000));
    if (ageS > STATS_LIVE_WRITER_SAMPLE_MAX_AGE_S)
      return {
        verdict: 'unknown',
        phrase: `the hand projection backlog sample is ${ageS}s old, too stale to read, so which writer is behind is UNKNOWN`,
        depth: sample.depth,
      };
    if (sample.depth > 0 && sample.oldestAgeSeconds > STATS_LIVE_WRITER_BACKLOG_GRACE_S)
      return {
        verdict: 'behind',
        phrase: `the hand projector is BEHIND: ${sample.depth} row(s) pending in hand_projection_outbox, oldest ${sample.oldestAgeSeconds}s`,
        depth: sample.depth,
      };
    return {
      verdict: 'current',
      phrase: `the hand projector is CURRENT (${sample.depth} pending), so this gap is not a drain backlog`,
      depth: sample.depth,
    };
  }

  /** What /health publishes under `stats`. */
  publish(): StatsHealthPublished | null {
    if (!this.snapshot) return null;
    const ageMs = Math.max(0, this.now() - this.snapshotAt);
    return {
      ...this.snapshot,
      stale: this.lastError !== null && ageMs > STATS_HEALTH_PERIOD_MS,
      ageMs,
      lastError: this.lastError,
    };
  }

  /** Prometheus exposition lines for /metrics. */
  prometheusLines(): string[] {
    const s = this.snapshot;
    const audit = s?.lastAudit;
    const disagree =
      audit && (audit.buttonDisagree !== null || audit.showdownDisagree !== null)
        ? (audit.buttonDisagree ?? 0) + (audit.showdownDisagree ?? 0)
        : null;
    const g = (name: string, help: string, v: number | null) => [
      `# HELP ${name} ${help}`,
      `# TYPE ${name} gauge`,
      `${name} ${v === null ? 'NaN' : v}`,
    ];
    return [
      ...g(
        'poker_stats_index_lag_seconds',
        'Seconds the player->hand index ceiling is behind now(); NaN when unread',
        s?.indexLagSeconds ?? null
      ),
      ...g(
        'poker_stats_recent_hands_without_stat',
        'Hands from the last 3.5 minutes (90 s grace) with no ca_hand_player_stat row; 0 is healthy',
        s?.recentHandsWithoutStat ?? null
      ),
      ...g(
        'poker_stats_recent_hands_without_stat_ratio',
        "Share of the health window's hands with no ca_hand_player_stat row; NaN when the window is too small to answer",
        s ? this.statGapShare(s) : null
      ),
      ...g(
        'poker_stats_stat_gap_breaching_reads',
        'Consecutive health reads whose stat-gap share was at or above the bar; the alert raises at STATS_TRIGGER_GAP_RAISE_TICKS',
        this.snapshot ? this.gapBreachingTicks : null
      ),
      ...g(
        'poker_stats_witness_disagreements',
        'button_seat vs blind posts plus derived showdown vs showdown roster, from the last witness audit; 0 is healthy',
        disagree
      ),
      ...g(
        'poker_stats_player_hands_without_idx',
        'Seats (any uuid-shaped id, horse or human) with no ca_hand_player_idx row, from the last witness audit; 0 is healthy',
        audit?.playerHandsWithoutIdx ?? null
      ),
      ...g(
        'poker_stats_human_hands_without_facts',
        'Human player-hands with no ca_hand_facts settlement row, from the last witness audit; 0 is healthy',
        audit?.humanWithoutFacts ?? null
      ),
      ...g(
        'poker_stats_money_repair_done',
        '1 once ca_repair_hand_player_stat_money has walked its whole backlog',
        s?.repair ? (s.repair.done ? 1 : 0) : null
      ),
      ...g(
        'poker_stats_ev_coverage_7d',
        'Share of all-in runout seats (pre-river all-in, reached showdown, no betting after the last all-in) in the last 7 days that carry an all-in equity figure; NaN when there were none',
        s?.evCoverage7d?.ratio ?? null
      ),
      ...g(
        'poker_stats_allin_showdowns_7d',
        'All-in runout seats in the last 7 days that owe an equity figure, from the last witness audit',
        s?.evCoverage7d?.allInShowdowns ?? null
      ),
      ...g(
        'poker_stats_health_age_seconds',
        'Seconds since the engine last read ca_stats_health() successfully',
        this.snapshot ? Math.round((this.now() - this.snapshotAt) / 1000) : null
      ),
    ];
  }

  private async evaluate(s: StatsHealthSnapshot, generation: number | null): Promise<void> {
    // 1. Index lag. Suppressed during a break (the ceiling cannot move while
    //    no hands are written), evaluated on the very next healthy read.
    const lag = s.indexLagSeconds;
    if (lag !== null && lag > STATS_INDEX_LAG_THRESHOLD_S && !this.deps.paused()) {
      if (
        !(await this.deliverAlert(generation, () =>
          this.deps.raise({
            alertname: STATS_INDEX_LAG_ALERT,
            severity: 'warning',
            component: STATS_HEALTH_COMPONENT,
            summary: `Stats hand index is ${Math.round(lag / 60)} minutes behind the hands`,
            description:
              'ca_hand_player_idx is advanced by /api/cron/club-stats-maintenance (Open Claw, ' +
              'every 15 minutes) and this lag means that route has not completed for two or more ' +
              'ticks. "Hands Played" on every stats page is stale by this much. Check the Open Claw ' +
              "dispatcher on the Hetzner host and the route's own errors array.",
            labels: { lag_seconds: String(Math.round(lag)) },
          })
        ))
      )
        return;
    } else if (lag !== null && lag <= STATS_INDEX_LAG_THRESHOLD_S) {
      if (
        !(await this.deliverAlert(generation, () =>
          this.deps.resolve(
            STATS_INDEX_LAG_ALERT,
            STATS_HEALTH_COMPONENT,
            'Stats hand index caught up'
          )
        ))
      )
        return;
    }

    // 2. The live stat writer. A hand still without a stat row 90 seconds
    //    after it committed means whoever owns that write on its path has not
    //    done it. Since 2026-09-08 that owner is NOT the trigger on the path
    //    that deals essentially every hand (see the header): it is
    //    fn_project_hand_side_effects, drained out of hand_projection_outbox.
    //    Three things this must get right, and the old version got none of
    //    them: report the SHARE, require the condition to PERSIST, and say
    //    WHICH writer - or say plainly that it could not tell.
    const gap = s.recentHandsWithoutStat;
    const hands = s.recentHands;
    const share = this.statGapShare(s);

    if (share === null) {
      // No denominator, or too few hands to mean anything. Neither confirms
      // the condition nor clears it: hold both counters and leave whatever is
      // firing exactly as it is. A window that cannot answer must never read
      // as an all-clear (AGENT-PLAYBOOK 8b).
      this.gapBreachingTicks = 0;
      this.gapClearTicks = 0;
    } else if (share >= STATS_TRIGGER_GAP_MIN_SHARE) {
      this.gapClearTicks = 0;
      this.gapBreachingTicks += 1;
      if (this.gapBreachingTicks >= STATS_TRIGGER_GAP_RAISE_TICKS) {
        const writer = this.liveWriterVerdict();
        const pct = (share * 100).toFixed(1);
        if (
          !(await this.deliverAlert(generation, () =>
            this.deps.raise({
              alertname: STATS_TRIGGER_GAP_ALERT,
              severity: 'warning',
              component: STATS_HEALTH_COMPONENT,
              summary:
                `${pct}% of recent hands have no stat row (${gap ?? 0} of ${hands ?? 0}), ` +
                `for ${this.gapBreachingTicks} consecutive reads`,
              description:
                'ca_hand_player_stat is written by fn_project_hand_side_effects, which the engine ' +
                'drains from hand_projection_outbox after the accepted-hand commit (see ' +
                'services/supabase/handProjection.ts). The AFTER INSERT trigger ' +
                'trg_ca_stats_live_from_hand declines on that path by design - it returns on its ' +
                'first statement when app.atomic_hand_commit is on - so there is NO ' +
                '"trg_ca_stats_live_from_hand:" line in the Postgres log to find, and looking for ' +
                'one is how this cost a full investigation on 2026-09-11. Start here instead: ' +
                `${writer.phrase}. Then poker_hand_projection_outbox_depth and ` +
                'poker_hand_projection_drain_results_total on /metrics, and ' +
                'SELECT count(*) FROM hand_projection_outbox. ca_roll_hand_stats_forward (Open ' +
                'Claw, every 15 minutes) will backfill the rows either way, so the money and the ' +
                'history are not at risk; the stats page is simply not live until this clears.',
              labels: {
                hands_without_stat: String(gap ?? 0),
                recent_hands: String(hands ?? 0),
                share: share.toFixed(4),
                breaching_reads: String(this.gapBreachingTicks),
                live_writer: writer.verdict,
                outbox_depth: String(writer.depth),
              },
            })
          ))
        )
          return;
      }
    } else {
      this.gapBreachingTicks = 0;
      this.gapClearTicks += 1;
      if (this.gapClearTicks >= STATS_TRIGGER_GAP_CLEAR_TICKS) {
        if (
          !(await this.deliverAlert(generation, () =>
            this.deps.resolve(
              STATS_TRIGGER_GAP_ALERT,
              STATS_HEALTH_COMPONENT,
              `Recent hands carry their stat rows again (${this.gapClearTicks} consecutive clean reads)`
            )
          ))
        )
          return;
      }
    }

    // 3. The witness audit. Zero is the only healthy number for all four.
    const a = s.lastAudit;
    if (a) {
      const bad =
        (a.buttonDisagree ?? 0) +
        (a.showdownDisagree ?? 0) +
        (a.handsWithoutStat ?? 0) +
        (a.playerHandsWithoutIdx ?? 0) +
        (a.humanWithoutFacts ?? 0);
      if (bad > 0) {
        if (
          !(await this.deliverAlert(generation, () =>
            this.deps.raise({
              alertname: STATS_WITNESS_ALERT,
              severity: 'warning',
              component: STATS_HEALTH_COMPONENT,
              summary:
                `Witness audit: ${a.buttonDisagree ?? 0} button, ${a.showdownDisagree ?? 0} showdown, ` +
                `${a.handsWithoutStat ?? 0} no-stat, ${a.playerHandsWithoutIdx ?? 0} no-index, ` +
                `${a.humanWithoutFacts ?? 0} no-facts disagreements`,
              description:
                'ca_stats_witness_audit() compares what the engine recorded (button_seat, the ' +
                'showdown roster) with the action log, and counts the seats the stat trigger, the ' +
                'index writer and the settlement writer missed. A non-zero count is a recording defect in the engine or ' +
                'a failed writer - read the latest ca_stats_witness_audit_log row and the hands in ' +
                'its window. Positions, WTSD and exact money on the stats page depend on these.',
              labels: {
                button_disagree: String(a.buttonDisagree ?? 0),
                showdown_disagree: String(a.showdownDisagree ?? 0),
                hands_without_stat: String(a.handsWithoutStat ?? 0),
                player_hands_without_idx: String(a.playerHandsWithoutIdx ?? 0),
                human_without_facts: String(a.humanWithoutFacts ?? 0),
              },
            })
          ))
        )
          return;
      } else {
        if (
          !(await this.deliverAlert(generation, () =>
            this.deps.resolve(STATS_WITNESS_ALERT, STATS_HEALTH_COMPONENT, 'Witness audit clean')
          ))
        )
          return;
      }
    }

    // 4. All-in equity coverage. The EV line on the stats page is only as
    //    honest as this ratio; a week with enough all-ins and a coverage
    //    below the bar means the settlement writer is dropping equity again.
    const ev = s.evCoverage7d;
    if (ev && ev.allInShowdowns !== null && ev.ratio !== null) {
      // Capture narrowed scalars before the alert callback. TypeScript cannot
      // assume a mutable object property stays non-null across a closure.
      const allInShowdowns = ev.allInShowdowns;
      const ratio = ev.ratio;
      if (allInShowdowns >= STATS_EV_COVERAGE_MIN_SAMPLE && ratio < STATS_EV_COVERAGE_MIN_RATIO) {
        if (
          !(await this.deliverAlert(generation, () =>
            this.deps.raise({
              alertname: STATS_EV_COVERAGE_ALERT,
              severity: 'warning',
              component: STATS_HEALTH_COMPONENT,
              summary:
                `All-in equity coverage is ${(ratio * 100).toFixed(1)}% over 7 days ` +
                `(${ev.withoutEquity ?? 0} of ${allInShowdowns} all-in runout seats without equity)`,
              description:
                'ca_hand_facts.all_in_equity is captured from the all_in_equity broadcast of every ' +
                'all-in runout and written at settlement. The EV line, "EV Adjusted" and the luck ' +
                'readouts on the stats page are computed from it, so a missing figure understates or ' +
                'overstates a player. Find the hands with ' +
                'SELECT hand_id FROM ca_hand_facts WHERE was_all_in AND went_to_showdown AND ' +
                "coalesce(all_in_street,'') <> 'river' AND all_in_equity IS NULL AND played_at >= now() - interval '7 days' " +
                '(then discard the ones whose action log shows betting after the last all-in: those ' +
                'were side pots, not runouts, and owe nothing).',
              labels: {
                allin_showdowns_7d: String(allInShowdowns),
                without_equity_7d: String(ev.withoutEquity ?? 0),
                ratio: ratio.toFixed(4),
              },
            })
          ))
        )
          return;
      } else if (
        ratio >= STATS_EV_COVERAGE_MIN_RATIO ||
        allInShowdowns < STATS_EV_COVERAGE_MIN_SAMPLE
      ) {
        if (
          !(await this.deliverAlert(generation, () =>
            this.deps.resolve(
              STATS_EV_COVERAGE_ALERT,
              STATS_HEALTH_COMPONENT,
              'All-in equity coverage is back above the bar'
            )
          ))
        )
          return;
      }
    }
  }
}
