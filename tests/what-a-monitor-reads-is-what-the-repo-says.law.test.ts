/**
 * LAW: WHAT A MONITOR READS IS WHAT THIS REPO SAYS
 * ═══════════════════════════════════════════════════════════════════════════
 * Realtime Connections Programme, phase 7 of 7 - guardrails.
 *
 * Phase 1 recorded this as "the biggest single finding of the phase, and it is
 * not a phase 1 deliverable": the alert rules running on engine-01 were not the
 * alert rules in this repo, in BOTH directions. Phase 7 is where it gets fixed,
 * and the fix is only half code - the other half is this file, because the
 * drift did not happen through anybody's carelessness. It happened because
 * THREE LISTS OF FILES had to agree and nothing checked that they did:
 *
 *   1. `prometheus.yml` `rule_files:`      - what Prometheus LOADS
 *   2. `docker-compose.yml` volume mounts  - what the container can SEE
 *   3. `deploy.sh`'s symlink loop          - what a deploy actually UPDATES
 *
 * On 2026-09-06 list 3 named four of the seven files in list 1. So
 * `engine-freeze-rules.yml`, `supervisor-rules.yml`, `tournament-rules.yml` and
 * `spin-rules.yml` were on the box only because somebody had put them there by
 * hand: a rule added to any of them in this repo could never reach production,
 * and a deploy would leave the hand-written copy in place for ever.
 *
 * Measured the same morning, before the fix: 72 alerts running on the box, 79
 * declared here, **15 declared and never loaded** - among them
 * `EngineRefusingSessions` and `EngineCannotReachAuth`, the two alerts THIS
 * PROGRAMME wrote in phase 1 so that the outage it exists to prevent would page
 * somebody - and **8 running that this repo had never seen**.
 *
 * PINS
 *   1. Every rule file Prometheus loads is mounted, and is symlinked by the
 *      deploy. A rule file that is loaded but not deployed is a file only a
 *      human hand can change.
 *   2. No alert group is empty. This repo carried three - `cron-health`,
 *      `postgres-health`, `vercel-health` - as headings with no rules under
 *      them, while the box had the rules. An empty group is worse than an
 *      absent one: it reads as coverage.
 *   3. The canary exists and always fires. Every other rule is quiet when
 *      things are well, which makes "no alerts" and "no monitoring" the same
 *      observation - and they were the same observation for twenty-two hours.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const MON = join(ROOT, 'infra', 'monitoring');
const PROM = readFileSync(join(MON, 'prometheus.yml'), 'utf8');
const COMPOSE = readFileSync(join(MON, 'docker-compose.yml'), 'utf8');
const DEPLOY = readFileSync(join(MON, 'deploy.sh'), 'utf8');
const ALERTMANAGER = readFileSync(join(MON, 'alertmanager.yml'), 'utf8');

/** The rule files Prometheus is told to load, by basename. */
function loadedRuleFiles(): string[] {
  const block = PROM.split(/^rule_files:/m)[1] ?? '';
  const upTo = block.split(/\n(?=[a-z_]+:)/)[0];
  return [...upTo.matchAll(/^\s+-\s+(\S+\.yml)\s*$/gm)].map((m) => m[1].split('/').pop() as string);
}

describe('LAW 1 - loaded, mounted, and actually deployed are the same list', () => {
  const loaded = loadedRuleFiles();

  it('finds the rule files at all (a scan that finds nothing passes everything)', () => {
    expect(loaded.length, 'no rule_files parsed out of prometheus.yml').toBeGreaterThanOrEqual(4);
  });

  it.each(loadedRuleFiles())('%s exists in this repo', (f) => {
    expect(
      existsSync(join(MON, f)),
      `${f} is loaded by prometheus.yml and is not in infra/monitoring/`
    ).toBe(true);
  });

  it.each(loadedRuleFiles())('%s is mounted into the prometheus container', (f) => {
    expect(
      COMPOSE.includes(`./${f}:/etc/prometheus/${f}`),
      `${f} is loaded by prometheus.yml but docker-compose.yml does not mount it - ` +
        'Prometheus would fail to start, or silently run without it.'
    ).toBe(true);
  });

  it.each(loadedRuleFiles())('%s is symlinked by deploy.sh, so a deploy can update it', (f) => {
    // The symlink loop is one `for f in ... ; do ln -sfn ...` - the file has to
    // be named in it or the deploy leaves whatever is on the box in place.
    const from = DEPLOY.indexOf('for f in');
    const loop = DEPLOY.slice(from, DEPLOY.indexOf('done', from));
    expect(
      loop.includes(f),
      `${f} is loaded by prometheus.yml and deploy.sh does not symlink it. ` +
        'A rule added to it in this repo can never reach production, and the ' +
        'copy on the box can only be changed by hand - which is exactly the ' +
        'drift phase 1 found.'
    ).toBe(true);
  });
});

describe('LAW 2 - no alert group is an empty promise', () => {
  it.each(loadedRuleFiles())('%s has no group without rules', (f) => {
    const txt = readFileSync(join(MON, f), 'utf8');
    const empty: string[] = [];
    for (const chunk of txt.split(/\n(?=\s{0,4}- name:)/)) {
      const name = chunk.match(/^\s*- name:\s*(\S+)/)?.[1];
      if (!name) continue;
      const body = chunk.replace(/#[^\n]*/g, '');
      if (!/\n\s*-\s*(alert|record):/.test(body)) empty.push(name);
    }
    expect(
      empty,
      `these groups in ${f} promise coverage and contain no rules. Delete the ` +
        'heading (with a comment saying where the coverage really lives) or ' +
        'fill it - an empty group reads as monitoring and is not.'
    ).toEqual([]);
  });
});

describe('LAW 3 - the canary, because silence has to mean something', () => {
  const RULES = readFileSync(join(MON, 'alert-rules.yml'), 'utf8');

  it('MonitoringCanary exists and is unconditional', () => {
    expect(RULES).toContain('- alert: MonitoringCanary');
    const block = RULES.slice(RULES.indexOf('- alert: MonitoringCanary'));
    const expr = block.slice(block.indexOf('expr:'), block.indexOf('labels:'));
    // `vector(1)` has no dependency on any metric: if the evaluator runs at
    // all, this fires. Anything conditional could be quiet for a real reason
    // and would stop being a canary.
    expect(expr).toContain('vector(1)');
    expect(expr).not.toMatch(/poker_|node_|up\{/);
  });

  it('it is severity canary, so it never wakes anyone', () => {
    // Bounded by the thing that ends the alert - the next `- alert:` or the
    // end of the file - never by a byte count, which goes stale the first time
    // the annotation gains a line (tests/unit/noFixedSizeSourceWindows).
    const block = sliceBetween(RULES, '- alert: MonitoringCanary', '\n      - alert:');
    expect(block).toMatch(/severity:\s*canary/);
    // And nothing louder is smuggled in beside it.
    expect(block).not.toMatch(/severity:\s*(critical|warning)/);
    expect(block).not.toMatch(/page:\s*sms/);
  });

  it('and something actually checks for it', () => {
    // A canary nobody looks for is decoration. The checker is what turns its
    // absence into a failure.
    const checker = join(ROOT, 'scripts', 'ci', 'check-alert-rules-match.mjs');
    expect(existsSync(checker), 'scripts/ci/check-alert-rules-match.mjs is missing').toBe(true);
    const src = readFileSync(checker, 'utf8');
    // The NAME IT LOOKS FOR, not a mention of it. The first version of this
    // pin read the whole file, and a mutation that pointed the checker at a
    // different alertname passed - because the header still talked about the
    // canary. A pin satisfied by prose is not a pin.
    expect(src, 'the checker must look for MonitoringCanary by name').toMatch(
      /const CANARY = 'MonitoringCanary';/
    );
    expect(src).toContain('labels?.alertname === CANARY');
  });
});

/**
 * LAW 4 - THE ROUTING IS IN THIS REPO TOO (audit, 2026-09-06)
 *
 * `deploy.sh` symlinks `alertmanager.yml` over the live one exactly as it does
 * the rule files, and the phase-7 audit found the live file carried a
 * `pager-sms` receiver and a `page="sms"` route THIS REPO DID NOT HAVE - the
 * 3am pager, added on the box on 2026-09-04. A deploy would have deleted
 * paging outright, and the rules check would have said nothing, because it
 * only reads alerts.
 *
 * The canary's route is here for the opposite reason. The top-level
 * fallthrough receiver is `email-critical`, so an unmatched `severity: canary`
 * would email ops every hour, for ever - alert fatigue manufactured by the
 * very thing built to prevent it. It was missing for the first hour of the
 * phase.
 */
describe('LAW 4 - the routing is in this repo, and the canary reaches nobody', () => {
  it('the pager survives a deploy: receiver and route are both declared here', () => {
    expect(
      ALERTMANAGER,
      'the pager-sms receiver must exist in this repo or a deploy deletes it'
    ).toMatch(/^\s*- name: pager-sms\s*$/m);
    expect(ALERTMANAGER, 'and the route that reaches it').toMatch(/page="sms"/);
  });

  it('the canary is routed to null-receiver, explicitly', () => {
    const route = sliceBetween(ALERTMANAGER, 'severity="canary"', '\n    - matchers:');
    expect(route).toMatch(/receiver:\s*null-receiver/);
  });

  it('and the deploy refuses to remove routing that is live', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/deploy-monitoring.yml'), 'utf8');
    expect(wf).toContain('Refuse to delete routing this repo has never seen');
    expect(wf).toContain('Deploying would REMOVE routing that is live on the box');
    // And the same for the rules, which is the half that was written first.
    expect(wf).toContain('Refuse to delete rules this repo has never seen');
  });
});
