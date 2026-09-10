/**
 * The projection backlog is a number on /metrics, refreshed by one cheap
 * query a minute, never zeroed by a failed sample.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { data: unknown; error: unknown; count: number | null };
const replies: Array<Reply | Promise<Reply>> = [];
const calls: Array<{
  columns: string;
  options: unknown;
  orderBy: string;
  ascending: boolean;
  limit: number;
}> = [];

vi.mock('./client.js', () => ({
  supabase: {
    from: (table: string) => {
      expect(table).toBe('hand_projection_outbox');
      const call = {} as (typeof calls)[number];
      return {
        select(columns: string, options: unknown) {
          call.columns = columns;
          call.options = options;
          return this;
        },
        order(column: string, options: { ascending: boolean }) {
          call.orderBy = column;
          call.ascending = options.ascending;
          return this;
        },
        limit(n: number) {
          call.limit = n;
          calls.push(call);
          return Promise.resolve(replies.shift() ?? { data: [], error: null, count: 0 });
        },
      };
    },
  },
}));

const mockReportError = vi.fn();
vi.mock('../errorReporter.js', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  describeError: (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e)),
}));

const { HandOutboxMetrics, HAND_OUTBOX_SAMPLE_MS_DEFAULT } = await import('./handOutboxMetrics.js');

beforeEach(() => {
  replies.length = 0;
  calls.length = 0;
  mockReportError.mockReset();
  vi.unstubAllEnvs();
});

describe('HandOutboxMetrics', () => {
  it('asks for the exact count and the lowest hand_number row in one request', async () => {
    const m = new HandOutboxMetrics();
    const oldest = new Date(Date.now() - 90_000).toISOString();
    replies.push({ data: [{ created_at: oldest }], error: null, count: 100_888 });
    await m.refresh();
    expect(calls).toEqual([
      {
        columns: 'created_at',
        options: { count: 'exact' },
        orderBy: 'hand_number',
        ascending: true,
        limit: 1,
      },
    ]);
    const s = m.get();
    expect(s.depth).toBe(100_888);
    expect(s.oldestAgeSeconds).toBeGreaterThanOrEqual(89);
    expect(s.oldestAgeSeconds).toBeLessThanOrEqual(92);
    const lines = m.toPrometheus();
    expect(lines).toContain('poker_hand_projection_outbox_depth 100888');
    expect(
      lines.some((l) => /^poker_hand_projection_outbox_oldest_age_seconds (89|9[0-2])$/.test(l))
    ).toBe(true);
    expect(lines).toContain('poker_hand_projection_outbox_sample_age_seconds 0');
  });

  it('an empty outbox is depth 0 and age 0; before the first sample it is -1', () => {
    const m = new HandOutboxMetrics();
    expect(m.toPrometheus()).toContain('poker_hand_projection_outbox_depth -1');
    expect(m.toPrometheus()).toContain('poker_hand_projection_outbox_sample_age_seconds -1');
  });

  it('empty outbox reads as 0 rows, 0 age', async () => {
    const m = new HandOutboxMetrics();
    replies.push({ data: [], error: null, count: 0 });
    await m.refresh();
    expect(m.get()).toMatchObject({ depth: 0, oldestAgeSeconds: 0 });
  });

  it('a failed sample keeps the last good numbers and reports once after three failures', async () => {
    const m = new HandOutboxMetrics();
    replies.push({ data: [{ created_at: new Date().toISOString() }], error: null, count: 12 });
    await m.refresh();
    for (let i = 0; i < 4; i++) {
      replies.push({ data: null, error: { message: 'timeout' }, count: null });
      await m.refresh();
    }
    expect(m.get().depth).toBe(12);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toBe('HandOutboxMetrics.refresh_failed');
    // The stale gauge is what an alert reads.
    expect(m.toPrometheus(m.get().sampledAt + 700_000)).toContain(
      'poker_hand_projection_outbox_sample_age_seconds 700'
    );
  });

  it('samples once a minute by default, once per start(), and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const m = new HandOutboxMetrics();
      expect(m.intervalMs).toBe(HAND_OUTBOX_SAMPLE_MS_DEFAULT);
      m.start();
      m.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(HAND_OUTBOX_SAMPLE_MS_DEFAULT * 2);
      expect(calls).toHaveLength(3);
      m.stop();
      await vi.advanceTimersByTimeAsync(HAND_OUTBOX_SAMPLE_MS_DEFAULT * 3);
      expect(calls).toHaveLength(3);
      m.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(4);
      m.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('HAND_PROJECTION_OUTBOX_SAMPLE_MS is bounded and an empty value means the default', () => {
    vi.stubEnv('HAND_PROJECTION_OUTBOX_SAMPLE_MS', '');
    expect(new HandOutboxMetrics().intervalMs).toBe(HAND_OUTBOX_SAMPLE_MS_DEFAULT);
    vi.stubEnv('HAND_PROJECTION_OUTBOX_SAMPLE_MS', '10');
    expect(new HandOutboxMetrics().intervalMs).toBe(5_000);
    vi.stubEnv('HAND_PROJECTION_OUTBOX_SAMPLE_MS', '30000');
    expect(new HandOutboxMetrics().intervalMs).toBe(30_000);
  });
});
