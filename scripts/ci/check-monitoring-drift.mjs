#!/usr/bin/env node
/**
 * check-monitoring-drift.mjs
 *
 * BLOCKING CI GUARD — monitoring wiring must not silently break.
 *
 * Why
 * ───
 * On 2026-08-15 five of the seven files in infra/monitoring/ had drifted from
 * the stack actually running on the Hetzner box, several by hundreds of lines.
 * The repo still held the PRE-FIX versions: 27 alert rules referencing metrics
 * that do not exist, and an Alertmanager whose default route was
 * `null-receiver`. Rebuilding the host from this repo would have quietly
 * restored decorative monitoring, and nobody would have noticed until the next
 * freeze went unreported.
 *
 * CI cannot reach production, so this does not diff against the host. It
 * enforces the structural invariants that made the drift dangerous — all
 * checkable from the repo alone, and all of them things that fail SILENTLY:
 *
 *   1. Every rules file in infra/monitoring is listed in prometheus.yml
 *      rule_files. A rules file that exists but is never loaded is the most
 *      common way an alert stops existing.
 *   2. Every rule_files entry resolves to a file on disk. A dangling entry
 *      makes Prometheus refuse to start — an outage in the outage detector.
 *   3. Every rule_files entry is mounted into the Prometheus container at THAT
 *      EXACT CONTAINER PATH. This is the failure that is invisible locally and
 *      fatal in production. Comparing basenames (the first version of this
 *      check) passed a compose file mounting to /etc/prometheus/rules/x.yml
 *      while prometheus.yml looked for /etc/prometheus/x.yml.
 *   4. Every loaded rules file actually declares rules. `groups: []` loads
 *      cleanly and alerts on nothing — the same end state as the 27 broken
 *      rules, reached by a different route. A file may opt out by saying
 *      DISABLED in a leading comment, which is how slo-rules.yml records that
 *      it needs blackbox-exporter first.
 *   5. Alertmanager's default route must not discard alerts: not a
 *      null/blackhole-style name, and not a receiver with no delivery
 *      configured at all.
 *
 *   8. Every metric name a rule EXPRESSION references has something in this
 *      repo that emits it. Added 2026-09-11, after fifteen rules written on
 *      2026-09-04 were found referencing thirteen metric names that nothing in
 *      the estate produced. `poker_settlement_failure_rate > 0.02` against a
 *      metric with no samples is an empty vector: not an error, not a warning,
 *      just permanently green. Four of those rules described conditions that
 *      were true when the gap was found, two of them SMS pages, one true for
 *      13.7 days. It had happened twice before on smaller scales - the
 *      27 rules recovered on 2026-08-15, and `poker_hands_total` leaving
 *      SLOHandsAreNotBeingDealt unable to fire (see slo-rules.yml) - which is
 *      what makes it a class rather than an incident.
 *
 *      This check is why the header no longer says expressions are out of
 *      scope. It does not evaluate them; it asks only whether the names they
 *      use exist anywhere as output. A name with no producer either gets one,
 *      or gets a line in infra/monitoring/metrics-without-a-producer.txt
 *      saying who emits it and why CI cannot see that.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import {
  rulesWithMetrics,
  producerHaystack,
  recordedNames,
  readDeclaredAbsent,
  isProduced,
  dashboardsWithMetrics,
} from './rule-metric-producers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = resolve(root, 'infra/monitoring');
const errors = [];

if (!existsSync(DIR)) {
  console.error(`FAIL: ${DIR} does not exist`);
  process.exit(1);
}

const read = (f) => readFileSync(resolve(DIR, f), 'utf8');
const prom = read('prometheus.yml');
const compose = read('docker-compose.yml');

// ── Parse rule_files ─────────────────────────────────────────────────────────
// Line-by-line, not one regex: comment lines inside the block contain hyphens
// (dates, prose) and a naive `-\s*(\S+)` reads "2026-08-15" as a filename.
const loaded = []; // container paths, verbatim
{
  const lines = prom.split('\n');
  const start = lines.findIndex((l) => /^\s*rule_files:\s*$/.test(l));
  if (start === -1) {
    if (/^\s*rule_files:\s*\[/m.test(prom)) {
      errors.push(
        'prometheus.yml uses flow-style rule_files ([a, b]). Use block style (one "- path" per line) so this check can verify each entry.'
      );
    } else {
      errors.push('prometheus.yml has no rule_files: block — no alert rules are loaded at all.');
    }
  } else {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*$/.test(line)) continue;
      if (/^\s*#/.test(line)) continue;
      const item = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (!item) break; // dedent — block is over
      loaded.push(item[1].replace(/^['"]|['"]$/g, '')); // tolerate quoting
    }
  }
}

for (const p of loaded) {
  if (p.includes('*') || p.includes('?')) {
    errors.push(
      `prometheus.yml rule_files entry "${p}" is a glob. Globs are valid Prometheus config but make it impossible to verify statically that each rules file is mounted — list files explicitly.`
    );
  }
}

const explicit = loaded.filter((p) => !p.includes('*') && !p.includes('?'));
const loadedNames = explicit.map((p) => basename(p));

// ── 1. every rules file on disk is loaded ────────────────────────────────────
const onDisk = readdirSync(DIR).filter(
  (f) => /(-rules|-alerts)\.ya?ml$/.test(f) && !f.includes('QUARANTINED')
);
for (const f of onDisk) {
  if (!loadedNames.includes(f)) {
    errors.push(
      `infra/monitoring/${f} exists but is NOT in prometheus.yml rule_files — its alerts do not exist in production.`
    );
  }
}

// ── 2. every loaded file exists, and 3. is mounted at that exact path ────────
for (const p of explicit) {
  const f = basename(p);
  if (!existsSync(resolve(DIR, f))) {
    errors.push(
      `prometheus.yml rule_files references ${p}, but ${f} is not in infra/monitoring/ — Prometheus will refuse to start.`
    );
    continue;
  }
  // Match the full container path, not just the basename.
  const mounted = new RegExp(
    `^\\s*-\\s*['"]?[^'":]+:${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:[a-z,]+)?['"]?\\s*$`,
    'm'
  ).test(compose);
  if (!mounted) {
    errors.push(
      `${f} is loaded by prometheus.yml as ${p}, but docker-compose.yml does not mount anything to that exact container path — valid in the repo, missing inside the container.`
    );
  }
}

// ── 4. loaded rules files must actually declare rules ────────────────────────
for (const p of explicit) {
  const f = basename(p);
  if (!existsSync(resolve(DIR, f))) continue;
  const body = read(f);
  const head = body.split('\n').slice(0, 12).join('\n');
  if (/DISABLED|INTENTIONALLY EMPTY/i.test(head)) continue; // documented opt-out
  if (/^\s*groups:\s*\[\s*\]\s*$/m.test(body) || !/^\s*groups:\s*$/m.test(body)) {
    errors.push(
      `${f} is loaded but declares no rule groups. It will load cleanly and alert on nothing. If that is intentional, say DISABLED in a comment at the top of the file (see slo-rules.yml).`
    );
    continue;
  }
  if (!/^\s*-\s*alert:\s*\S/m.test(body) && !/^\s*-\s*record:\s*\S/m.test(body)) {
    errors.push(`${f} declares groups but contains no alert: or record: rules.`);
  }
}

// ── 5. alerts must reach somewhere real ──────────────────────────────────────
if (existsSync(resolve(DIR, 'alertmanager.yml'))) {
  const am = read('alertmanager.yml');
  // The TOP-LEVEL route's receiver: the first `receiver:` at exactly two-space
  // depth under `route:`. Grabbing the first `receiver:` anywhere after
  // `route:` reads a child route's receiver if `routes:` is listed first.
  let defaultReceiver = null;
  {
    const lines = am.split('\n');
    const rIdx = lines.findIndex((l) => /^route:\s*$/.test(l));
    if (rIdx !== -1) {
      for (let i = rIdx + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) break; // dedent to a new top-level key
        const m = /^ {1,2}receiver:\s*['"]?([\w.-]+)/.exec(lines[i]);
        if (m) { defaultReceiver = m[1]; break; }
      }
    }
  }
  if (!defaultReceiver) {
    errors.push('alertmanager.yml has no default route receiver — could not determine where alerts go.');
  } else if (/null|blackhole|devnull|noop|void|discard|drop/i.test(defaultReceiver)) {
    errors.push(
      `alertmanager.yml default route sends everything to '${defaultReceiver}' — alerts fire into a void. This is the exact state the stack was found in on 2026-08-15.`
    );
  } else {
    // A receiver can also discard by being defined with no delivery config.
    const block = new RegExp(
      `^\\s*-\\s*name:\\s*['"]?${defaultReceiver}['"]?\\s*$([\\s\\S]*?)(?=^\\s*-\\s*name:|^\\S|$(?![\\s\\S]))`,
      'm'
    ).exec(am);
    if (!block) {
      errors.push(`alertmanager.yml default receiver '${defaultReceiver}' is routed to but never defined.`);
    } else if (!/_configs:/.test(block[1])) {
      errors.push(
        `alertmanager.yml default receiver '${defaultReceiver}' has no *_configs: block — it is defined but delivers nothing, which discards every alert just as effectively as null-receiver.`
      );
    }
  }
}

// ── 6. bind-mounted secret files must be recoverable ─────────────────────────
// Docker creates a DIRECTORY when a bind-mount source is missing, so a rebuilt
// host silently gets /etc/alertmanager/resend_key as a directory and
// Alertmanager fails to authenticate to SMTP — every alert generated, none
// delivered, with an error that does not mention the real cause. These files
// cannot live in git, so require a .example sibling and a README mention so
// the rebuild path is discoverable.
{
  const MOUNT = /^\s*-\s*['"]?\.\/([^:'"]+):([^:'"]+)(:[a-z,]+)?['"]?\s*$/gm;
  let m;
  const readme = existsSync(resolve(DIR, 'README.md')) ? read('README.md') : '';
  while ((m = MOUNT.exec(compose)) !== null) {
    const hostPath = m[1];
    if (/\.(ya?ml)$/.test(hostPath)) continue;          // covered by checks 1-3
    if (existsSync(resolve(DIR, hostPath))) continue;    // present in the repo
    // Only flag plain single filenames. Directory mounts (grafana-dashboards,
    // grafana-provisioning) are created by compose and are not secrets.
    if (!/^[\w.-]+$/.test(hostPath)) continue;
    const hasExample = existsSync(resolve(DIR, `${hostPath}.example`)) ||
                       existsSync(resolve(DIR, `${hostPath}.sample`));
    const inReadme = readme.includes(hostPath);
    if (!hasExample || !inReadme) {
      errors.push(
        `docker-compose.yml bind-mounts ./${hostPath}, which is not in the repo` +
          (hasExample ? '' : ', has no .example sibling') +
          (inReadme ? '' : ', and is not mentioned in README.md') +
          `. On a rebuilt host Docker will create a DIRECTORY there and the container will fail in a way that does not name the cause.`
      );
    }
  }
}

// ── 7. Every scrape job that ever existed still exists ──────────────────────
//
// 2026-08-31: the live host carried a `turn_relay` scrape job that had been
// added directly on engine-01 on 2026-08-28 and NEVER COMMITTED. deploy.sh
// resets the host to the repo, so the next deploy would have silently deleted
// voice monitoring - and checks 1-5 could not see it, because they verify rule
// files and mounts, not scrape targets. A rules file that loads perfectly
// against a job nobody is scraping alerts on nothing.
//
// This pin cannot detect a job added on the host and never committed (nothing
// in the repo can). What it CAN do is make deleting one a deliberate act: to
// drop a job you must also drop it here, in a diff a reviewer will see.
const REQUIRED_SCRAPE_JOBS = [
  'prometheus',
  'node_engine01',
  'engine_game_server',
  'turn_relay',
  'alertmanager',
];

/**
 * A foreign metric is only "produced" if something is scraping the exporter
 * that emits it. Check 8 accepts `alertmanager_*` because Alertmanager emits
 * it; that says nothing about whether Prometheus ever asks. On 2026-09-11
 * PagerDeliveryFailing and CriticalEmailDeliveryFailing were written against
 * alertmanager_notifications_failed_total while Alertmanager was configured as
 * an alert DESTINATION and never as a scrape TARGET - two alerts written to
 * catch a silent pager, silent for the same reason as everything else found
 * that day.
 */
const EXPORTER_JOBS = {
  alertmanager_: 'alertmanager',
  node_: 'node_engine01',
  prometheus_: 'prometheus',
  promhttp_: 'prometheus',
};
{
  const jobs = [...prom.matchAll(/^\s*-?\s*job_name:\s*['"]?([\w.-]+)/gm)].map((m) => m[1]);
  for (const job of REQUIRED_SCRAPE_JOBS) {
    if (!jobs.includes(job)) {
      errors.push(
        `prometheus.yml no longer scrapes "${job}". Every alert rule written against that target now evaluates against no data, which reads as healthy. If the job was retired on purpose, remove it from REQUIRED_SCRAPE_JOBS in this file too.`
      );
    }
  }
}

// ── 8. every metric a rule NAMES must have something that emits it ──────────
//
// The failure this catches is silent by construction. Prometheus does not warn
// about an expression whose metric has no samples; it returns an empty vector,
// and an alert with an empty vector is indistinguishable from an alert whose
// condition is false. See this file's header for the three times that has now
// happened here.
//
// "Produced" is deliberately shallow: the name appears in code that runs in
// production. It does not prove the emitter is reachable, scraped, or correct -
// check 7 covers the scrape target and nothing in a repo can prove the rest.
// It proves only that SOMETHING writes the name, which is the single fact whose
// absence made all three incidents possible.
{
  const ruleFiles = onDisk.filter((f) => loadedNames.includes(f));
  const rules = rulesWithMetrics(DIR, ruleFiles);
  const haystack = producerHaystack(root);
  const recorded = recordedNames(DIR, ruleFiles);
  const declaredAbsent = readDeclaredAbsent(DIR);

  const orphans = new Map(); // metric -> rules that name it
  for (const rule of rules) {
    for (const metric of rule.metrics) {
      if (isProduced(metric, haystack, recorded, declaredAbsent)) continue;
      if (!orphans.has(metric)) orphans.set(metric, []);
      orphans.get(metric).push(`${rule.file}:${rule.name}`);
    }
  }

  // A foreign metric whose exporter nobody scrapes is the same empty vector by
  // a different route, and check 8 above waves it through on the prefix alone.
  {
    const jobs = new Set(
      [...prom.matchAll(/^\s*-?\s*job_name:\s*['"]?([\w.-]+)/gm)].map((m) => m[1])
    );
    const seen = new Set();
    for (const rule of rules) {
      for (const metric of rule.metrics) {
        for (const [prefix, job] of Object.entries(EXPORTER_JOBS)) {
          if (!metric.startsWith(prefix) || jobs.has(job) || seen.has(metric)) continue;
          seen.add(metric);
          errors.push(
            `${metric} is referenced by ${rule.file}:${rule.name} and is emitted by the "${job}" exporter, but prometheus.yml has no ${job} scrape job. Nothing asks that exporter for it, so the rule evaluates against an empty vector exactly as if the metric did not exist.`
          );
        }
      }
    }
  }

  for (const [metric, named] of [...orphans].sort()) {
    errors.push(
      `${metric} is referenced by ${named.length} rule(s) (${named.join(', ')}) but nothing in server/src, server/scripts or infra/monitoring emits it. ` +
        `A threshold on a metric with no samples evaluates to an empty vector, which reads exactly like healthy and can never fire. ` +
        `Either add the emitter, or declare it in infra/monitoring/metrics-without-a-producer.txt with the reason.`
    );
  }

}

// ── 9. every metric a DASHBOARD PANEL names must have something that emits it ─
//
// Same failure, quieter. A panel reading a metric with no series draws an empty
// graph forever. Found 2026-09-11: 23 of the 45 panel expressions in
// infra/monitoring/grafana-dashboards read metrics that have never existed -
// two engine panels naming `poker_engine_active_tables` where the engine emits
// `poker_active_tables`, a cron dashboard reading an exporter this stack does
// not run, all seven Postgres panels, and all fourteen SLO panels reading an
// `slo:` recording-rule prefix that was never written (the estate settled on
// `sp:`). Four of those fourteen are error-budget panels, which read as a FULL
// budget rather than as no data.
{
  const dashDir = resolve(DIR, 'grafana-dashboards');
  const dashboards = dashboardsWithMetrics(dashDir);
  const ruleFiles = onDisk.filter((f) => loadedNames.includes(f));
  const haystack = producerHaystack(root);
  const recorded = recordedNames(DIR, ruleFiles);
  const declaredAbsent = readDeclaredAbsent(DIR);

  for (const dash of dashboards) {
    const orphans = dash.metrics.filter((m) => !isProduced(m, haystack, recorded, declaredAbsent));
    if (orphans.length) {
      errors.push(
        `grafana-dashboards/${dash.file} has panel(s) reading ${orphans.join(', ')}, which nothing emits. ` +
          `The panel renders empty forever. Point it at a metric that exists, delete it, or declare it in ` +
          `infra/monitoring/metrics-without-a-producer.txt with the reason.`
      );
    }
  }

  // A declaration that is no longer needed is its own kind of rot: it keeps the
  // door open for the next name that lands under it.
  const named = new Set([
    ...rulesWithMetrics(DIR, ruleFiles).flatMap((r) => r.metrics),
    ...dashboards.flatMap((d) => d.metrics),
  ]);
  for (const [metric] of declaredAbsent) {
    if (!named.has(metric)) {
      errors.push(
        `infra/monitoring/metrics-without-a-producer.txt declares ${metric}, but no rule or dashboard panel references it any more. Remove the line.`
      );
    }
  }
}

if (errors.length) {
  console.error('\nFAIL: monitoring wiring is broken.\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `OK: ${explicit.length} rule file(s) loaded, mounted at matching paths, non-empty; every metric they and the dashboards name has a producer; alerts route to a receiver that delivers`
);
