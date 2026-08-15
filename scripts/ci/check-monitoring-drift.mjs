#!/usr/bin/env node
/**
 * check-monitoring-drift.mjs
 *
 * BLOCKING CI GUARD — monitoring config must not drift from what is running.
 *
 * Why
 * ───
 * On 2026-08-15 five of the seven files in infra/monitoring/ had drifted from
 * the live stack on the Hetzner box, several by hundreds of lines. The repo
 * still held the PRE-FIX versions: the ones where 27 alert rules referenced
 * metrics that do not exist and Alertmanager routed every alert to
 * null-receiver. Rebuilding the host from this repo would have quietly
 * restored decorative monitoring — and nobody would have noticed until the
 * next freeze went unreported.
 *
 * This check cannot reach the production host from CI, so it does not try to
 * diff against it. Instead it enforces the structural invariants that made the
 * drift dangerous, all of which are checkable from the repo alone:
 *
 *   1. Every *-rules.yml / *-alerts.yml file in infra/monitoring is listed in
 *      prometheus.yml rule_files. A rules file that exists but is never loaded
 *      is the most common way an alert silently stops existing.
 *   2. Every rule_files entry has a corresponding file on disk. A dangling
 *      entry makes Prometheus refuse to start — an outage in the thing that
 *      detects outages.
 *   3. Every file referenced by rule_files is mounted into the Prometheus
 *      container by docker-compose.yml. This is the failure that is invisible
 *      locally and fatal in production: the path is valid in the repo and
 *      missing inside the container.
 *   4. Alertmanager's default route must not be a null/blackhole receiver.
 *
 * Deliberately NOT checked: rule contents. This guards the wiring, which is
 * what silently breaks.
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

// ── rule_files block ─────────────────────────────────────────────────────────
// Parsed line-by-line rather than with one regex: comment lines inside the
// block contain hyphens (dates, prose) and a naive `-\s*(\S+)` happily reads
// "2026-08-15" as a filename.
const loaded = [];
{
  const lines = prom.split('\n');
  const start = lines.findIndex((l) => /^\s*rule_files:\s*$/.test(l));
  if (start === -1) {
    errors.push('prometheus.yml has no rule_files: block — no alert rules are loaded at all.');
  } else {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*$/.test(line)) continue;              // blank — keep scanning
      if (/^\s*#/.test(line)) continue;              // comment — skip
      const item = /^\s+-\s*(\S+)\s*$/.exec(line); // "  - /etc/prometheus/x.yml"
      if (!item) break;                              // dedent: block is over
      loaded.push(basename(item[1]));
    }
  }
}

// ── 1. every rules file on disk is loaded ────────────────────────────────────
const onDisk = readdirSync(DIR).filter(
  (f) =>
    /(-rules|-alerts)\.ya?ml$/.test(f) &&
    // QUARANTINED files are intentionally parked, not loaded.
    !f.includes('QUARANTINED')
);
for (const f of onDisk) {
  if (!loaded.includes(f)) {
    errors.push(
      `infra/monitoring/${f} exists but is NOT in prometheus.yml rule_files — ` +
        `its alerts do not exist in production.`
    );
  }
}

// ── 2. every loaded file exists ──────────────────────────────────────────────
for (const f of loaded) {
  if (!existsSync(resolve(DIR, f))) {
    errors.push(
      `prometheus.yml rule_files references ${f}, which is not in infra/monitoring/ — ` +
        `Prometheus will refuse to start.`
    );
  }
}

// ── 3. every loaded file is mounted into the container ───────────────────────
for (const f of loaded) {
  if (!compose.includes(`/${f}:`)) {
    errors.push(
      `${f} is loaded by prometheus.yml but never mounted in docker-compose.yml — ` +
        `valid in the repo, missing inside the container.`
    );
  }
}

// ── 4. alerts must actually go somewhere ─────────────────────────────────────
if (existsSync(resolve(DIR, 'alertmanager.yml'))) {
  const am = read('alertmanager.yml');
  const defaultReceiver = /route:\s*[\s\S]*?receiver:\s*['"]?([\w.-]+)/.exec(am);
  if (!defaultReceiver) {
    errors.push('alertmanager.yml has no default route receiver.');
  } else if (/null|blackhole|devnull|noop/i.test(defaultReceiver[1])) {
    errors.push(
      `alertmanager.yml default route sends everything to '${defaultReceiver[1]}' — ` +
        `alerts fire into a void. This is the exact state the stack was found in ` +
        `on 2026-08-15.`
    );
  }
}

if (errors.length) {
  console.error('\nFAIL: monitoring wiring is broken.\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `OK: ${loaded.length} rule file(s) loaded, mounted, and present; alerts route to a real receiver`
);
