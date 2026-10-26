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
/** tables rows (id, tournament_id) and tournaments rows (id, name) the lookups answer with. */
let tablesAnswer: Answer | Error = { data: [], error: null };
let tournamentsAnswer: Answer | Error = { data: [], error: null };
const settle = (a: Answer | Error) => (a instanceof Error ? Promise.reject(a) : Promise.resolve(a));

/** A query chain that answers by the table and its select: the count head, the kill rows, or a lookup. */
function chain(table: string, columns: string) {
  const q: Record<string, unknown> = {};
  q.eq = () => q;
  q.in = () => (table === 'tables' ? settle(tablesAnswer) : settle(tournamentsAnswer));
  q.gt = () => {
    if (columns === 'id') return Promise.resolve(countAnswer);
    return { limit: () => settle(rowsAnswer) };
  };
  return q;
}

vi.mock('./supabase.js', () => ({
  supabase: { from: (table: string) => ({ select: (columns: string) => chain(table, columns) }) },
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
  tablesAnswer = { data: [], error: null };
  tournamentsAnswer = { data: [], error: null };
});

/** Kill rows spread across the window: a loop, not a burst. */
const spread = (i: number) =>
  new Date(Date.UTC(2026, 9, 17, 12, 45 + Math.floor(i / 6), i % 60)).toISOString();

describe('the kill-storm page names its cause', () => {
  it('says how many tables and which phase, most frequent first', async () => {
    countAnswer = { count: 74, error: null };
    const rows = [
      ...Array.from({ length: 57 }, (_, i) => ({
        detail: 'start_failed:start_crash_recovery',
        table_id: 't' + (i % 40),
        created_at: spread(i),
      })),
      ...Array.from({ length: 17 }, (_, i) => ({
        detail: 'dealing_loop_died+' + (90 + i) + 's',
        table_id: 'u' + (i % 2),
        created_at: spread(57 + i),
      })),
    ];
    rowsAnswer = { data: rows, error: null };
    // Cash tables: no tournament to name.
    tablesAnswer = {
      data: rows.map((r) => ({ id: r.table_id, tournament_id: null })),
      error: null,
    };

    const alert = await storm();

    expect(alert.summary).toBe(
      '74 engine kills in 15min on 42 tables, most at start_failed:start_crash_recovery - spread over 12min, tables are being destroyed and rebuilt in a loop'
    );
    // The elapsed suffix does not split one cause into seventeen.
    expect(alert.description).toContain(
      'start_failed:start_crash_recovery x57, dealing_loop_died x17'
    );
    expect(alert.description).not.toContain('Tournaments hit');
    expect(alert.labels).toEqual({
      kills: '74',
      tables: '42',
      top_cause: 'start_failed:start_crash_recovery',
      shape: 'spread',
    });
  });

  /**
   * THE 13:27:10Z STORM OF 2026-10-25: 41 kills inside 138 ms, all
   * tournament_lease_lost, all 41 tables of one tournament. The page said
   * "41 engine kills in 15min on 41 tables, most at tournament_lease_lost -
   * tables are being destroyed and rebuilt in a loop": no event named, and a
   * loop that was not one.
   */
  it('names the one tournament, says it was one burst, and "all" when every kill had the same cause', async () => {
    countAnswer = { count: 41, error: null };
    const tid = '56b17547-0000-4000-8000-000000000001';
    rowsAnswer = {
      data: Array.from({ length: 41 }, (_, i) => ({
        detail: 'tournament_lease_lost',
        table_id: 'table-' + i,
        created_at: new Date(Date.UTC(2026, 9, 25, 13, 27, 10, 749 + (i * 138) / 40)).toISOString(),
      })),
      error: null,
    };
    tablesAnswer = {
      data: Array.from({ length: 41 }, (_, i) => ({ id: 'table-' + i, tournament_id: tid })),
      error: null,
    };
    tournamentsAnswer = { data: [{ id: tid, name: 'Sunday Deep Stack' }], error: null };

    const alert = await storm();

    expect(alert.summary).toBe(
      '41 engine kills in 15min on 41 tables of tournament "Sunday Deep Stack" (56b17547), all tournament_lease_lost - one burst at 13:27:10Z, not a loop'
    );
    expect(alert.description).toContain('Tournaments hit: Sunday Deep Stack x41.');
    expect(alert.labels).toEqual({
      kills: '41',
      tables: '41',
      top_cause: 'tournament_lease_lost',
      shape: 'burst',
      tournament_id: tid,
    });
  });

  it('names a tournament by id when its name cannot be read, and counts several', async () => {
    countAnswer = { count: 40, error: null };
    rowsAnswer = {
      data: Array.from({ length: 40 }, (_, i) => ({
        detail: 'tournament_lease_lost',
        table_id: 'table-' + i,
        created_at: new Date(Date.UTC(2026, 9, 25, 13, 27, 10)).toISOString(),
      })),
      error: null,
    };
    tablesAnswer = {
      data: Array.from({ length: 40 }, (_, i) => ({
        id: 'table-' + i,
        tournament_id: i < 30 ? 'aaaaaaaa-1' : 'bbbbbbbb-2',
      })),
      error: null,
    };
    tournamentsAnswer = new Error('fetch failed');

    const alert = await storm();

    expect(alert.summary).toBe(
      '40 engine kills in 15min on 40 tables across 2 tournaments, all tournament_lease_lost - one burst at 13:27:10Z, not a loop'
    );
    expect(alert.description).toContain('Tournaments hit: aaaaaaaa x30, bbbbbbbb x10.');
    expect(alert.labels).not.toHaveProperty('tournament_id');
  });

  it('a tournament lookup that fails leaves the page as it was without it', async () => {
    countAnswer = { count: 41, error: null };
    rowsAnswer = {
      data: Array.from({ length: 41 }, (_, i) => ({
        detail: 'tournament_lease_lost',
        table_id: 'table-' + i,
        created_at: new Date(Date.UTC(2026, 9, 25, 13, 27, 10)).toISOString(),
      })),
      error: null,
    };
    tablesAnswer = new Error('fetch failed');

    const alert = await storm();

    expect(alert.summary).toBe(
      '41 engine kills in 15min on 41 tables, all tournament_lease_lost - one burst at 13:27:10Z, not a loop'
    );
    expect(alert.labels).toEqual({
      kills: '41',
      tables: '41',
      top_cause: 'tournament_lease_lost',
      shape: 'burst',
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
