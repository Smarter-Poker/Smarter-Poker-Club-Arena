/**
 * LAW: the break does not silence the alarms about itself, and no guarded
 *      alarm waits longer than the gap between two breaks.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md section 13 rule 6: a fleet-level alert carries
 * `unless max_over_time(poker_maintenance_break_active[6m]) == 1`, or it
 * pages hourly about a stop we scheduled. That guard mutes from the :53
 * announcement to six minutes after the :00 thaw, and every muted evaluation
 * RESETS a pending alert's `for`.
 *
 * MEASURED from engine_maintenance_thaws (announcement -> thaw, plus the 6m
 * tail), 24 hours to 2026-09-26 04:10 UTC: 48 breaks, the flag on for 23.9%
 * of the day and the guard muting 39.5% of it; 30 muted segments, median
 * unmuted gap 29.8 minutes, longest 46.9. In an ORDINARY hour the unmuted
 * stretch is :06 -> :53, 47 minutes, and that is the ceiling.
 *
 * So three kinds of alarm were blind:
 *  - alarms ABOUT the break (EngineCannotBeReplaced,
 *    EngineReplacementWatchdogBlind) were muted by the very break they
 *    measure;
 *  - `for: 1h` (TournamentRunningWithNoOwnerCritical) and `for: 2h`
 *    (EngineSheddingPrecisionForHours) behind the guard could NEVER fire,
 *    on any day;
 *  - nothing said the break flag itself was on a third of the time.
 *
 * WHAT THIS PINS
 * 1. No release-route alarm carries the guard.
 * 2. Every guarded alarm's `for` is at most 40 minutes, inside the 47-minute
 *    ordinary gap. A longer persistence is measured INSIDE the expression over
 *    the unmuted minutes (the two rewritten rules), with `for` short.
 * 3. PlatformFrozenTooOften reads the flag's 3-hour share, unguarded, with the
 *    measured threshold.
 * 4. The promtool cases that prove the timing run in CI.
 * 5. NEGATIVE PROOF: the checker flags each shape it forbids.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'infra/monitoring');
const GUARD = /max_over_time\(poker_maintenance_break_active\[6m\]\)\s*==\s*1/;
const RELEASE_ROUTE = [
  'EngineCannotBeReplaced',
  'EngineReplacementWatchdogBlind',
  'PokerEngineCannotBeReplaced',
  'EngineReleaseGateNeverOpens',
  'PlatformFrozenTooOften',
];
/** :53 announcement -> :00 thaw -> +6m guard tail leaves :06 -> :53. */
const ORDINARY_UNMUTED_GAP_MINUTES = 47;
const MAX_GUARDED_FOR_MINUTES = 40;

type Rule = { alert?: string; expr?: string; for?: string; labels?: Record<string, string> };

function rulesIn(text: string): Rule[] {
  const doc = YAML.parse(text) as { groups?: { rules?: Rule[] }[] };
  return (doc.groups ?? []).flatMap((g) => g.rules ?? []).filter((r) => r.alert);
}

const RULES: Rule[] = readdirSync(DIR)
  .filter((f) => /rules.*\.yml$|alerts\.yml$/.test(f) && !f.includes('QUARANTINED'))
  .flatMap((f) => rulesIn(readFileSync(join(DIR, f), 'utf8')));

function minutes(duration: string | undefined): number {
  if (!duration) return 0;
  let total = 0;
  for (const [, n, unit] of duration.matchAll(/(\d+)([smhd])/g)) {
    total +=
      Number(n) * ({ s: 1 / 60, m: 1, h: 60, d: 1440 } as const)[unit as 's' | 'm' | 'h' | 'd'];
  }
  return total;
}

/** Every way a rule set breaks this law. */
function findings(rules: Rule[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const guarded = GUARD.test(r.expr ?? '');
    if (guarded && RELEASE_ROUTE.includes(r.alert!))
      out.push(`${r.alert}: release-route alarm muted by the break`);
    if (guarded && minutes(r.for) > MAX_GUARDED_FOR_MINUTES)
      out.push(`${r.alert}: guarded with for ${r.for}, longer than any gap between breaks`);
  }
  return out;
}

const byName = (name: string) => {
  const r = RULES.find((x) => x.alert === name);
  expect(r, name).toBeTruthy();
  return r!;
};

describe('1-2. the live rule set obeys the law', () => {
  it('loaded a real rule set', () => {
    expect(RULES.length).toBeGreaterThan(100);
    for (const name of RELEASE_ROUTE) byName(name);
  });

  it('the ceiling leaves headroom inside the ordinary gap', () => {
    expect(MAX_GUARDED_FOR_MINUTES).toBeLessThan(ORDINARY_UNMUTED_GAP_MINUTES);
  });

  it('has no finding', () => {
    expect(findings(RULES)).toEqual([]);
  });

  it('the two long durations are measured inside the expression, over unmuted minutes', () => {
    for (const [name, window, floor] of [
      ['TournamentRunningWithNoOwnerCritical', '1h', 30],
      ['EngineSheddingPrecisionForHours', '2h', 60],
    ] as const) {
      const r = byName(name);
      expect(minutes(r.for)).toBeLessThanOrEqual(5);
      expect(r.expr).toMatch(GUARD);
      expect(r.expr).toContain(`[${window}:1m])`);
      expect(r.expr).toContain(
        `sum_over_time((max(max_over_time(poker_maintenance_break_active[6m])) == bool 0)[${window}:1m]) >= ${floor}`
      );
      expect(r.expr).toContain('>= on() group_left()');
    }
  });
});

describe('3. the break flag has a reader of its own', () => {
  it('PlatformFrozenTooOften reads the three-hour share, unguarded, at the measured threshold', () => {
    const r = byName('PlatformFrozenTooOften');
    expect(r.expr!.trim()).toBe('max(avg_over_time(poker_maintenance_break_active[3h])) > 0.30');
    expect(r.labels?.severity).toBe('critical');
    expect(GUARD.test(r.expr!)).toBe(false);
  });
});

describe('4. promtool proves the timing in CI', () => {
  it('the test file is run by the CI script', () => {
    const script = readFileSync(join(ROOT, 'scripts/ci/test-fleet-throughput.sh'), 'utf8');
    expect(script).toContain('break-does-not-silence-its-own-alarms.test.yml');
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('bash scripts/ci/test-fleet-throughput.sh');
  });

  it('covers every rewritten or unguarded alarm', () => {
    const cases = readFileSync(
      join(ROOT, 'tests/monitoring/break-does-not-silence-its-own-alarms.test.yml'),
      'utf8'
    );
    for (const name of [
      'TournamentRunningWithNoOwnerCritical',
      'EngineSheddingPrecisionForHours',
      'EngineCannotBeReplaced',
      'PlatformFrozenTooOften',
    ])
      expect(cases).toContain(name);
  });
});

describe('5. negative proof: the checker sees what it forbids', () => {
  const guard = 'x > 0\nunless on() max_over_time(poker_maintenance_break_active[6m]) == 1\n';
  it('flags a release-route alarm behind the guard', () => {
    expect(findings([{ alert: 'EngineCannotBeReplaced', expr: guard, for: '10m' }])).toHaveLength(
      1
    );
  });
  it('flags the old for: 1h and for: 2h shapes', () => {
    expect(findings([{ alert: 'A', expr: guard, for: '1h' }])).toHaveLength(1);
    expect(findings([{ alert: 'B', expr: guard, for: '2h' }])).toHaveLength(1);
    expect(findings([{ alert: 'C', expr: guard, for: '45m' }])).toHaveLength(1);
  });
  it('passes an unguarded long alarm and a guarded short one', () => {
    expect(findings([{ alert: 'D', expr: 'x > 0', for: '2h' }])).toEqual([]);
    expect(findings([{ alert: 'E', expr: guard, for: '40m' }])).toEqual([]);
  });
});
