#!/usr/bin/env node
/**
 * annotate-e2e-failures.mjs: name each failed production test where the API can read it.
 *
 * WHY THIS EXISTS (2026-10-04, CLAUDE.md 10.83 and 10.86 rule 3)
 *
 * When `Post-Deploy E2E (production)` went red, all it said through the
 * check-run API was "Process completed with exit code 1". The failing test, its
 * file and line, and the Playwright error existed in only two places: the job
 * log and the uploaded report. Both are served from blob storage, and a session
 * that can read the API cannot always reach that. So a red run on the money
 * surface told such a session that something failed, and nothing about what.
 *
 * This reads the Playwright JSON reports the job already writes and prints one
 * `::error` workflow command per failed or timed-out test. GitHub keeps those as
 * check-run annotations, which `gh api <check_run_url>/annotations` returns.
 * GitHub keeps 10 error annotations per step, so the first 9 failures are named
 * one each and the 10th says how many more there are. A report that is missing
 * or unreadable is named too, so silence here never means "nothing failed".
 *
 * It only reports. It never changes a verdict and always exits 0; the steps that
 * ran the specs already own the red.
 *
 * Usage: node scripts/ci/annotate-e2e-failures.mjs report-a.json [report-b.json ...]
 */

import { readFileSync, existsSync } from 'node:fs';

const MAX_NAMED = 9;
const MESSAGE_CHARS = 700;

/** Workflow commands end at a newline and treat %, \r and \n specially. */
export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
export function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** Strip ANSI colour codes that Playwright puts in its error messages. */
export function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

/** Every failed or timed-out test in one Playwright JSON report. */
export function failuresIn(report, reportName) {
  const out = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1];
        if (!last || !['failed', 'timedOut', 'interrupted'].includes(last.status)) continue;
        const error = last.error ?? (last.errors ?? [])[0] ?? {};
        out.push({
          report: reportName,
          file: spec.file ?? suite.file ?? '',
          line: spec.line ?? 0,
          title: [...titles, spec.title].filter(Boolean).join(' > '),
          project: test.projectName ?? '',
          status: last.status,
          message: plain(error.message ?? error.value ?? '').trim(),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return out;
}

function main(paths) {
  const failures = [];
  const unreadable = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      unreadable.push(`${path} (no report: the suite did not run)`);
      continue;
    }
    try {
      failures.push(...failuresIn(JSON.parse(readFileSync(path, 'utf8')), path));
    } catch (error) {
      unreadable.push(`${path} (${error.message})`);
    }
  }
  const lines = failures.slice(0, MAX_NAMED).map((f) => {
    const file = f.file ? `tests/e2e/${f.file}` : f.report;
    const title = `${f.status}: ${f.title}${f.project ? ` [${f.project}]` : ''}`.slice(0, 250);
    const message = (f.message || 'no error message in the report').slice(0, MESSAGE_CHARS);
    return `::error file=${escapeProperty(file)},line=${Number(f.line) || 1},title=${escapeProperty(title)}::${escapeData(`${f.report}: ${message}`)}`;
  });
  const rest = failures.length - Math.min(failures.length, MAX_NAMED);
  const tail = [];
  if (rest > 0) tail.push(`${rest} more failed test(s) are only in the uploaded report.`);
  if (unreadable.length) tail.push(`Reports missing or unreadable: ${unreadable.join('; ')}`);
  if (tail.length) lines.push(`::error title=More E2E evidence::${escapeData(tail.join(' '))}`);
  if (!lines.length) console.log('No failed test in any report.');
  for (const line of lines) console.log(line);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
