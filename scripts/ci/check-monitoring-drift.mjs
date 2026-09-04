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
 * Deliberately NOT checked: rule expressions. This guards the wiring.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

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

// ── 4b. and every GROUP inside them must contain rules ──────────────────────
//
// Check 4 validates whole FILES. alert-rules.yml passed it for months while
// three of its eight groups - cron-health, postgres-health, vercel-health -
// contained no rules at all, because the file as a whole had plenty. An empty
// group is worse than a missing one: it reads as coverage, and the estate had
// been treating "there is a cron-health group" as meaning cron was watched.
// Found 2026-09-04, the same day four Open Claw jobs turned out to have been
// silent for up to eighteen days.
for (const p of explicit) {
  const f = basename(p);
  if (!existsSync(resolve(DIR, f))) continue;
  const body = read(f);
  if (/DISABLED|INTENTIONALLY EMPTY/i.test(body.split('\n').slice(0, 12).join('\n'))) continue;

  const lines = body.split('\n');
  let current = null;
  let sawRule = false;
  const empty = [];
  const finish = () => {
    if (current && !sawRule) empty.push(current);
  };
  for (const line of lines) {
    const g = line.match(/^\s*-\s*name:\s*(\S+)/);
    if (g) {
      finish();
      current = g[1];
      sawRule = false;
      continue;
    }
    if (/^\s*-\s*(alert|record):\s*\S/.test(line)) sawRule = true;
  }
  finish();

  for (const g of empty) {
    errors.push(
      `${f} declares group "${g}" with no alert: or record: rules in it. A named group that alerts on nothing reads as coverage - delete the heading, or give it rules. (alert-rules.yml carried three of these until 2026-09-04.)`
    );
  }
}

// ── 4c. exactly one monitoring config tree ──────────────────────────────────
//
// infra/monitoring/engine-01/ held a second prometheus.yml, docker-compose.yml,
// alertmanager.yml, Caddyfile and slo-*.yml. deploy.sh symlinks only the
// top-level files, so that copy was deployed by nothing - and it had drifted
// four rule files behind the parent (missing all 10 supervisor, 6 tournament
// and 10 spin rules) while this very check read only the top-level pair.
//
// An unreferenced second copy of a config is the CLAUDE.md 10.7 failure mode:
// the next agent finds it, believes it is live, and "fixes" the real one to
// match. Deleted 2026-09-04; this stops it coming back.
{
  const stray = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.ya?ml$/.test(e.name) && dir !== DIR) {
        // Detect by CONTENT, not by name. grafana-provisioning/datasources/
        // legitimately contains a prometheus.yml - it is a Grafana datasource
        // definition, is deployed by deploy.sh, and is not a second server
        // config. Only a file that actually configures Prometheus,
        // Alertmanager or the compose stack counts.
        const body = readFileSync(full, 'utf8');
        const isServerConfig =
          /^\s*scrape_configs:/m.test(body) ||
          /^\s*rule_files:/m.test(body) ||
          /^\s*route:\s*$/m.test(body) && /^\s*receivers:/m.test(body) ||
          /^\s*services:\s*$/m.test(body) && /prometheus|alertmanager|grafana/.test(body);
        if (isServerConfig) stray.push(full.slice(full.indexOf('infra/monitoring')));
      }
    }
  };
  walk(DIR);
  for (const f of stray) {
    errors.push(
      `${f} is a second copy of a monitoring config. deploy.sh only ever deploys the files directly in infra/monitoring/, so a nested copy is deployed by nothing and drifts silently - which is exactly what infra/monitoring/engine-01/ did until 2026-09-04. Fold it into the parent and delete it.`
    );
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

// ── 6. Every scrape job that ever existed still exists ──────────────────────
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
];
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

if (errors.length) {
  console.error('\nFAIL: monitoring wiring is broken.\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `OK: ${explicit.length} rule file(s) loaded, mounted at matching paths, non-empty; alerts route to a receiver that delivers`
);
