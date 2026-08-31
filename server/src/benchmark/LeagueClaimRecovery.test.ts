/**
 * A DEAD CLAIM MUST NOT BURN THE DAY (2026-08-28).
 *
 * MEASURED on production the day the PM window shipped:
 *
 *   horse_job_runs   league     2026-08-28  claimed 04:04  by 0a20c1f05db9
 *   engine container recreated               04:06
 *   horse_league_results for 2026-08-28: 11 rows, ALL written 16:10+ by the
 *   PM window under a different container.
 *
 * The AM run claimed the day, died two minutes later to a routine redeploy,
 * and nothing retried - because the claim is the lock. The day's AM
 * measurement was simply lost, and only the brand-new 16:00 window covered.
 *
 * claimNightlyJob now treats a claim as owning the day only while it is fresh
 * OR has rows to show for itself. These tests drive the real function against
 * a fake supabase so the recovery path is exercised, not merely described.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── A minimal supabase double: enough surface for claimNightlyJob's three
// calls (insert / select / update) and nothing more. ──────────────────────
type Row = { job: string; run_date: string; claimed_at: string; claimed_by: string };

const state: {
  jobRuns: Row[];
  leagueRows: Array<{ run_date: string; matchup: string }>;
  // 2026-08-30: the evidence tables for the two jobs that used to be
  // unjudgeable. Same shape as leagueRows - a date column and a payload
  // column - because that is all claimProducedRows ever asks for.
  auditRows: Array<{ day: string }>;
  selfTuneRows: Array<{ run_date: string; id: number }>;
  updateAttempts: number;
} = { jobRuns: [], leagueRows: [], auditRows: [], selfTuneRows: [], updateAttempts: 0 };

vi.mock('../services/supabase.js', () => {
  const api = {
    from(table: string) {
      if (table === 'horse_job_runs') {
        return {
          insert(row: Partial<Row>) {
            const dup = state.jobRuns.find((r) => r.job === row.job && r.run_date === row.run_date);
            if (dup) return Promise.resolve({ error: { code: '23505', message: 'dup' } });
            state.jobRuns.push({
              job: row.job!,
              run_date: row.run_date!,
              claimed_at: new Date().toISOString(),
              claimed_by: row.claimed_by!,
            });
            return Promise.resolve({ error: null });
          },
          select() {
            const q: Record<string, unknown> = {};
            const filters: Array<[string, string]> = [];
            const self: Record<string, unknown> = {
              eq(col: string, val: string) {
                filters.push([col, val]);
                return self;
              },
              maybeSingle() {
                const hit = state.jobRuns.find((r) =>
                  filters.every(([c, v]) => (r as unknown as Record<string, string>)[c] === v)
                );
                return Promise.resolve({ data: hit ?? null, error: null });
              },
            };
            void q;
            return self;
          },
          update(patch: Partial<Row>) {
            state.updateAttempts++;
            const filters: Array<[string, string]> = [];
            const self: Record<string, unknown> = {
              eq(col: string, val: string) {
                filters.push([col, val]);
                return self;
              },
              select() {
                const hit = state.jobRuns.find((r) =>
                  filters.every(([c, v]) => (r as unknown as Record<string, string>)[c] === v)
                );
                if (!hit) return Promise.resolve({ data: [], error: null });
                Object.assign(hit, patch);
                return Promise.resolve({ data: [{ job: hit.job }], error: null });
              },
            };
            return self;
          },
        };
      }
      // Every evidence table claimProducedRows can consult.
      const rowsFor = (): Array<Record<string, unknown>> => {
        if (table === 'horse_daily_audit') return state.auditRows as Array<Record<string, unknown>>;
        if (table === 'horse_self_tune_log')
          return state.selfTuneRows as Array<Record<string, unknown>>;
        return state.leagueRows as Array<Record<string, unknown>>;
      };
      return {
        select() {
          const filters: Array<[string, string]> = [];
          const self: Record<string, unknown> = {
            eq(col: string, val: string) {
              filters.push([col, val]);
              return self;
            },
            limit() {
              const rows = rowsFor().filter((r) =>
                filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v)
              );
              return Promise.resolve({ data: rows.slice(0, 1), error: null });
            },
            order() {
              return self;
            },
          };
          return self;
        },
      };
    },
  };
  return { supabase: api };
});

vi.mock('../services/errorReporter.js', () => ({ reportError: () => {} }));

const { claimNightlyJob } = await import('./HorseLeague.js');

const HOUR = 60 * 60 * 1000;
const DAY = '2026-08-28';

beforeEach(() => {
  state.jobRuns = [];
  state.leagueRows = [];
  state.auditRows = [];
  state.selfTuneRows = [];
  state.updateAttempts = 0;
  process.env.HOSTNAME = 'container-A';
});
afterEach(() => vi.restoreAllMocks());

describe('claimNightlyJob - first claim', () => {
  it('an unclaimed day is claimed', async () => {
    expect(await claimNightlyJob('league', DAY)).toBe(true);
    expect(state.jobRuns).toHaveLength(1);
  });

  it('a FRESH claim by someone else is respected', async () => {
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      claimed_by: 'container-B',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });
});

describe('claimNightlyJob - the 2026-08-28 crash', () => {
  it('an OLD claim that produced NOTHING is taken over', async () => {
    // Exactly the production shape: claimed at 04:04, no result rows.
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: '0a20c1f05db9',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('an OLD claim that DID produce rows is left alone', async () => {
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    state.leagueRows.push({ run_date: DAY, matchup: 'v20_multiway' });
    expect(await claimNightlyJob('league', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('an unknown job with no evidence table keeps the all-or-nothing claim', async () => {
    // A job nobody has mapped writes nowhere this function knows about, so it
    // genuinely cannot be judged and must not be stolen on those grounds.
    state.jobRuns.push({
      job: 'some_future_job',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    expect(await claimNightlyJob('some_future_job', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });
});

/**
 * ── 2026-08-30: the same crash, on the jobs the map forgot ──
 *
 * REPLACES the old 'a non-league job keeps the all-or-nothing claim' case,
 * which pinned self_tuner as unjudgeable. That was not a safety property, it
 * was the bug: claimProducedRows listed only the two league jobs, so
 * 'daily_audit' and 'self_tuner' returned null, the takeover declined, and an
 * orphaned claim burned the day permanently.
 *
 * MEASURED on production:
 *   horse_job_runs  daily_audit  2026-08-29  claimed 06:09  by c5220cddafaf
 *   horse_daily_audit for 2026-08-29: NO ROW, ~28 hours later.
 *   horse_job_runs  self_tuner   2026-08-26  claimed 08:03  by 6f03494b94b4
 *   horse_self_tune_log for 2026-08-26: NO ROWS, ever.
 */
describe('claimNightlyJob - daily_audit and self_tuner recovery', () => {
  it('a dead daily_audit claim that wrote no audit row is taken over', async () => {
    state.jobRuns.push({
      job: 'daily_audit',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: 'c5220cddafaf',
    });
    expect(await claimNightlyJob('daily_audit', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('a daily_audit claim that DID write its row is left alone', async () => {
    state.jobRuns.push({
      job: 'daily_audit',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    state.auditRows.push({ day: DAY });
    expect(await claimNightlyJob('daily_audit', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('a dead self_tuner claim that wrote no tune rows is taken over', async () => {
    state.jobRuns.push({
      job: 'self_tuner',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * HOUR).toISOString(),
      claimed_by: '6f03494b94b4',
    });
    expect(await claimNightlyJob('self_tuner', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('a self_tuner claim that DID write tune rows is left alone', async () => {
    state.jobRuns.push({
      job: 'self_tuner',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    state.selfTuneRows.push({ run_date: DAY, id: 1 });
    expect(await claimNightlyJob('self_tuner', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('a FRESH daily_audit claim is respected even with no rows yet', async () => {
    // The run takes minutes; not having written yet is normal, not death.
    state.jobRuns.push({
      job: 'daily_audit',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      claimed_by: 'container-B',
    });
    expect(await claimNightlyJob('daily_audit', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });
});

describe('claimNightlyJob - concurrency and window independence', () => {
  it('two rescuers race and exactly ONE wins', async () => {
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: 'dead-container',
    });
    // Both read the same corpse, then both try the conditional update. The
    // second matches nothing because claimed_by has already moved.
    const first = await claimNightlyJob('league', DAY);
    process.env.HOSTNAME = 'container-C';
    const second = await claimNightlyJob('league', DAY);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('the PM window can rescue the AM slot independently (separate job keys)', async () => {
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 12 * HOUR).toISOString(),
      claimed_by: 'dead-am',
    });
    // The PM job key is untouched by the AM corpse.
    expect(await claimNightlyJob('league_pm', DAY)).toBe(true);
    expect(state.jobRuns.find((r) => r.job === 'league_pm')?.claimed_by).toBe('container-A');
  });
});
