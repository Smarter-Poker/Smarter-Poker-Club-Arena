/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DETECTOR THAT WOULD HAVE NAMED THE MORNING NOBODY COULD MERGE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-07 twelve consecutive `CI - Build & Type Safety` runs failed, each
 * one a different agent on an unrelated branch, for hours. The cause was a
 * single missing index on a brand-new table, which turned
 * `Supabase Invariants - A Club Stays Deletable` red on EVERY branch at once.
 *
 * THE DANGEROUS DIRECTION here is crying wolf. Open branches rot on their own:
 * measured against the live repository the same day, 17 of 20 fresh pull
 * requests had SOME failure and the most-shared real step was on 5 of them -
 * 29%. During the incident the shared step was on 12 of 12: 100%. Most of what
 * is pinned below is what this must NOT report.
 *
 * The numbers in these cases are the measured ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

type Job = {
  name: string;
  conclusion: string | null;
  steps?: Array<{ name: string; conclusion: string | null }>;
};

let isSummaryStep: (key: string) => boolean;
let hoursSinceNewest: (t: Array<string | null | undefined>, now?: number) => number | null;
let isFresh: (pr: unknown, windowHours?: number, now?: number) => boolean;
let newestRunPerWorkflow: (runs: unknown[]) => Array<{ name: string; conclusion: string }>;
let failingStepKeys: (jobs: Job[]) => string[];
let groupFailures: (perPr: Array<{ number: number; keys: string[] }>) => Map<string, number[]>;
let verdict: (a: {
  groups: Map<string, number[]>;
  failingPrs: number;
  minPrs?: number;
  minShare?: number;
}) => { estateWide: boolean; offenders: Array<{ key: string; prs: number[]; share: number }> };
let DEFAULT_MIN_PRS: number;
let DEFAULT_MIN_SHARE: number;
let DEFAULT_WINDOW_HOURS: number;

beforeAll(async () => {
  const href = pathToFileURL(
    resolve(__dirname, '..', 'scripts/ci/check-open-prs-are-green.mjs')
  ).href;
  const mod = await import(/* @vite-ignore */ href);
  isSummaryStep = mod.isSummaryStep;
  hoursSinceNewest = mod.hoursSinceNewest;
  isFresh = mod.isFresh;
  newestRunPerWorkflow = mod.newestRunPerWorkflow;
  failingStepKeys = mod.failingStepKeys;
  groupFailures = mod.groupFailures;
  verdict = mod.verdict;
  DEFAULT_MIN_PRS = mod.DEFAULT_MIN_PRS;
  DEFAULT_MIN_SHARE = mod.DEFAULT_MIN_SHARE;
  DEFAULT_WINDOW_HOURS = mod.DEFAULT_WINDOW_HOURS;
});

const perPr = (n: number, ...keys: string[]) => ({ number: n, keys });

describe('importing the checker does not run it', () => {
  it('exports its parts without exiting the worker', () => {
    // check-ddl-reload-storms.mjs called main() at import on 2026-09-06 and
    // killed the vitest worker with process.exit(2); the suite reported
    // "15 passed" with a stray error beside it. Reaching this line at all is
    // the assertion.
    expect(typeof verdict).toBe('function');
    expect(DEFAULT_MIN_PRS).toBe(4);
    expect(DEFAULT_MIN_SHARE).toBe(0.6);
    expect(DEFAULT_WINDOW_HOURS).toBe(6);
  });
});

describe('summary steps name no cause', () => {
  it('drops the two that restate another job, measured as echoes on 25 and 9 pull requests', () => {
    expect(isSummaryStep('What this run verified / Fail if a suite that ran did not pass')).toBe(
      true
    );
    expect(isSummaryStep('Client Unit Tests (vitest) / Every shard passed')).toBe(true);
  });

  it('keeps every step that names something', () => {
    expect(isSummaryStep('TypeScript Check / Supabase Invariants - A Club Stays Deletable')).toBe(
      false
    );
    expect(isSummaryStep('Server Engine (typecheck + tests) / Full server test suite')).toBe(false);
    expect(isSummaryStep('Client Unit Tests shard 1 / Run Test Suite')).toBe(false);
  });

  it('matches on the step, not the job, and ignores case and padding', () => {
    expect(isSummaryStep('Anything /   EVERY SHARD PASSED  ')).toBe(true);
    // A job that happens to be called this is still judged on its step.
    expect(isSummaryStep('Every shard passed / Run Test Suite')).toBe(false);
  });

  it('never throws on rubbish', () => {
    expect(isSummaryStep(undefined as unknown as string)).toBe(false);
    expect(isSummaryStep('')).toBe(false);
  });
});

describe('freshness', () => {
  const now = Date.parse('2026-09-07T06:00:00Z');

  it('an empty list of timestamps is unknown age, never age zero', () => {
    // The coercion this file exists about: `null` must not be promoted to the
    // freshest thing in the window.
    expect(hoursSinceNewest([], now)).toBeNull();
    expect(hoursSinceNewest([null, undefined], now)).toBeNull();
    expect(hoursSinceNewest(['not a date'], now)).toBeNull();
  });

  it('reads the newest of several', () => {
    const h = hoursSinceNewest(
      ['2026-09-07T00:00:00Z', '2026-09-07T05:00:00Z', '2026-09-06T12:00:00Z'],
      now
    );
    expect(h).toBeCloseTo(1, 5);
  });

  it('a branch nobody has touched in three days is not part of today', () => {
    expect(isFresh({ updated_at: '2026-09-07T05:30:00Z' }, 6, now)).toBe(true);
    expect(isFresh({ updated_at: '2026-09-04T05:30:00Z' }, 6, now)).toBe(false);
  });

  it('a pull request with no timestamp is excluded rather than assumed fresh', () => {
    expect(isFresh({}, 6, now)).toBe(false);
    expect(isFresh(null, 6, now)).toBe(false);
  });
});

describe('newestRunPerWorkflow', () => {
  it('keeps only the newest run of each workflow, so a fixed failure stops counting', () => {
    const runs = [
      { name: 'CI', conclusion: 'failure', created_at: '2026-09-07T04:00:00Z' },
      { name: 'CI', conclusion: 'success', created_at: '2026-09-07T05:00:00Z' },
      { name: 'Publish', conclusion: 'failure', created_at: '2026-09-07T04:30:00Z' },
    ];
    const out = newestRunPerWorkflow(runs).sort((a, b) => a.name.localeCompare(b.name));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: 'CI', conclusion: 'success' });
    expect(out[1]).toMatchObject({ name: 'Publish', conclusion: 'failure' });
  });

  it('survives an empty or malformed list', () => {
    expect(newestRunPerWorkflow([])).toEqual([]);
    expect(newestRunPerWorkflow([null, { conclusion: 'failure' }] as unknown[])).toEqual([]);
  });
});

describe('failingStepKeys', () => {
  const jobs: Job[] = [
    {
      name: 'TypeScript Check',
      conclusion: 'failure',
      steps: [
        { name: 'Checkout', conclusion: 'success' },
        { name: 'Supabase Invariants - A Club Stays Deletable', conclusion: 'failure' },
      ],
    },
    { name: 'Client Unit Tests shard 2', conclusion: 'cancelled', steps: [] },
    { name: 'Production Build', conclusion: 'success', steps: [] },
  ];

  it('names the step, not just the job', () => {
    expect(failingStepKeys(jobs)).toEqual([
      'TypeScript Check / Supabase Invariants - A Club Stays Deletable',
    ]);
  });

  it('a failing job that names no failing step still counts, under its own name', () => {
    expect(failingStepKeys([{ name: 'Deploy', conclusion: 'failure', steps: [] }])).toEqual([
      'Deploy / (job)',
    ]);
  });

  it('cancelled is not failed - a cancelled shard is a newer push, not a defect', () => {
    expect(failingStepKeys([{ name: 'shard 2', conclusion: 'cancelled' }])).toEqual([]);
  });
});

describe('the incident: one check red on every branch', () => {
  const CLUB = 'TypeScript Check / Supabase Invariants - A Club Stays Deletable';
  const SUMMARY = 'What this run verified / Fail if a suite that ran did not pass';

  it('reports the estate-wide blocker and never the summary step beside it', () => {
    // The measured shape at 05:27 UTC: twelve branches, every one of them red
    // on the same named invariant, each also carrying the summary step.
    const prs = [3421, 3417, 3413, 3415, 3423, 3404, 2957, 2872, 2870, 2867, 2461, 2426].map((n) =>
      perPr(n, CLUB, SUMMARY)
    );
    const groups = groupFailures(prs);
    expect(groups.has(SUMMARY)).toBe(false);
    expect(groups.get(CLUB)).toHaveLength(12);

    const { estateWide, offenders } = verdict({ groups, failingPrs: 12 });
    expect(estateWide).toBe(true);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].key).toBe(CLUB);
    expect(offenders[0].share).toBe(1);
  });

  it('an ordinary morning of independent rot is NOT reported', () => {
    // Measured 2026-09-07 after the index landed: 17 fresh pull requests with a
    // failure, the most-shared real step on 5 of them (29%).
    const groups = groupFailures([
      ...[2870, 2867, 2666, 2426, 2303].map((n) => perPr(n, 'TypeScript Check / Invariant guards')),
      ...[3160, 3156, 3151, 3141].map((n) => perPr(n, 'Server Engine / Full server test suite')),
      ...[3431, 3404, 3144].map((n) => perPr(n, 'CSS Beat E2E / Run the beats')),
      ...[3163, 3061, 3040, 2957, 3276].map((n) => perPr(n, 'Client Unit Tests / Run Test Suite')),
    ]);
    const { estateWide, offenders } = verdict({ groups, failingPrs: 17 });
    expect(estateWide).toBe(false);
    expect(offenders).toEqual([]);
  });

  it('four of four is estate-wide; the same four out of seventeen is a Tuesday', () => {
    const groups = groupFailures([3413, 3415, 3421, 3422].map((n) => perPr(n, CLUB)));
    expect(verdict({ groups, failingPrs: 4 }).estateWide).toBe(true);
    expect(verdict({ groups, failingPrs: 17 }).estateWide).toBe(false);
  });

  it('the count is a floor, so a two-branch repository cannot trip it at 100%', () => {
    const groups = groupFailures([3413, 3415].map((n) => perPr(n, CLUB)));
    expect(verdict({ groups, failingPrs: 2 }).estateWide).toBe(false);
  });

  it('nothing failing is not estate-wide', () => {
    expect(verdict({ groups: new Map(), failingPrs: 0 }).estateWide).toBe(false);
  });

  it('a pull request counts once for a step however many jobs repeat it', () => {
    const groups = groupFailures([
      { number: 3413, keys: [CLUB, CLUB, CLUB] },
      ...[3415, 3421, 3422].map((n) => perPr(n, CLUB)),
    ]);
    expect(groups.get(CLUB)).toEqual([3413, 3415, 3421, 3422]);
  });

  it('two estate-wide blockers are both named, worst first', () => {
    const OTHER = 'Production Build / Entry Chunk Is A Reviewed List';
    const groups = groupFailures([
      ...[1, 2, 3, 4, 5].map((n) => perPr(n, CLUB)),
      ...[1, 2, 3, 4].map((n) => perPr(n, OTHER)),
    ]);
    const { offenders } = verdict({ groups, failingPrs: 5 });
    expect(offenders.map((o) => o.key)).toEqual([CLUB, OTHER]);
  });
});
