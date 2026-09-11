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
import { join, dirname } from 'node:path';
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
 * Deliberately loose: it collects bare identifiers that look like metric
 * names and skips PromQL keywords, functions, label matchers and recording
 * rules (which begin with a group prefix like `sp:`). A false positive here
 * is a name to explain; a false negative is an alert nobody will ever get.
 */
const PROMQL_WORDS = new Set([
  'and', 'or', 'unless', 'by', 'without', 'on', 'ignoring', 'group_left',
  'group_right', 'offset', 'bool', 'if', 'default', 'inf', 'nan',
  'rate', 'irate', 'increase', 'sum', 'avg', 'min', 'max', 'count', 'topk',
  'bottomk', 'quantile', 'stddev', 'stdvar', 'absent', 'absent_over_time',
  'delta', 'idelta', 'deriv', 'predict_linear', 'histogram_quantile',
  'label_replace', 'label_join', 'time', 'timestamp', 'vector', 'scalar',
  'clamp_max', 'clamp_min', 'round', 'abs', 'ceil', 'floor', 'exp', 'ln',
  'log2', 'log10', 'sqrt', 'changes', 'resets', 'sort', 'sort_desc',
  'avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time',
  'count_over_time', 'quantile_over_time', 'stddev_over_time',
  'last_over_time', 'present_over_time', 'group', 'count_values',
]);

function metricsReferenced() {
  const out = new Map();
  for (const f of loadedRuleFiles()) {
    const p = join(MON, f);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, 'utf8').replace(/^\s*#[^\n]*$/gm, '');
    for (const m of txt.matchAll(/^\s*expr:\s*\|?\s*\n?([\s\S]*?)(?=\n\s*(?:-\s|for:|labels:|annotations:|record:|alert:|$))/gm)) {
      const expr = m[1];
      for (const id of expr.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*[:"])/g)) {
        const name = id[1];
        if (PROMQL_WORDS.has(name)) continue;
        if (!name.includes('_')) continue;          // labels, bare words
        if (/^(job|instance|severity|component|alertname|le|quantile)$/.test(name)) continue;
        // a label INSIDE a matcher is followed by = or !=, never a metric
        const at = id.index ?? 0;
        const after = expr.slice(at + name.length).replace(/^\s+/, '');
        if (after.startsWith('=') || after.startsWith('!=') || after.startsWith('=~')) continue;
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
  const phantom = [...metricsReferenced().entries()]
    .filter(([name]) => !known.has(name) && !recorded.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

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
    console.error(`RULES THAT READ A SERIES PROMETHEUS HAS NEVER SEEN (${phantom.length}):`);
    for (const [name, file] of phantom) console.error(`   ${name}   (${file})`);
    console.error('  These rules load, evaluate to an empty vector, and can never cross a');
    console.error('  threshold - so they read as coverage and provide none. Either publish');
    console.error('  the metric, point the rule at the name the producer actually emits, or');
    console.error('  delete the rule. Do not leave it: alert-rules.QUARANTINED.yml already');
    console.error('  records what a directory of these costs.');
  }

  if (!bad) console.log('[alert-rules] OK - the box runs what this repo declares, every rule reads a real series, and the canary is alive.');
  process.exit(bad ? 1 : 0);
}

main();
