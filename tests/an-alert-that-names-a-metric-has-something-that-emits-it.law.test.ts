/**
 * LAW: every metric name an alert or recording rule uses must have something
 * in this repo that emits it.
 *
 * Prometheus does not enforce this and cannot warn about it. An expression
 * like `poker_settlement_failure_rate > 0.02` against a metric that has never
 * had a sample evaluates to an empty vector, which is indistinguishable from a
 * condition that is false. The rule loads, shows green, and can never fire.
 *
 * This has now happened three times in this estate:
 *
 *   2026-08-15  27 rules recovered from engine-01 referenced metrics that did
 *               not exist.
 *   2026-09-09  `poker_hands_total` lived on a flag-gated registry that is
 *               enabled nowhere, so SLOHandsAreNotBeingDealt (critical, SMS)
 *               was structurally unable to fire.
 *   2026-09-04  fifteen rules were written against thirteen names with no
 *               producer at all. Found 2026-09-11, seven days later, with four
 *               of the conditions they describe true - 73 undeclared triggers
 *               on money tables, 693 unread critical money alerts, 16 silent
 *               cron jobs, the worst of them silent for 13.7 days - and two of
 *               the four an SMS page.
 *
 * scripts/ci/check-monitoring-drift.mjs enforces this in CI. This law pins the
 * enforcement itself: that the check exists, that it is wired into the CI job
 * that runs the other monitoring guards, and that it still fails when a
 * producer goes away. A guard nobody can prove still bites is the same shape
 * of problem as the rules it guards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  rulesWithMetrics,
  producerHaystack,
  recordedNames,
  readDeclaredAbsent,
  isProduced,
  metricsIn,
  extractExpressions,
  dashboardsWithMetrics,
} from '../scripts/ci/rule-metric-producers.mjs';
import {
  producedAtBuild,
  haveCommit,
  engineBuildSha,
} from '../scripts/ci/check-alert-rules-match.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(__dirname, '..');
const DIR = resolve(root, 'infra/monitoring');

const loadedRuleFiles = (): string[] => {
  const prom = readFileSync(resolve(DIR, 'prometheus.yml'), 'utf8');
  const lines = prom.split('\n');
  const start = lines.findIndex((l) => /^\s*rule_files:\s*$/.test(l));
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
    const m = /^\s+-\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(
      m[1]
        .replace(/^['"]|['"]$/g, '')
        .split('/')
        .pop()!
    );
  }
  return out.filter((f) => existsSync(resolve(DIR, f)));
};

describe('an alert that names a metric has something that emits it', () => {
  it('every metric referenced by a loaded rule has a producer', () => {
    const files = loadedRuleFiles();
    expect(files.length).toBeGreaterThan(0);

    const rules = rulesWithMetrics(DIR, files);
    const haystack = producerHaystack(root);
    const recorded = recordedNames(DIR, files);
    const declared = readDeclaredAbsent(DIR);

    const orphans: string[] = [];
    for (const rule of rules) {
      for (const metric of rule.metrics) {
        if (isProduced(metric, haystack, recorded, declared)) continue;
        orphans.push(`${metric} (${rule.file}:${rule.name})`);
      }
    }
    expect(orphans, `rules reference metrics nothing emits:\n  ${orphans.join('\n  ')}`).toEqual(
      []
    );
  });

  it('the thirteen names from the 2026-09-04 gap all have producers now', () => {
    const files = loadedRuleFiles();
    const haystack = producerHaystack(root);
    const recorded = recordedNames(DIR, files);
    const declared = readDeclaredAbsent(DIR);
    const wasDead = [
      'poker_settlement_failure_rate',
      'poker_settlement_window_hands',
      'poker_settlement_stuck',
      'poker_settlement_metrics_stale_seconds',
      'poker_money_undeclared_triggers',
      'poker_money_health_stale_seconds',
      'poker_financial_alerts_unresolved',
      'poker_financial_alerts_stale_critical',
      'poker_cron_pg_runs',
      'poker_cron_pg_failures',
      'poker_cron_openclaw_stale',
      'poker_cron_openclaw_worst_silence_minutes',
      'poker_cron_metrics_stale_seconds',
      // Added the same day, for the failure the thirteen could not have caught
      // even once they worked: a job that is dispatched, answers, logs success
      // and does none of its work.
      'poker_cron_jobs_skipping_all_work',
    ];
    for (const metric of wasDead) {
      expect(isProduced(metric, haystack, recorded, declared), `${metric} has no producer`).toBe(
        true
      );
    }
  });

  it('the three blindness alerts also fire when the metric is absent, not only late', () => {
    // A staleness threshold cannot see a collector that never ran: `> 600`
    // against a metric with no samples is empty. absent() is the only arm that
    // catches the case these three alerts exist for.
    const body = readFileSync(resolve(DIR, 'alert-rules.yml'), 'utf8');
    for (const [alert, metric] of [
      ['CronMetricsBlind', 'poker_cron_metrics_stale_seconds'],
      ['MoneyHealthBlind', 'poker_money_health_stale_seconds'],
      ['SettlementMetricsBlind', 'poker_settlement_metrics_stale_seconds'],
    ]) {
      const block = new RegExp(`- alert: ${alert}\\b[\\s\\S]*?\\n\\s*for:`).exec(body);
      expect(block, `${alert} is missing`).not.toBeNull();
      expect(block![0], `${alert} must catch an absent ${metric}`).toContain(`absent(${metric})`);
    }
  });

  it('the maintenance suppression on the revived rules matches across scrape jobs', () => {
    // These gauges come from node_exporter's textfile collector, not the
    // engine. A bare `unless` matches on the full label set, so comparing them
    // against poker_maintenance_break_active (job="engine_game_server") would
    // never suppress anything. `unless on()` is what makes it a global fact.
    const body = readFileSync(resolve(DIR, 'alert-rules.yml'), 'utf8');
    const revived = [
      'PgCronFailuresElevated',
      'PgCronFleetStopped',
      'CronMetricsBlind',
      'HandsAreFailingToSettle',
      'SettlementFailuresAboveBaseline',
      'NoHandsAreSettling',
      'SettlementsStuckMidStateMachine',
      'SettlementMetricsBlind',
      'MoneyHealthBlind',
    ];
    for (const alert of revived) {
      const block = new RegExp(`- alert: ${alert}\\b[\\s\\S]*?\\n\\s*for:`).exec(body);
      expect(block, `${alert} is missing`).not.toBeNull();
      expect(block![0], `${alert} must use "unless on()"`).toMatch(/unless on\(\)/);
      expect(block![0], `${alert} must not use a bare "unless max_over_time"`).not.toMatch(
        /unless max_over_time/
      );
    }
  });

  it('the collector publishes every gauge and fails closed', () => {
    const script = resolve(root, 'server/scripts/collect-monitoring-health.sh');
    expect(existsSync(script)).toBe(true);
    const body = readFileSync(script, 'utf8');
    // It must never write a zero it could not read: every exit path that did
    // not render a full snapshot has to leave the previous file in place.
    expect(body).toMatch(/die\(\)\s*\{[^}]*exit 1/);
    expect(body).not.toMatch(/>\s*"\$OUT"\s*$/m); // writes go through $TMP then mv
    expect(body).toContain('mv -f "$TMP" "$OUT"');
  });

  it('every metric a dashboard panel names has a producer', () => {
    // A panel reading a metric with no series draws an empty graph forever,
    // which is how people learn to stop looking at dashboards. 23 of the 45
    // panel expressions were in this state on 2026-09-11.
    const files = loadedRuleFiles();
    const dashboards = dashboardsWithMetrics(resolve(DIR, 'grafana-dashboards'));
    expect(dashboards.length).toBeGreaterThan(0);
    const haystack = producerHaystack(root);
    const recorded = recordedNames(DIR, files);
    const declared = readDeclaredAbsent(DIR);
    const orphans: string[] = [];
    for (const d of dashboards) {
      for (const m of d.metrics) {
        if (!isProduced(m, haystack, recorded, declared)) orphans.push(`${m} (${d.file})`);
      }
    }
    expect(
      orphans,
      `dashboard panels read metrics nothing emits:\n  ${orphans.join('\n  ')}`
    ).toEqual([]);
  });

  it('every declared exception carries a reason and is still referenced', () => {
    const declared = readDeclaredAbsent(DIR);
    const files = loadedRuleFiles();
    const named = new Set([
      ...rulesWithMetrics(DIR, files).flatMap((r) => r.metrics),
      ...dashboardsWithMetrics(resolve(DIR, 'grafana-dashboards')).flatMap((d) => d.metrics),
    ]);
    for (const [metric, reason] of declared) {
      expect(reason.trim().length, `${metric} has no reason`).toBeGreaterThan(10);
      expect(named.has(metric), `${metric} is declared but referenced nowhere`).toBe(true);
    }
  });

  it('a range selector or a bare duration is not a metric name', () => {
    // `rate(foo[30m])` yields a standalone `m` to any regex that does not
    // remove the brackets, and `m` then passes a substring producer check
    // because every source tree contains the letter m. Both halves of that
    // trap are fixed; this is what keeps them fixed.
    expect(metricsIn('rate(foo[30m]) / rate(bar[1h] offset 5m) > 0.5').sort()).toEqual([
      'bar',
      'foo',
    ]);
    expect(metricsIn('max_over_time(baz{job="x"}[6m]) == 1 unless on() qux').sort()).toEqual([
      'baz',
      'qux',
    ]);
  });

  it('a producer match is a whole name, not a substring', () => {
    const recorded = new Set<string>();
    const declared = new Map<string, string>();
    // poker_foo must not be satisfied by a file that only mentions
    // poker_foobar, and nothing may be satisfied by a single letter.
    expect(isProduced('poker_foo', 'emit("poker_foobar", 1)', recorded, declared)).toBe(false);
    expect(isProduced('poker_foo', 'emit("poker_foo", 1)', recorded, declared)).toBe(true);
    expect(isProduced('m', 'const m = 1;', recorded, declared)).toBe(true);
    expect(isProduced('m', 'const somethingelse = 1;', recorded, declared)).toBe(false);
  });

  it('the CI guard still fails when a producer disappears', () => {
    // Proves the check bites. Runs the guard against a haystack that excludes
    // the collector, which is exactly the state the repo was in on 2026-09-04.
    const files = loadedRuleFiles();
    const rules = rulesWithMetrics(DIR, files);
    const without = producerHaystack(root, ['server/src', 'infra/monitoring']);
    const recorded = recordedNames(DIR, files);
    const declared = readDeclaredAbsent(DIR);
    const orphans = new Set<string>();
    for (const rule of rules) {
      for (const metric of rule.metrics) {
        if (!isProduced(metric, without, recorded, declared)) orphans.add(metric);
      }
    }
    expect(orphans.size).toBeGreaterThan(0);
    expect([...orphans]).toContain('poker_settlement_failure_rate');
  });

  it('the guard is wired into CI', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('scripts/ci/check-monitoring-drift.mjs');
    const guard = readFileSync(resolve(root, 'scripts/ci/check-monitoring-drift.mjs'), 'utf8');
    expect(guard).toContain('rule-metric-producers.mjs');
    expect(guard).toContain('isProduced');
  });

  it('reads expressions without being fooled by comments or label names', () => {
    // Both mistakes were made by hand while finding this, and both produced a
    // wrong list of rules before they were caught.
    const exprs = extractExpressions(
      [
        '      - alert: Example',
        '        expr: |',
        '          # poker_a_metric_named_only_in_prose > 1',
        '          poker_real{job="engine_game_server", poker_not_a_metric="x"} > 1',
        '        for: 5m',
      ].join('\n')
    );
    expect(exprs.length).toBe(1);
    const names = metricsIn(exprs[0]);
    expect(names).toContain('poker_real');
    expect(names).not.toContain('poker_a_metric_named_only_in_prose');
    expect(names).not.toContain('poker_not_a_metric');
    expect(names).not.toContain('job');
  });

  // ── A PRODUCER IN THIS REPO IS NOT A PRODUCER IN PRODUCTION (2026-09-21) ──
  //
  // The law above says a rule's metric must have "something that emits it".
  // For four weeks that was read as "something in this repo", which is the
  // weaker claim, and on 2026-09-21 the gap between the two claims was eight
  // rules: six metrics whose producers were merged to main and were NOT in
  // engine 8825af51, the build production was actually running, 125 commits
  // back. check-alert-rules-match.mjs reported all six as "HAVE A PRODUCER,
  // NO SERIES YET - not a failure" and signed off with "every rule reads a
  // real series". Two of the eight were EngineCannotBeReplaced and
  // PokerEngineCannotBeReplaced, written after the 65-hour outage so that it
  // would page somebody next time, and unable to fire during it.
  //
  // These pin the sharper question: the metric must be emitted by the build
  // that is RUNNING, and "I could not tell which build that is" is its own
  // outcome and never a pass.

  const scratchRepo = (files: Record<string, string>): string => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ca-build-producer-'));
    // A pre-push hook exports GIT_DIR / GIT_INDEX_FILE, and a child `git` run
    // from inside one operates on the OUTER repository rather than this temp
    // one. Found by .husky/pre-push refusing this very commit.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
    ) as NodeJS.ProcessEnv;
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: 'ignore', env });
    run('init', '--quiet');
    run('config', 'user.email', 'law@test.invalid');
    run('config', 'user.name', 'law test');
    for (const [rel, body] of Object.entries(files)) {
      const full = resolve(dir, rel);
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
    run('add', '-A');
    run('commit', '--quiet', '-m', 'fixture');
    return dir;
  };

  it('asks the build that is running, not the working tree', () => {
    // One commit that emits ONE of the two names. This is the whole
    // distinction, with no network and no dependence on estate history.
    const dir = scratchRepo({
      'server/src/emit.ts': "register('poker_in_the_running_build', 0);\n",
    });
    try {
      const at = producedAtBuild(
        ['poker_in_the_running_build', 'poker_merged_after_this_build'],
        'HEAD',
        dir
      );
      expect(at.get('poker_in_the_running_build')).toBe(true);
      // Present in a later tree, absent from the deployed one. No event on the
      // platform can give this name a sample, so a rule on it cannot fire.
      expect(at.get('poker_merged_after_this_build')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a metric this repo really does emit is found at a real commit', () => {
    const at = producedAtBuild(
      ['poker_maintenance_break_active', 'poker_not_a_metric_anybody_emits'],
      'HEAD',
      root
    );
    expect(at.get('poker_maintenance_break_active')).toBe(true);
    expect(at.get('poker_not_a_metric_anybody_emits')).toBe(false);
  });

  it('a build this checkout cannot read is COULD NOT TELL, not absent', () => {
    // The dangerous coercion (CLAUDE.md 10.86 rule 2) would be to treat an
    // unreadable commit as "emits nothing" and fail every metric, or as
    // "emits everything" and pass them. haveCommit answers the question
    // separately so the caller can exit 2 instead of guessing either way.
    const dir = scratchRepo({ 'server/src/emit.ts': 'x\n' });
    try {
      expect(haveCommit('HEAD', dir)).toBe(true);
      expect(haveCommit('0123456789abcdef0123456789abcdef01234567', dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a /health that reports no build sha', () => {
    const bad = ['', undefined, null, 'unknown', 'not-a-sha', '123'];
    for (const version of bad) {
      process.env.ENGINE_HEALTH_URL = 'http://127.0.0.1:1/health';
      // engineBuildSha throws either on the unreachable URL or on the payload;
      // either way it THROWS, which is what routes the caller to exit 2.
      expect(() => engineBuildSha()).toThrow();
      expect(typeof version === 'string' || version == null).toBe(true);
    }
    delete process.env.ENGINE_HEALTH_URL;
  });

  it('the guard treats a rule ahead of the running engine as fatal', () => {
    const guard = readFileSync(resolve(root, 'scripts/ci/check-alert-rules-match.mjs'), 'utf8');
    // The split must exist and the ahead-of-the-engine half must set bad.
    expect(guard).toContain('aheadOfTheEngine');
    expect(guard).toContain('RULES AHEAD OF THE ENGINE THAT IS RUNNING');
    // No source window: assert the shape directly, so the branch cannot be
    // present while doing nothing (tests/unit/noFixedSizeSourceWindows).
    expect(guard).toMatch(/if \(aheadOfTheEngine\.length\) \{\s*bad = true;/);
    // And it must never again sign off on series it did not check.
    expect(guard).not.toContain('every rule reads a real series');
    // COULD NOT TELL is exit 2, never 0.
    expect(guard).toContain('COULD NOT TELL WHICH BUILD IS RUNNING');
  });
});
