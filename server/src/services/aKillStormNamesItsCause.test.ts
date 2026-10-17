/**
 * THE KILL-STORM PAGE NAMES ITS CAUSE (2026-10-17).
 *
 * The 12:57Z storm paged "74 engine kills in 15min" and nothing else; the
 * cause - every kill `start_failed:start_load_table`, 42 tables - had to be
 * read out of engine_recovery_events by hand. The verifier now reads the kill
 * rows back and puts the table count and the top causes on the alert. That
 * read is best effort: when it fails, the alert is raised exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { count?: number | null; data?: unknown; error?: unknown };
let countAnswer: Answer = { count: 0, error: null };
let rowsAnswer: Answer | Error = { data: [], error: null };

/** A query chain that answers by its select: the count head, or the rows. */
function chain(columns: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'in']) q[m] = () => q;
  q.gt = () => {
    if (columns === 'id') return Promise.resolve(countAnswer);
    return {
      limit: () =>
        rowsAnswer instanceof Error ? Promise.reject(rowsAnswer) : Promise.resolve(rowsAnswer),
    };
  };
  return q;
}

vi.mock('./supabase.js', () => ({
  supabase: { from: () => ({ select: (columns: string) => chain(columns) }) },
}));

const raised: Array<{
  alertname: string;
  summary: string;
  description: string;
  labels?: Record<string, string>;
}> = [];
vi.mock('./engineAlerts.js', () => ({
  raiseEngineAlert: async (input: (typeof raised)[number]) => {
    raised.push(input);
    return true;
  },
  resolveEngineAlert: async () => true,
}));

const { DealRateVerifier } = await import('./DealRateVerifier.js');

async function storm(): Promise<(typeof raised)[number]> {
  const v = new DealRateVerifier(() => []) as any;
  await v.checkKillRate(null);
  // launchAlert detaches the write; let it land.
  await new Promise((r) => setTimeout(r, 0));
  const alert = raised.find((a) => a.alertname === 'ClubArenaEngineKillStorm');
  expect(alert).toBeDefined();
  return alert!;
}

beforeEach(() => {
  raised.length = 0;
  countAnswer = { count: 0, error: null };
  rowsAnswer = { data: [], error: null };
});

describe('the kill-storm page names its cause', () => {
  it('says how many tables and which phase, most frequent first', async () => {
    countAnswer = { count: 74, error: null };
    const rows = [
      ...Array.from({ length: 57 }, (_, i) => ({
        detail: 'start_failed:start_crash_recovery',
        table_id: 't' + (i % 40),
      })),
      ...Array.from({ length: 17 }, (_, i) => ({
        detail: 'dealing_loop_died+' + (90 + i) + 's',
        table_id: 'u' + (i % 2),
      })),
    ];
    rowsAnswer = { data: rows, error: null };

    const alert = await storm();

    expect(alert.summary).toBe(
      '74 engine kills in 15min on 42 tables, most at start_failed:start_crash_recovery - tables are being destroyed and rebuilt in a loop'
    );
    // The elapsed suffix does not split one cause into seventeen.
    expect(alert.description).toContain(
      'start_failed:start_crash_recovery x57, dealing_loop_died x17'
    );
    expect(alert.labels).toEqual({
      kills: '74',
      tables: '42',
      top_cause: 'start_failed:start_crash_recovery',
    });
  });

  it('still pages, as before, when the breakdown cannot be read', async () => {
    countAnswer = { count: 74, error: null };
    rowsAnswer = new Error('fetch failed');

    const alert = await storm();

    expect(alert.summary).toBe(
      '74 engine kills in 15min - tables are being destroyed and rebuilt in a loop'
    );
    expect(alert.labels).toEqual({ kills: '74' });
  });
});
