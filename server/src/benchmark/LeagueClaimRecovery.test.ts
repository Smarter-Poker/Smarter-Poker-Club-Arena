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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── A minimal supabase double: enough surface for claimNightlyJob's three
// calls (insert / select / update) and nothing more. ──────────────────────
type Row = { job: string; run_date: string; claimed_at: string; claimed_by: string };

const state: {
  jobRuns: Row[];
  leagueRows: Array<{ run_date: string; matchup: string; created_at: string }>;
  // 2026-08-30: the evidence tables for the two jobs that used to be
  // unjudgeable. Same shape as leagueRows - a date column and a payload
  // column - because that is all claimProducedRows ever asks for.
  auditRows: Array<{ day: string }>;
  selfTuneRows: Array<{ run_date: string; id: number }>;
  completedTuneRows: Array<{ run_date: string }>;
  updateAttempts: number;
} = {
  jobRuns: [],
  leagueRows: [],
  auditRows: [],
  selfTuneRows: [],
  completedTuneRows: [],
  updateAttempts: 0,
};

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
        if (table === 'horse_tuner_study_completions') return state.completedTuneRows;
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

const { claimNightlyJob, __setProcessBootMsForTest } = await import('./HorseLeague.js');

const HOUR = 60 * 60 * 1000;
const DAY = '2026-08-28';

beforeEach(() => {
  state.jobRuns = [];
  state.leagueRows = [];
  state.auditRows = [];
  state.selfTuneRows = [];
  state.completedTuneRows = [];
  state.updateAttempts = 0;
  process.env.HOSTNAME = 'container-A';
  // The clock-based cases below were written for a process that has been up
  // all day. Pin the boot a day back so the 2026-09-06 boot rule (its own
  // describe at the bottom) cannot change what they measure - a vitest
  // worker's real uptime is whatever the run happens to be, not a fixture.
  __setProcessBootMsForTest(Date.now() - 24 * HOUR);
});
afterEach(() => {
  __setProcessBootMsForTest(null);
  vi.restoreAllMocks();
});

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

  /*
   * ── 2026-09-04: for LEAGUE, a row is partial progress, not delivery ──
   * This test used to push one league row and assert the claim was left
   * alone. That was right while a run got its whole 90-minute budget, and
   * became wrong on 2026-09-01 when the engine started restarting at :55 of
   * every hour: the 04:04 run is now always killed mid-card, and the single
   * matchup it managed made the claim permanently untakeable. 2026-09-02 and
   * 2026-09-03 both recorded exactly one matchup and a `nightly_job_lost`
   * finding. The question for a partial-output job is not "did anything
   * land" but "is this claim STILL producing", so the row's age decides.
   */
  it('an OLD league claim whose newest row is FRESH is left alone', async () => {
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    // A live run wrote a matchup four minutes ago - it is working, not dead.
    state.leagueRows.push({
      run_date: DAY,
      matchup: 'v20_multiway',
      created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    });
    expect(await claimNightlyJob('league', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('an OLD league claim whose newest row is STALE is taken over mid-card', async () => {
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    // One matchup, written 50 minutes ago, then the hourly restart killed it.
    state.leagueRows.push({
      run_date: DAY,
      matchup: 'v20_multiway',
      created_at: new Date(Date.now() - 50 * 60_000).toISOString(),
    });
    expect(await claimNightlyJob('league', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).not.toBe('container-B');
  });

  it('a league claim with NO rows at all is still a plain corpse', async () => {
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(true);
  });

  it('daily_audit is NOT partial - one row is the whole night, freshness is irrelevant', () => {
    // The partial-evidence rule must not leak onto the jobs whose single row
    // IS the output, or a slow-but-alive audit would be run twice.
    const src = readFileSync(join(__dirname, 'HorseLeague.ts'), 'utf8');
    const block = src.slice(
      src.indexOf('CLAIM_EVIDENCE_IS_PARTIAL: Record'),
      src.indexOf('/** Rows already written for this job+date')
    );
    expect(block).toContain('league');
    expect(block).toContain('league_pm');
    expect(block).not.toContain('daily_audit');
    expect(block).not.toContain('self_tuner');
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

  it('a partial self_tuner claim can be resumed even after one audit row', async () => {
    state.jobRuns.push({
      job: 'self_tuner',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    state.selfTuneRows.push({ run_date: DAY, id: 1 });
    expect(await claimNightlyJob('self_tuner', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('a fully completed self_tuner claim is left alone', async () => {
    state.jobRuns.push({
      job: 'self_tuner',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * HOUR).toISOString(),
      claimed_by: 'container-B',
    });
    state.completedTuneRows.push({ run_date: DAY });
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

/**
 * ── 2026-09-01: THE STAND-DOWN LATCH, and why the recovery above never ran ──
 *
 * Everything above this line was already shipped and correct, and the league
 * STILL lost three days in four. MEASURED:
 *
 *   horse_league_results   2026-08-29  0 rows   (claim present)
 *   horse_league_results   2026-08-30  0 rows   (claim present)
 *   horse_league_results   2026-08-31  33 rows
 *   horse_league_results   2026-09-01  0 rows   (claim present)
 *
 *   [HorseLeague] run 2026-09-01 starting: 33 matchups x 4000 pairs
 *   docker inspect club-arena-engine -> StartedAt 2026-09-01T04:10:42Z
 *
 * The run began at 04:04 and the container was replaced at 04:10 - six
 * minutes in, before the first matchup could write its row. The replacement
 * booted at ~04:12, found no rows, and asked to claim. The dead claim was
 * EIGHT MINUTES OLD, so it was judged fresh and the request was refused -
 * correctly, on the information available. The bug is what happened next: the
 * refused instance set `lastLeagueDate = today` and every subsequent tick
 * returned immediately, so it never asked again, including after 05:04 when
 * the claim was stale and the takeover above would finally have fired.
 *
 * Two properties fix it, and both are pinned here:
 *   1. standing down must NOT latch the day (source-level: the assignment is
 *      gone from both stand-down branches);
 *   2. the staleness threshold must be short enough to act inside the
 *      three-hour window, and still comfortably longer than one matchup.
 */
describe('the stand-down latch - 2026-09-01', () => {
  it('a claim 35 minutes dead with no rows is taken over', async () => {
    // Under the old 60-minute threshold this returned false and the AM window
    // (04:00-07:00) closed with the corpse still holding the lock.
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 35 * 60_000).toISOString(),
      claimed_by: 'dead-container',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('a claim 20 minutes old with no rows is still left alone', async () => {
    // A matchup takes roughly nine minutes at PAIRS_PER_MATCHUP=4000, so at
    // twenty minutes a healthy run may legitimately still be on its second.
    // The threshold must not be so tight that it steals live work.
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      claimed_by: 'container-B',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('neither stand-down branch latches the day', () => {
    // Source-level, because maybeRunLeague is module-private and driving it
    // would mean faking the clock, the window and two module flags. The
    // property is simple and worth pinning literally: the stand-down branch
    // must not assign the per-process "settled today" flag, or the retry that
    // the takeover depends on never happens.
    const src = readFileSync(join(__dirname, 'HorseLeague.ts'), 'utf8');
    for (const [job, flag] of [
      ["claimNightlyJob('league', today)", 'lastLeagueDate'],
      ["claimNightlyJob('league_pm', today)", 'lastLeaguePmDate'],
    ] as const) {
      const claimAt = src.indexOf(`const claimed = await ${job}`);
      expect(claimAt, `claim for ${job} not found`).toBeGreaterThan(-1);
      const at = src.indexOf('if (!claimed)', claimAt);
      expect(at, `stand-down branch for ${job} not found`).toBeGreaterThan(claimAt);
      // Comments stripped first: this asserts on CODE. The branch carries a
      // long note that necessarily quotes the assignment it is warning about,
      // and prose must not be able to fail - or pass - a wiring test.
      const branch = src
        .slice(at, src.indexOf('\n    }', at))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(branch, `${job} must not latch ${flag} when standing down`).not.toContain(
        `${flag} = today`
      );
    }
  });

  it('the staleness threshold acts well inside the catch-up window', () => {
    const src = readFileSync(join(__dirname, 'HorseLeague.ts'), 'utf8');
    const stale = /const CLAIM_STALE_MS = (\d+) \* 60 \* 1000;/.exec(src);
    const catchup = /const LEAGUE_CATCHUP_HOURS = (\d+);/.exec(src);
    expect(stale, 'CLAIM_STALE_MS must stay a literal minutes value').not.toBeNull();
    expect(catchup).not.toBeNull();
    const staleMin = Number(stale![1]);
    const windowMin = Number(catchup![1]) * 60;
    // Room for at least two takeover attempts before the window closes.
    expect(staleMin * 2).toBeLessThan(windowMin);
    // And longer than one matchup, so a live run is never mistaken for a corpse.
    expect(staleMin).toBeGreaterThan(15);
  });
});

/**
 * ── 2026-09-06: a claim from before this process booted is a corpse ──
 *
 * MEASURED by the 2026-09-05 daily analysis, from horse_job_runs and
 * horse_league_results:
 *
 *   2026-09-05  league     last takeover 06:56:50   ZERO matchups written
 *   2026-09-05  league_pm  last takeover 18:56:38   ZERO matchups written
 *   2026-09-06  league     matchup 1 at 04:51, matchup 2 at 06:48 - 117 min
 *               apart for work that takes 9-16 min.
 *
 * The engine restarts at :55 every hour. The replacement arrives at the
 * claim ~05:00 and the thirty-minute clock refuses it twice over: first the
 * claim is "fresh", then the dead process's last row is "fresh". Half of
 * every hour was spent standing down in front of a corpse. The calendar
 * answers what the clock cannot: nothing survives the container being
 * recreated, so a claim (or a row) stamped before THIS process booted was
 * made by a process that is gone.
 */
describe('claimNightlyJob - a claim from before this boot is a corpse (2026-09-06)', () => {
  const MIN = 60_000;

  it('a claim 8 minutes old that predates this boot is taken over at once', async () => {
    // Booted 3 minutes ago (the :55 restart, the 90-second boot delay). The
    // claim is only eight minutes old - well inside CLAIM_STALE_MS - but it
    // was stamped five minutes before this process existed.
    __setProcessBootMsForTest(Date.now() - 3 * MIN);
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 8 * MIN).toISOString(),
      claimed_by: 'dead-container',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('a row written before this boot is history, not a heartbeat - the card resumes', async () => {
    __setProcessBootMsForTest(Date.now() - 3 * MIN);
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 50 * MIN).toISOString(),
      claimed_by: 'dead-container',
    });
    // The dead process wrote its last matchup six minutes ago, three minutes
    // before the restart. Under the clock alone this row is "fresh" and the
    // takeover would wait another 24 minutes.
    state.leagueRows.push({
      run_date: DAY,
      matchup: 'plo6_v46_classes',
      created_at: new Date(Date.now() - 6 * MIN).toISOString(),
    });
    expect(await claimNightlyJob('league', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });

  it('a claim made AFTER this boot is judged by the clock exactly as before', async () => {
    // A live sibling (or this very process on an earlier tick) claimed five
    // minutes ago; we booted twenty minutes ago. Nothing about the boot says
    // that claim is dead, so the fresh-claim rule still protects it.
    __setProcessBootMsForTest(Date.now() - 20 * MIN);
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * MIN).toISOString(),
      claimed_by: 'container-B',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('a sibling that claimed inside the two-minute grace before our boot is left alone', async () => {
    // Leader/standby pairs boot together; a stagger of a minute is normal.
    // The sibling claimed 60 seconds before we booted: inside the grace, so
    // it is treated as alive and the clock rule applies (5 min old = fresh).
    __setProcessBootMsForTest(Date.now() - 4 * MIN);
    state.jobRuns.push({
      job: 'league',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 5 * MIN).toISOString(),
      claimed_by: 'container-B',
    });
    expect(await claimNightlyJob('league', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('a whole-output job (daily_audit) that delivered before our boot is still respected', async () => {
    // For daily_audit one row IS the night. A row from before the boot is
    // proof of delivery, not a stale heartbeat - the partial rule must not
    // leak onto it.
    __setProcessBootMsForTest(Date.now() - 3 * MIN);
    state.jobRuns.push({
      job: 'daily_audit',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 40 * MIN).toISOString(),
      claimed_by: 'container-B',
    });
    state.auditRows.push({ day: DAY });
    expect(await claimNightlyJob('daily_audit', DAY)).toBe(false);
    expect(state.jobRuns[0].claimed_by).toBe('container-B');
  });

  it('a whole-output job whose claim predates the boot and wrote nothing is taken over at once', async () => {
    __setProcessBootMsForTest(Date.now() - 3 * MIN);
    state.jobRuns.push({
      job: 'self_tuner',
      run_date: DAY,
      claimed_at: new Date(Date.now() - 6 * MIN).toISOString(),
      claimed_by: 'dead-container',
    });
    expect(await claimNightlyJob('self_tuner', DAY)).toBe(true);
    expect(state.jobRuns[0].claimed_by).toBe('container-A');
  });
});
