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

/** Ask a URL, through ssh when we are not on the box. */
function ask(url) {
  const ssh = process.env.ENGINE_MONITORING_SSH;
  const args = ssh
    ? [ssh, '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', `curl -sf --max-time 20 '${url}'`]
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
  try {
    rules = ask(`${promUrl}/api/v1/rules`);
    amAlerts = ask(`${amUrl}/api/v2/alerts`);
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

  if (!bad) console.log('[alert-rules] OK - the box is running exactly what this repo declares, and the canary is alive.');
  process.exit(bad ? 1 : 0);
}

main();
