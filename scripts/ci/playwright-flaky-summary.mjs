#!/usr/bin/env node
/**
 * A RETRIED PASS IS SAID OUT LOUD (2026-09-26).
 *
 * The Diamond playfield suite runs the real WebGL scenes on software
 * rendering, where a timing flake is possible. It now gets one retry, so a
 * flake does not block a merge for nothing. That retry must not HIDE anything:
 * a case that failed once and then passed is Playwright's `flaky` status, and
 * this script names every such case as a warning annotation and in the job
 * summary, so it is seen on the pull request instead of folded into "passed".
 *
 * It reads the JSON report of that one invocation. Outcomes:
 *   exit 0  report read; flaky and failed cases (if any) listed
 *   exit 1  the suite step reported success but left no readable report -
 *           a pass nobody can inspect is not a pass (CLAUDE.md 10.86)
 *   exit 0  with a notice, when the suite step itself failed before this
 *           invocation wrote a report: the job is already red for that reason
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every test in a Playwright JSON report, with its file, title and status. */
export function collectTests(report) {
  const out = [];
  const walk = (suite, trail) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        out.push({
          file: spec.file ?? suite.file ?? '',
          line: spec.line ?? 0,
          title: [...trail, spec.title].filter(Boolean).join(' > '),
          project: test.projectName ?? '',
          status: test.status ?? 'unknown',
          attempts: (test.results ?? []).length,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...trail, child.title]);
  };
  for (const suite of report?.suites ?? []) walk(suite, []);
  return out;
}

export function summarize(report, label) {
  const tests = collectTests(report);
  if (tests.length === 0) throw new Error('the report lists no tests');
  const count = (status) => tests.filter((t) => t.status === status).length;
  const flaky = tests.filter((t) => t.status === 'flaky');
  const failed = tests.filter((t) => t.status === 'unexpected');
  const name = (t) => `${t.file}:${t.line} ${t.title}${t.project ? ` [${t.project}]` : ''}`;
  const annotations = flaky.map(
    (t) =>
      `::warning title=FLAKY (passed only on retry)::${name(t)} failed on its first attempt and passed on attempt ${t.attempts}.`
  );
  const summary = [
    `## ${label}`,
    '',
    `| Passed first time | Flaky (passed only on retry) | Failed | Skipped |`,
    `| --- | --- | --- | --- |`,
    `| ${count('expected')} | ${flaky.length} | ${failed.length} | ${count('skipped')} |`,
    '',
    ...(flaky.length
      ? [
          '**Flaky cases.** Each failed once and passed on retry; it did not block this merge, and it is listed so it is not forgotten:',
          '',
          ...flaky.map((t) => `- ${name(t)}`),
          '',
        ]
      : ['No case needed a retry.', '']),
    ...(failed.length ? ['**Failed cases:**', '', ...failed.map((t) => `- ${name(t)}`), ''] : []),
  ];
  return { flaky, failed, annotations, summary: summary.join('\n') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reportPath = process.env.PLAYFIELD_REPORT ?? '';
  const outcome = process.env.SUITE_OUTCOME ?? '';
  const label = process.env.SUITE_LABEL ?? 'Diamond playfield (software WebGL, one retry)';
  const write = (text) => {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    else console.log(text);
  };
  let report;
  try {
    if (!reportPath || !existsSync(reportPath))
      throw new Error(`no report at ${reportPath || '(unset)'}`);
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    if (outcome === 'failure') {
      console.log(
        `::notice title=PLAYFIELD NOT REACHED::The suite step failed before the Diamond playfield invocation wrote its report (${error.message}). The failure above is the verdict.`
      );
      write(`## ${label}\n\nNot reached: an earlier suite in the same step failed first.`);
      process.exit(0);
    }
    console.log(
      `::error title=PLAYFIELD REPORT MISSING::The suite step reported ${outcome || 'an unknown outcome'} but left no readable report (${error.message}). A pass nobody can inspect is not a pass.`
    );
    process.exit(1);
  }
  const result = summarize(report, label);
  for (const line of result.annotations) console.log(line);
  write(result.summary);
  console.log(
    `${label}: ${result.flaky.length} flaky, ${result.failed.length} failed (see the job summary).`
  );
}
