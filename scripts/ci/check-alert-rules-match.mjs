#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RULES RUNNING ON THE BOX ARE THE RULES IN THIS REPO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Realtime Connections Programme, phase 7 - guardrails.
 *
 * `tests/what-a-monitor-reads-is-what-the-repo-says.law.test.ts` proves the
 * three FILE LISTS agree. It cannot prove the box is running what the lists
 * describe, because a test has no network and production is a different
 * machine. This does that half, and it is the half phase 1 needed:
 *
 *   Measured 2026-09-06, before the reconciliation:
 *     72 alerts running on engine-01
 *     79 declared in infra/monitoring/
 *     15 declared and NEVER LOADED - including EngineRefusingSessions and
 *        EngineCannotReachAuth, the two this programme wrote in phase 1 so
 *        the outage it exists to prevent would page somebody
 *      8 running that this repo had never seen
 *
 * "An alert rule is not live because it merged; it is live when
 * /api/v1/rules says so." This asks.
 *
 * IT ALSO ASKS ALERTMANAGER FOR THE CANARY. Prometheus can hold a rule and
 * still not be delivering: `MonitoringCanary` fires unconditionally, so if
 * Alertmanager is not holding it, the pipe is broken and every other alert is
 * silent for the same reason - a silence indistinguishable from health.
 *
 * Usage:
 *   ENGINE_MONITORING_SSH=root@5.161.252.33 node scripts/ci/check-alert-rules-match.mjs
 *   PROMETHEUS_URL=http://localhost:9090 ALERTMANAGER_URL=http://localhost:9093 node ... (on the box)
 *
 * Exit: 0 clean · 1 drift · 2 could not ask (NEVER silently green)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
  extractExpressions,
  metricsIn,
  producerHaystack,
  recordedNames,
  readDeclaredAbsent,
  isProduced,
} from './rule-metric-producers.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MON = join(ROOT, 'infra', 'monitoring');
const CANARY = 'MonitoringCanary';

/** Which rule files Prometheus is told to load. */
function loadedRuleFiles() {
  const prom = readFileSync(join(MON, 'prometheus.yml'), 'utf8');
  const block = (prom.split(/^rule_files:/m)[1] ?? '').split(/\n(?=[a-z_]+:)/)[0];
  return [...block.matchAll(/^\s+-\s+(\S+\.yml)\s*$/gm)].map((m) => m[1].split('/').pop());
}

/** Every alert this repo declares, across the files Prometheus loads. */
function declaredAlerts() {
  const out = new Map();
  for (const f of loadedRuleFiles()) {
    const p = join(MON, f);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, 'utf8').replace(/^\s*#[^\n]*$/gm, '');
    for (const m of txt.matchAll(/^\s*-\s*alert:\s*(\S+)\s*$/gm)) out.set(m[1], f);
  }
  return out;
}

/**
 * Every metric NAME an expression in the loaded rule files reads.
 *
 * ADDED 2026-09-09, because this check reconciled rule NAMES between the repo
 * and the box and never asked whether the rules could ever fire. Fifteen of
 * them referenced series with no producer anywhere - among them
 * `poker_hands_total`, read by `SLOHandsAreNotBeingDealt` (severity
 * critical, page: sms), which `rate()`s an empty vector and is therefore
 * structurally unfirable. `alert-rules.QUARANTINED.yml` says the same thing
 * about the last set: "loaded and silently evaluated to nothing, which is
 * worse than not having them." Nothing was checking.
 *
 * 2026-09-11: this now uses the same extractor as check-monitoring-drift.mjs
 * rather than its own. Its own read `sp:action_to_broadcast:p95_ms` as the
 * metric `p95_ms`, because its identifier pattern did not treat `:` as part of
 * a name, and the comment below claiming it skipped recording-rule prefixes was
 * describing an intention the code did not carry out. `max_ms` and `p95_ms`
 * were reported as phantoms on every run, and this job had failed on them four
 * times running since 2026-09-09. A check that fails for a reason nobody can
 * act on is a check people stop reading, and this one was right about eleven
 * real metrics at the same time.
 *
 * A false positive here is not a cheap thing to pay. It is the whole cost.
 */

function metricsReferenced() {
  const out = new Map();
  for (const f of loadedRuleFiles()) {
    const p = join(MON, f);
    if (!existsSync(p)) continue;
    for (const expr of extractExpressions(readFileSync(p, 'utf8'))) {
      for (const name of metricsIn(expr)) {
        if (!name.includes('_') && !name.includes(':')) continue; // bare words
        if (!out.has(name)) out.set(name, f);
      }
    }
  }
  return out;
}

/** Ask a URL, through ssh when we are not on the box. */
function ask(url) {
  const ssh = process.env.ENGINE_MONITORING_SSH;
  const args = ssh
    ? [
        '-o',
        'ConnectTimeout=15',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        ssh,
        `curl -sf --max-time 20 '${url}'`,
      ]
    : null;
  const raw = ssh
    ? execFileSync('ssh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    : execFileSync('curl', ['-sf', '--max-time', '20', url], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(raw);
}

function main() {
  const declared = declaredAlerts();
  if (declared.size < 20) {
    console.error(`[alert-rules] only ${declared.size} alerts parsed out of the repo - the scan is broken, not the box.`);
    process.exit(2);
  }

  const promUrl = process.env.PROMETHEUS_URL || 'http://localhost:9090';
  const amUrl = process.env.ALERTMANAGER_URL || 'http://localhost:9093';

  let rules;
  let amAlerts;
  let seriesNames;
  try {
    rules = ask(`${promUrl}/api/v1/rules`);
    amAlerts = ask(`${amUrl}/api/v2/alerts`);
    seriesNames = ask(`${promUrl}/api/v1/label/__name__/values`);
  } catch (err) {
    // COULD NOT ASK IS NOT CLEAN. The whole point of this check is that a
    // monitoring stack nobody can reach looks exactly like one that is fine.
    console.error('[alert-rules] COULD NOT REACH THE MONITORING STACK.');
    console.error(`   ${err?.message || err}`);
    console.error('   This is not a pass. Set ENGINE_MONITORING_SSH, or run it on the box.');
    process.exit(2);
  }

  const loaded = new Set();
  for (const g of rules?.data?.groups ?? []) {
    for (const r of g.rules ?? []) if (r.type === 'alerting') loaded.add(r.name);
  }

  /* A rule whose metric has no series is a rule that cannot fire. Recording
     rules are exempt: their own output is what the alerts read, and it only
     exists once the recording rule has evaluated at least once. */
  const known = new Set(seriesNames?.data ?? []);
  const recorded = new Set();
  for (const g of rules?.data?.groups ?? []) {
    for (const r of g.rules ?? []) if (r.type === 'recording') recorded.add(r.name);
  }
  /* Two very different things look identical from Prometheus alone.
     A name with NO PRODUCER can never have a series: that is the 2026-09-04
     defect and it is fatal. A name with a producer that has simply not been
     emitted yet is a counter waiting for its first event - six horse counters
     were in exactly that state on 2026-09-11 and appeared on their own within
     hours. Failing a deploy on the second is how the first stopped being read. */
  const repoRoot = resolve(MON, '..', '..');
  const haystack = producerHaystack(repoRoot);
  const declaredAbsent = readDeclaredAbsent(MON);
  const recordedInRepo = recordedNames(MON, loadedRuleFiles());
  const referenced = [...metricsReferenced().entries()]
    .filter(([name]) => !known.has(name) && !recorded.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const phantom = referenced.filter(
    ([name]) => !isProduced(name, haystack, recordedInRepo, declaredAbsent)
  );
  const notYetEmitted = referenced.filter(([name]) =>
    isProduced(name, haystack, recordedInRepo, declaredAbsent)
  );

  const missing = [...declared.keys()].filter((a) => !loaded.has(a)).sort();
  const extra = [...loaded].filter((a) => !declared.has(a)).sort();
  const canaryFiring = (amAlerts ?? []).some((a) => a?.labels?.alertname === CANARY);

  console.log(`[alert-rules] repo declares ${declared.size}; the box is running ${loaded.size}.`);

  let bad = false;

  if (!canaryFiring) {
    bad = true;
    console.error('');
    console.error(`THE CANARY IS NOT IN ALERTMANAGER.`);
    console.error(`  ${CANARY} fires unconditionally. If Alertmanager is not holding it, rules`);
    console.error('  are not being evaluated or not being delivered - and every other alert is');
    console.error('  quiet for the same reason. That silence is indistinguishable from health,');
    console.error('  which is what twenty-two hours of it was made of on 2026-09-03.');
  }

  if (missing.length) {
    bad = true;
    console.error('');
    console.error(`DECLARED HERE, NOT RUNNING ON THE BOX (${missing.length}):`);
    for (const a of missing) console.error(`   ${a}   (${declared.get(a)})`);
    console.error('  A rule is not live because it merged. Run infra/monitoring/deploy.sh.');
  }

  if (extra.length) {
    bad = true;
    console.error('');
    console.error(`RUNNING ON THE BOX, NOT IN THIS REPO (${extra.length}):`);
    for (const a of extra) console.error(`   ${a}`);
    console.error('  Somebody wrote these by hand on the box. The next deploy DELETES them,');
    console.error('  because deploy.sh symlinks this repo over the live files. Bring them in');
    console.error('  here first - that is how the 2026-09-04 cron and postgres rules were');
    console.error('  nearly lost.');
  }

  if (phantom.length) {
    bad = true;
    console.error('');
    console.error(`RULES THAT READ A METRIC NOTHING EMITS (${phantom.length}):`);
    for (const [name, file] of phantom) console.error(`   ${name}   (${file})`);
    console.error('  These rules load, evaluate to an empty vector, and can never cross a');
    console.error('  threshold - so they read as coverage and provide none. Either publish');
    console.error('  the metric, point the rule at the name the producer actually emits, or');
    console.error('  delete the rule. Do not leave it: alert-rules.QUARANTINED.yml already');
    console.error('  records what a directory of these costs.');
  }

  if (notYetEmitted.length) {
    console.log('');
    console.log(`HAVE A PRODUCER, NO SERIES YET (${notYetEmitted.length}) - not a failure:`);
    for (const [name, file] of notYetEmitted) console.log(`   ${name}   (${file})`);
    console.log('  Something in this repo emits each of these. A counter has no series until');
    console.log('  its first event, and a gauge has none until its first scrape after release.');
    console.log('  check-monitoring-drift.mjs check 8 is what proves the producer exists, and');
    console.log('  it runs on the pull request rather than after the merge.');
  }

  if (!bad) console.log('[alert-rules] OK - the box runs what this repo declares, every rule reads a real series, and the canary is alive.');
  process.exit(bad ? 1 : 0);
}

main();
