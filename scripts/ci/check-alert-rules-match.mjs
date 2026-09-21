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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MON = join(ROOT, 'infra', 'monitoring');
const CANARY = 'MonitoringCanary';

// Reviewed reporting contract for FIFO5, not a replacement for the YAML.
// The deployment job has no YAML package installation. Refuse a changed or
// ambiguous selected source block instead of guessing YAML/PromQL semantics.
// Unrelated rules remain covered by the existing names/producer checks below.
const SPIN_RULE = 'SpinUnfilledBacklog';
const SPIN_GROUP = 'spin-experience';
const SPIN_FILE = '/etc/prometheus/spin-rules.yml';
const SPIN_BLOCK_SHA256 = 'e866c2fd89d9bf3b7d0e68f79a625bd37cb602634c72208fa42b1dc0cdb56c15';
const SPIN_CONTRACT = {
  query: 'poker_spin_unfilled_waits > 5',
  duration: 1200,
  keepFiringFor: 0,
  labels: { severity: 'warning', component: 'spin' },
  annotations: {
    summary: '{{ $value }} Spins remain open with a partially filled field',
    description:
      'v_spin_unfilled_waits counts REGISTERING or ANNOUNCED Spins\n' +
      'with no recorded start and between one live seat and one fewer\n' +
      'than capacity. It does not filter wait age, policy or booked draws.\n' +
      "Inspect each board's oldest_seat_at, spin_fill_policy, draw and\n" +
      'hand evidence, and the actual fn_spin_expire_unfilled result.\n' +
      'A drawn or played game requires its continuation or settlement\n' +
      'authority. This count alone proves neither that expiry is due\n' +
      'nor that the expiry timer failed.\n',
    runbook: 'https://monitor.smarter.poker/runbooks/spin-unfilled-backlog',
  },
};

/** Compare actual rule-level templates, never the nested alerts[] rendering.
 * Field names and descriptor are retained in prometheus-rules-0204.json:
 * success -> data.groups[] -> {name,file,rules:[{type,name,query,duration,
 * keepFiringFor,labels,annotations,health,...}]}. No fresh live proof is implied.
 */
function spinReportingEvidence(source, response) {
  if (typeof source !== 'string') throw new Error('Spin rule source is unavailable');
  const lines = source.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^ *-\s+alert:\s*['"]?SpinUnfilledBacklog['"]?\s*(?:#.*)?$/.test(lines[i])) starts.push(i);
  }
  if (starts.length !== 1) throw new Error('Spin rule source is missing or ambiguous');
  const start = starts[0];
  if (lines[start] !== `      - alert: ${SPIN_RULE}`)
    throw new Error('Spin rule source layout changed');
  const groups = lines.slice(0, start).filter((line) => /^  - name:/.test(line));
  if (groups.at(-1) !== `  - name: ${SPIN_GROUP}`)
    throw new Error('Spin rule source group changed');
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && line.length - line.trimStart().length <= 6) break;
    end++;
  }
  const block = lines.slice(start, end).join('\n').trimEnd();
  if (createHash('sha256').update(block).digest('hex') !== SPIN_BLOCK_SHA256) {
    throw new Error('Spin rule source changed; review and refresh its reporting contract');
  }

  if (response?.status !== 'success' || !Array.isArray(response?.data?.groups)) {
    throw new Error('Prometheus rule response is unavailable or malformed');
  }
  const matches = [];
  for (const group of response.data.groups) {
    if (
      !group ||
      typeof group.name !== 'string' ||
      typeof group.file !== 'string' ||
      !Array.isArray(group.rules)
    ) {
      throw new Error('Prometheus rule group is malformed');
    }
    for (const rule of group.rules) {
      if (!rule || typeof rule.name !== 'string' || typeof rule.type !== 'string') {
        throw new Error('Prometheus rule entry is malformed');
      }
      if (rule.name === SPIN_RULE) matches.push({ group, rule });
    }
  }
  if (matches.length !== 1) throw new Error('Loaded Spin rule is missing or ambiguous');
  const { group, rule } = matches[0];
  const differences = [];
  if (group.name !== SPIN_GROUP || group.file !== SPIN_FILE) differences.push('group/file');
  for (const [key, expected] of Object.entries(SPIN_CONTRACT)) {
    if (!isDeepStrictEqual(rule[key], expected)) differences.push(key);
  }
  return { group, rule, differences };
}

export function compareSpinReportingContract(source, response) {
  const { rule, differences } = spinReportingEvidence(source, response);
  if (
    rule.type !== 'alerting' ||
    rule.health !== 'ok' ||
    !(rule.lastError === undefined || rule.lastError === '')
  ) {
    throw new Error(
      `Loaded Spin rule is not a healthy alerting rule: ${JSON.stringify({
        type: rule.type,
        health: rule.health,
        lastError: rule.lastError,
        lastEvaluation: rule.lastEvaluation,
      })}`
    );
  }
  return differences;
}

/** A replaced Prometheus rule starts unevaluated even after reload succeeds.
 * Wait once for its declared 60-second cadence, then read again. This is part
 * of this explicit verification call: no reload, repair, recurring observer,
 * or repeated retry. A still-unknown rule fails the unchanged final checks.
 */
export async function readEvaluatedSpinRules(
  source,
  readRules,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
) {
  const response = await readRules();
  const { group, rule, differences } = spinReportingEvidence(source, response);
  const unevaluated =
    rule.type === 'alerting' &&
    rule.health === 'unknown' &&
    (rule.lastError === undefined || rule.lastError === '') &&
    rule.lastEvaluation === '0001-01-01T00:00:00Z';
  if (unevaluated && differences.length === 0 && group.interval === 60) {
    console.log(
      '[alert-rules] Exact Spin rule awaits its first evaluation; one declared interval allowed.'
    );
    await wait(group.interval * 1000);
    return readRules();
  }
  return response;
}

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
 * ---------------------------------------------------------------------------
 *  RULES THAT READ A SERIES PROMETHEUS HAS NEVER SEEN
 * ---------------------------------------------------------------------------
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
 *
 * So the answer is now in two tiers, because they ask for opposite actions.
 * Both start from the same fact - `label/__name__/values` has never seen the
 * name - and they differ on whether anything in this repo would ever emit it:
 *
 *   PHANTOM (fatal): nothing emits the name. The rule is structurally
 *   unfirable and will read as health forever. Someone writes the producer or
 *   deletes the rule; there is no third option and no waiting it out.
 *
 *   AHEAD OF THE ENGINE THAT IS RUNNING (fatal, added 2026-09-21): the
 *   emitting code exists in this repo and NOT in the build production is
 *   running, so the series can never arrive. Asked of the engine's own
 *   /health.version, because the working tree answers for a build that may
 *   not exist anywhere. Eight rules were in this state on 2026-09-21 and all
 *   eight were reported as the line below.
 *
 *   HAVE A PRODUCER IN THE RUNNING BUILD, NO SERIES YET (reported, not
 *   fatal): the emitting code is in production but has not run. An engine restarted ten minutes ago reads exactly
 *   like this, and failing on it would paint every post-restart deploy red
 *   until traffic happened to touch that path - which is how a gate stops
 *   being read. It is still printed, because a producer that never runs is
 *   worth seeing; `anAlertCannotWaitForAFailureToExist.law.test.ts` is what
 *   makes the zero-seeding binding.
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
    : execFileSync('curl', ['-sf', '--max-time', '20', url], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
  return JSON.parse(raw);
}

/**
 * THE BUILD THAT IS ACTUALLY RUNNING, from its own mouth.
 *
 * `/health.version` is the short commit the engine container was built from.
 * It is the only honest answer to "does the process that publishes metrics
 * contain this producer": the repo's working tree answers for a build that may
 * not exist anywhere yet.
 */
/**
 * The environment with every GIT_* variable removed.
 *
 * A git hook exports GIT_DIR and GIT_INDEX_FILE, and a child `git` launched
 * from inside one IGNORES its own `cwd` and operates on the hook's repository
 * instead. That is a reader silently answering about a different repository
 * than the one it was handed - 10.86 rule 2 in git's clothing - and it is how
 * `.husky/pre-push` refused the commit that introduced these helpers.
 */
function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

export function engineBuildSha() {
  const url = process.env.ENGINE_HEALTH_URL || 'http://localhost:8080/health';
  const health = ask(url);
  const sha = String(health?.version ?? '').trim();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(
      `engine /health reported no usable build sha (version=${JSON.stringify(health?.version)})`
    );
  }
  return sha;
}

/** True when `sha` is a commit this checkout can read. Tries one fetch first. */
export function haveCommit(sha, cwd = process.cwd()) {
  const exists = () => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
        stdio: 'ignore',
        cwd,
        env: gitEnv(),
      });
      return true;
    } catch {
      return false;
    }
  };
  if (exists()) return true;
  try {
    execFileSync('git', ['fetch', '--quiet', '--depth=1', 'origin', sha], {
      stdio: 'ignore',
      cwd,
      env: gitEnv(),
    });
  } catch {
    /* a shallow or offline checkout simply cannot answer; the caller says so */
  }
  return exists();
}

/**
 * Does the code running in production emit this metric?
 *
 * Asked of the engine's OWN commit, not of HEAD. A `git grep` at that tree is
 * exact, and unlike scraping /metrics it is not fooled by a labelled counter
 * that registers no child series until its first observation.
 */
export function producedAtBuild(names, sha, cwd = process.cwd()) {
  const out = new Map();
  for (const name of names) {
    let hit = '';
    try {
      hit = execFileSync(
        'git',
        ['grep', '-l', '--fixed-strings', '-e', name, sha, '--', 'server', 'src'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd, env: gitEnv() }
      ).trim();
    } catch {
      hit = ''; // git grep exits 1 for "no match"; that is an answer, not an error
    }
    out.set(name, hit.length > 0);
  }
  return out;
}

async function main() {
  const declared = declaredAlerts();
  if (declared.size < 20) {
    console.error(
      `[alert-rules] only ${declared.size} alerts parsed out of the repo - the scan is broken, not the box.`
    );
    process.exit(2);
  }

  const promUrl = process.env.PROMETHEUS_URL || 'http://localhost:9090';
  const amUrl = process.env.ALERTMANAGER_URL || 'http://localhost:9093';

  let rules;
  let amAlerts;
  let seriesNames;
  let spinDifferences;
  try {
    const spinSource = readFileSync(join(MON, 'spin-rules.yml'), 'utf8');
    rules = await readEvaluatedSpinRules(spinSource, () => ask(`${promUrl}/api/v1/rules`));
    amAlerts = ask(`${amUrl}/api/v2/alerts`);
    seriesNames = ask(`${promUrl}/api/v1/label/__name__/values`);
    spinDifferences = compareSpinReportingContract(spinSource, rules);
  } catch (err) {
    // COULD NOT ASK IS NOT CLEAN. The whole point of this check is that a
    // monitoring stack nobody can reach looks exactly like one that is fine.
    console.error('[alert-rules] COULD NOT VERIFY THE MONITORING STACK.');
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
  const hasRepoProducer = referenced.filter(([name]) =>
    isProduced(name, haystack, recordedInRepo, declaredAbsent)
  );

  /* A PRODUCER IN THIS REPO IS NOT A PRODUCER IN PRODUCTION (2026-09-21).
     Until today this check stopped here and printed every one of these as
     "HAVE A PRODUCER, NO SERIES YET - not a failure", on the reasoning that a
     counter has no series until its first event. That is true of one of these
     two states and false of the other, and the difference is the whole point:

       awaiting its first event - the producer IS in the build that is running,
       so the series appears the moment the thing happens. Not a failure, and
       failing on it would paint every post-restart deploy red.

       ahead of the running engine - the producer is in this repo and NOT in
       the build that is running, so no event on the platform can ever produce
       a sample. The rule is as dead as one whose metric nobody wrote, and it
       reads as coverage exactly the same way.

     Measured 2026-09-21: six metrics, eight rules, all reported as the first
     when every one of them was the second. Engine 8825af51 (2026-09-18) was
     125 commits behind main and contained none of the six producers. Among
     the eight were EngineCannotBeReplaced and PokerEngineCannotBeReplaced -
     written after the 65-hour outage so that outage would page somebody, and
     structurally unable to fire throughout it. The rules had merged and
     deployed on the monitoring lane; the engine half had not moved. Nothing
     compared the two generations, so this check answered "not a failure" to a
     question it had never asked. */
  let buildSha = null;
  let producedInProduction = new Map();
  if (hasRepoProducer.length > 0) {
    try {
      buildSha = engineBuildSha();
      if (!haveCommit(buildSha)) {
        throw new Error(
          `the engine is running ${buildSha}, which this checkout does not contain ` +
            '(give the job fetch-depth: 0)'
        );
      }
      producedInProduction = producedAtBuild(
        hasRepoProducer.map(([name]) => name),
        buildSha
      );
    } catch (err) {
      // COULD NOT TELL is its own outcome (CLAUDE.md 10.86 rule 1). Reporting
      // these as "not a failure" without asking is the defect being fixed.
      console.error('[alert-rules] COULD NOT TELL WHICH BUILD IS RUNNING.');
      console.error(`   ${err?.message || err}`);
      console.error(
        `   ${hasRepoProducer.length} rule metric(s) have no series, and without the engine's`
      );
      console.error('   own build sha there is no way to say whether they are waiting for a');
      console.error('   first event or can never arrive. This is not a pass.');
      process.exit(2);
    }
  }
  const notYetEmitted = hasRepoProducer.filter(([name]) => producedInProduction.get(name));
  const aheadOfTheEngine = hasRepoProducer.filter(([name]) => !producedInProduction.get(name));

  const missing = [...declared.keys()].filter((a) => !loaded.has(a)).sort();
  const extra = [...loaded].filter((a) => !declared.has(a)).sort();
  const canaryFiring = (amAlerts ?? []).some((a) => a?.labels?.alertname === CANARY);

  console.log(`[alert-rules] repo declares ${declared.size}; the box is running ${loaded.size}.`);

  let bad = false;

  if (spinDifferences.length) {
    bad = true;
    console.error(
      `LOADED ${SPIN_RULE} DIFFERS FROM THE REVIEWED SOURCE: ${spinDifferences.join(', ')}`
    );
  }

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

  if (aheadOfTheEngine.length) {
    bad = true;
    console.error('');
    console.error(
      `RULES AHEAD OF THE ENGINE THAT IS RUNNING (${aheadOfTheEngine.length}) - they cannot fire:`
    );
    for (const [name, file] of aheadOfTheEngine) console.error(`   ${name}   (${file})`);
    console.error(`  The engine is running ${buildSha}. This repo emits each of these metrics and`);
    console.error('  THAT BUILD DOES NOT, so no event on the platform can produce a sample and');
    console.error('  the rule evaluates to an empty vector for ever. Prometheus reports it as');
    console.error('  health=ok, state=inactive, which is the same thing it reports for an alarm');
    console.error('  that is genuinely quiet.');
    console.error('  Deploy the engine (auto-deploy-hetzner.yml, at the :55 break) so the half');
    console.error('  that publishes the metric is the same generation as the half that reads');
    console.error('  it. Do NOT delete or silence the rule to clear this.');
  }

  if (notYetEmitted.length) {
    console.log('');
    console.log(
      `HAVE A PRODUCER IN THE RUNNING BUILD, NO SERIES YET (${notYetEmitted.length}) - not a failure:`
    );
    for (const [name, file] of notYetEmitted) console.log(`   ${name}   (${file})`);
    console.log(`  Engine ${buildSha} - the build actually running - emits each of these. A`);
    console.log('  counter has no series until its first event, and a gauge has none until its');
    console.log('  first scrape after release.');
    console.log('  check-monitoring-drift.mjs check 8 is what proves the producer exists, and');
    console.log('  it runs on the pull request rather than after the merge.');
  }

  if (!bad)
    console.log(
      `[alert-rules] OK - the box runs what this repo declares, every rule reads a series the running build${
        buildSha ? ` (${buildSha})` : ''
      } can actually produce, and the canary is alive.`
    );
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
