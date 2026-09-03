#!/usr/bin/env node
/**
 * assert-e2e-actually-ran.mjs — the post-deploy suite must not pass by not running.
 *
 * WHY THIS EXISTS (Phase 6, 2026-08-31)
 *
 * `post-deploy-e2e.yml` was built to end "a guard with nowhere to run becomes a
 * comment". It succeeded at giving the specs a job. It did not close the next
 * door: a run in which every spec SKIPS is a green run.
 *
 * Playwright exits 0 when nothing executed. `tests/e2e/global-setup.ts`
 * deliberately falls back to a signed-out session when a login fails, and its
 * own header says that costs "47 skips" — 47 specs that then report nothing,
 * inside a job that reports success. Measured over the last 40 invocations of
 * this workflow: 29 skipped at the job level, 6 cancelled, 4 failed. The green
 * runs were not evidence that production is healthy. They were evidence that
 * nobody looked.
 *
 * So this reads Playwright's own JSON report and refuses to let a run claim a
 * verdict it did not reach.
 *
 * THE RULE
 *
 *   Every spec FILE handed to Playwright must contribute at least one test that
 *   actually executed (passed, failed or flaky). A file where every test skipped
 *   is a file that verified nothing, and it must be named.
 *
 * A file is exempt only if it is listed in e2e-may-skip-entirely.json WITH a
 * reason. NOTE the spelling: Playwright's JSON reports `file` RELATIVE TO
 * testDir (`smoke.spec.ts`, `routes/clubs.spec.ts`), not from the repo root.
 * An entry written as `tests/e2e/smoke.spec.ts` matches nothing and exempts
 * nothing - verified against a real report, not assumed. That list is a ratchet, not an escape hatch: adding a line is a
 * visible, reviewable admission that one more spec cannot verify production.
 *
 * WHY PER-FILE AND NOT A RATIO. A ratio hides the shape. "88% executed" is the
 * same number whether twelve files each skipped one variant, or one whole money
 * surface skipped end to end. The second is the one that matters.
 *
 * A MISSING REPORT IS A FAILURE, NOT AN ABSENCE. If a Playwright invocation
 * produced no JSON at all it did not run — that is the exact condition this
 * script exists to catch, so it is never treated as "nothing to check".
 *
 * A report containing only `notRunReason` is explicit evidence that a release
 * contract was not exercised. It is named and failed just like a missing
 * report; deploy lag is not permission to publish without certification.
 *
 * Usage:
 *   node scripts/ci/assert-e2e-actually-ran.mjs report-a.json [report-b.json ...]
 *
 * Exit 0 = every non-exempt spec file executed something.
 * Exit 1 = at least one file verified nothing, or a report is missing/unreadable.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const ALLOWLIST_PATH = resolve(
  new URL('.', import.meta.url).pathname,
  'e2e-may-skip-entirely.json'
);

const reportPaths = process.argv.slice(2);
if (reportPaths.length === 0) {
  console.error('usage: assert-e2e-actually-ran.mjs <playwright-report.json> [...]');
  process.exit(2);
}

/** @type {{allowed: {file: string, reason: string}[]}} */
const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const exempt = new Map(allowlist.allowed.map((e) => [e.file, e.reason]));

/**
 * Playwright's JSON report nests suites arbitrarily deep. Every `spec` carries
 * the file it came from, and every `test` inside it carries `results[]` plus a
 * computed `status` which is 'skipped' when it never ran.
 */
function collect(suite, out) {
  for (const spec of suite.specs ?? []) {
    const file = spec.file ?? suite.file ?? '(unknown)';
    for (const t of spec.tests ?? []) {
      const results = t.results ?? [];
      const ran = results.some((r) => r.status && r.status !== 'skipped');
      const bucket = out.get(file) ?? {
        executed: 0,
        skipped: 0,
        failed: 0,
        flaky: 0,
        reasons: new Set(),
      };
      if (ran) {
        bucket.executed += 1;
        // Judge the LAST result, not any result. A test that failed once and
        // passed on retry is flaky, and calling it "failed" in a report whose
        // whole subject is honesty would be its own small lie.
        const last = results[results.length - 1];
        if (last && (last.status === 'failed' || last.status === 'timedOut')) bucket.failed += 1;
        else if (results.some((r) => r.status === 'failed' || r.status === 'timedOut'))
          bucket.flaky += 1;
      } else {
        bucket.skipped += 1;
        for (const r of results) {
          for (const a of r.annotations ?? []) {
            if (a.description) bucket.reasons.add(a.description);
          }
        }
        for (const a of t.annotations ?? []) {
          if (a.description) bucket.reasons.add(a.description);
        }
      }
      out.set(file, bucket);
    }
  }
  for (const child of suite.suites ?? []) collect(child, out);
}

/** @type {Map<string, {executed:number, skipped:number, failed:number, reasons:Set<string>}>} */
const byFile = new Map();
const missing = [];
/** Invocations the workflow deliberately declined, with a stated reason. */
const declined = [];

for (const p of reportPaths) {
  if (!existsSync(p)) {
    missing.push(p);
    continue;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    missing.push(`${p} (unreadable: ${err.message})`);
    continue;
  }
  if (report.notRunReason) {
    declined.push({ path: p, reason: String(report.notRunReason) });
    continue;
  }
  for (const suite of report.suites ?? []) collect(suite, byFile);
}

const rows = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
const silent = rows.filter(([file, s]) => s.executed === 0 && !exempt.has(file));
const exemptSilent = rows.filter(([file, s]) => s.executed === 0 && exempt.has(file));

const totals = rows.reduce(
  (acc, [, s]) => ({
    executed: acc.executed + s.executed,
    skipped: acc.skipped + s.skipped,
    failed: acc.failed + s.failed,
    flaky: acc.flaky + s.flaky,
  }),
  { executed: 0, skipped: 0, failed: 0, flaky: 0 }
);

const lines = [];
lines.push('### Did the post-deploy suite actually verify production?');
lines.push('');
lines.push(`| Executed | Skipped | Failed | Flaky | Spec files |`);
lines.push(`| --- | --- | --- | --- | --- |`);
lines.push(
  `| ${totals.executed} | ${totals.skipped} | ${totals.failed} | ${totals.flaky} | ${rows.length} |`
);
lines.push('');

if (rows.length) {
  lines.push('<details><summary>Per spec file</summary>');
  lines.push('');
  lines.push('| Spec file | Executed | Skipped |');
  lines.push('| --- | --- | --- |');
  for (const [file, s] of rows) {
    const mark = s.executed === 0 ? (exempt.has(file) ? ' (allowed to skip)' : ' **VERIFIED NOTHING**') : '';
    lines.push(`| \`${file}\`${mark} | ${s.executed} | ${s.skipped} |`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

let failed = false;

if (missing.length) {
  failed = true;
  lines.push('**A Playwright invocation produced no report.** It did not run.');
  lines.push('');
  for (const m of missing) lines.push(`- \`${m}\``);
  lines.push('');
}

if (declined.length) {
  failed = true;
  lines.push('**Not invoked, so no production verdict exists:**');
  lines.push('');
  for (const d of declined) lines.push(`- \`${d.path}\` — ${d.reason}`);
  lines.push('');
}

if (rows.length === 0 && missing.length === 0) {
  // Declining EVERY invocation is not a partial absence, it is a run that
  // verified nothing while stating reasons for it. Reasons are not a verdict.
  failed = true;
  lines.push(
    declined.length
      ? '**Every invocation was declined.** Reasons were given for each, but nothing was verified.'
      : '**The report contains no specs at all.** Nothing was verified.'
  );
  lines.push('');
}

if (silent.length) {
  failed = true;
  lines.push('**These spec files skipped every test they contain, so they verified nothing:**');
  lines.push('');
  for (const [file, s] of silent) {
    const why = [...s.reasons].slice(0, 3).join(' | ') || 'no reason recorded';
    lines.push(`- \`${file}\` — ${s.skipped} skipped — ${why}`);
  }
  lines.push('');
  lines.push(
    'Either give them what they need to run (usually a session, or a live fixture), ' +
      'or add each one to `scripts/ci/e2e-may-skip-entirely.json` with a reason. ' +
      'A run that skips everything must not report success.'
  );
  lines.push('');
}

if (exemptSilent.length) {
  lines.push('<details><summary>Skipped entirely, allowed</summary>');
  lines.push('');
  for (const [file] of exemptSilent) lines.push(`- \`${file}\` — ${exempt.get(file)}`);
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

if (!failed) {
  lines.push(
    `Every spec file that ran executed at least one test against production ` +
      `(${totals.executed} executed across ${rows.length} file(s)).`
  );
}

const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}\n`);
  } catch {
    /* summary is a nicety; the exit code is the verdict */
  }
}

process.exit(failed ? 1 : 0);
