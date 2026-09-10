/**
 * Backlog gauges for public.hand_projection_outbox.
 *
 * WHY (2026-09-10). The outbox was 100,888 rows deep, the oldest five hours
 * old, and nothing on /metrics said so: the drain in ./handProjection.ts
 * counted its wakes but not what it was behind. Two gauges, one cheap query
 * a minute, so the backlog is a number Prometheus can alert on
 * (HandProjectionOutboxBacklog in infra/monitoring/alert-rules.yml) instead of
 * a fact somebody notices in pg_stat_user_tables.
 *
 * The query is one PostgREST GET with Prefer: count=exact and
 * `order=hand_number.asc&limit=1`: count(*) over the outbox plus its lowest
 * hand_number row via idx_hand_projection_outbox_table_hand's sibling unique
 * index. hand_number is a platform-wide monotonic sequence, so the lowest
 * pending hand_number is the oldest pending row for every purpose an alert
 * has. No created_at index is needed and none is added.
 *
 * Its own collector, on the leader only, started beside the projection worker
 * (GameServer step 8b). A failed sample never zeroes a good one: the stale
 * gauge climbs instead, and that is what the Blind alert reads.
 */

import { supabase } from './client.js';
import { reportError, describeError } from '../errorReporter.js';

export const HAND_OUTBOX_SAMPLE_MS_DEFAULT = 60_000;

export type HandOutboxSample = {
  /** Rows pending. -1 until the first successful sample. */
  depth: number;
  /** Seconds the oldest pending row has waited. 0 when the outbox is empty. */
  oldestAgeSeconds: number;
  /** Epoch ms of the last SUCCESSFUL sample. 0 means never. */
  sampledAt: number;
};

type OutboxHead = { created_at: string | null };

export class HandOutboxMetrics {
  private sample: HandOutboxSample = { depth: -1, oldestAgeSeconds: 0, sampledAt: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private consecutiveFailures = 0;
  private reportedBlind = false;
  private readonly refreshMs: number;

  constructor(refreshMs?: number) {
    const raw = process.env.HAND_PROJECTION_OUTBOX_SAMPLE_MS;
    const fromEnv = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    const chosen =
      refreshMs ?? (Number.isFinite(fromEnv) ? fromEnv : HAND_OUTBOX_SAMPLE_MS_DEFAULT);
    this.refreshMs = Math.min(600_000, Math.max(5_000, Math.trunc(chosen)));
  }

  get intervalMs(): number {
    return this.refreshMs;
  }

  /** Idempotent: a second start() while running is a no-op, never a second interval. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): HandOutboxSample {
    return { ...this.sample };
  }

  /** Never throws, never zeroes a good sample on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { data, error, count } = await supabase
        .from('hand_projection_outbox')
        .select('created_at', { count: 'exact' })
        .order('hand_number', { ascending: true })
        .limit(1);
      if (error) {
        this.noteFailure(describeError(error));
        return;
      }
      const depth = typeof count === 'number' && Number.isFinite(count) ? count : null;
      if (depth === null) {
        this.noteFailure('no exact count in the response');
        return;
      }
      const head = ((data ?? []) as OutboxHead[])[0];
      const oldestMs = head?.created_at ? Date.parse(head.created_at) : NaN;
      const oldestAgeSeconds =
        depth === 0 || !Number.isFinite(oldestMs)
          ? 0
          : Math.max(0, Math.round((Date.now() - oldestMs) / 1000));
      this.sample = { depth, oldestAgeSeconds, sampledAt: Date.now() };
      this.consecutiveFailures = 0;
      this.reportedBlind = false;
    } catch (err) {
      this.noteFailure(describeError(err));
    } finally {
      this.refreshing = false;
    }
  }

  /** Reported ONCE per outage, not once per attempt. */
  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3 && !this.reportedBlind) {
      this.reportedBlind = true;
      reportError(
        new Error(
          `[HandOutboxMetrics] ${this.consecutiveFailures} consecutive sample failures (${reason}) - poker_hand_projection_outbox_* gauges are STALE`
        ),
        'HandOutboxMetrics.refresh_failed'
      );
    }
  }

  toPrometheus(now: number = Date.now()): string[] {
    const s = this.sample;
    const staleSeconds =
      s.sampledAt === 0 ? -1 : Math.max(0, Math.round((now - s.sampledAt) / 1000));
    return [
      '# HELP poker_hand_projection_outbox_depth Rows waiting in hand_projection_outbox; -1 until first sampled.',
      '# TYPE poker_hand_projection_outbox_depth gauge',
      `poker_hand_projection_outbox_depth ${s.depth}`,
      '# HELP poker_hand_projection_outbox_oldest_age_seconds Age of the oldest pending outbox row (lowest hand_number); 0 when empty.',
      '# TYPE poker_hand_projection_outbox_oldest_age_seconds gauge',
      `poker_hand_projection_outbox_oldest_age_seconds ${s.oldestAgeSeconds}`,
      '# HELP poker_hand_projection_outbox_sample_age_seconds Seconds since the outbox gauges were last refreshed; -1 when never.',
      '# TYPE poker_hand_projection_outbox_sample_age_seconds gauge',
      `poker_hand_projection_outbox_sample_age_seconds ${staleSeconds}`,
    ];
  }
}
