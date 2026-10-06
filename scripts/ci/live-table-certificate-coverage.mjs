#!/usr/bin/env node
// Release certification requires every named subject, not merely one executed
// test in the shared spec file. Missing natural subjects remain non-verdicts.
import { appendFileSync, readFileSync } from 'node:fs';

const required = [
  ...['MTT', 'SPIN', 'SNG'].map(
    (format) => `an already-running ${format} table stays realtime and recovers one owner`
  ),
  'an already-running table stays live and recovers one owner after a network loss',
];
const file = 'production-live-table-realtime.spec.ts';
const project = 'webkit-live-table-realtime';

function coverage(report) {
  const specs = [];
  function visit(suite) {
    if (!suite || typeof suite !== 'object') throw new Error('unreadable suite');
    if (suite.specs !== undefined && !Array.isArray(suite.specs))
      throw new Error('unreadable specs');
    if (suite.suites !== undefined && !Array.isArray(suite.suites))
      throw new Error('unreadable suites');
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  if (!Array.isArray(report?.suites)) throw new Error('missing suites');
  visit(report);
  const missing = required.filter((title) => {
    const matches = specs.filter(
      (spec) => spec?.title === title && [file, `tests/e2e/${file}`].includes(spec.file)
    );
    if (matches.length !== 1) return true;
    const spec = matches[0];
    const tests = spec.tests;
    if (spec.ok !== true || !Array.isArray(tests) || tests.length !== 1) return true;
    const test = tests[0];
    return !(
      test.projectName === project &&
      test.expectedStatus === 'passed' &&
      test.status === 'expected' &&
      Array.isArray(test.results) &&
      test.results.length === 1 &&
      test.results[0]?.status === 'passed'
    );
  });
  if (report.notRunReason || !Array.isArray(report.errors) || report.errors.length !== 0) {
    missing.push('report has no trustworthy error-free completion');
  }
  return { complete: missing.length === 0, missing };
}

let result;
try {
  result = coverage(JSON.parse(readFileSync(process.argv[2], 'utf8')));
} catch {
  result = { complete: false, missing: ['report is missing or unreadable'] };
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `complete=${result.complete}\n`);
}
const message = result.complete
  ? 'All four required live-table cases passed in mobile WebKit.'
  : `NON-VERDICT: required live-table coverage is incomplete: ${result.missing.join('; ')}.`;
console.log(JSON.stringify(result));
console.log(message);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
