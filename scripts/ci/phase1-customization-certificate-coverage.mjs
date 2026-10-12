#!/usr/bin/env node
// The Phase 1 cutover is about three customization journeys, not every page
// that happens to share the long production browser job. Keep the broader job
// red and visible when another route fails, while making this receipt depend
// on exact, first-attempt evidence from every affected customization surface.
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const contracts = [
  {
    report: 'customization-realtime.json',
    file: 'production-customization-realtime.spec.ts',
    title:
      'every free cosmetic applies, persists, syncs to another device, and stays isolated from another player',
  },
  {
    report: 'gameplay-customization-runtime.json',
    file: 'gameplay-customization-runtime.spec.ts',
    title: 'mobile table art, cards and avatar styles repaint now, persist, and reconcile live',
  },
  {
    report: 'customization-commerce.json',
    file: 'production-customization-commerce.spec.ts',
    title: 'every sellable design charges once, unlocks live, persists, and remains account-scoped',
  },
];

function allSpecs(report) {
  const specs = [];
  const visit = (suite) => {
    if (!suite || typeof suite !== 'object') throw new Error('unreadable suite');
    if (suite.specs !== undefined && !Array.isArray(suite.specs))
      throw new Error('unreadable specs');
    if (suite.suites !== undefined && !Array.isArray(suite.suites))
      throw new Error('unreadable suites');
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  };
  if (!Array.isArray(report?.suites)) throw new Error('missing suites');
  for (const suite of report.suites) visit(suite);
  return specs;
}

export function inspectPhase1CustomizationReports(paths) {
  const missing = [];
  if (!Array.isArray(paths) || paths.length !== contracts.length) {
    return {
      complete: false,
      missing: [`expected ${contracts.length} reports and received ${paths?.length ?? 0}`],
    };
  }

  for (let index = 0; index < contracts.length; index += 1) {
    const contract = contracts[index];
    const path = paths[index];
    if (basename(path) !== contract.report) {
      missing.push(`${contract.report} was replaced by ${basename(path) || 'an unnamed report'}`);
      continue;
    }
    try {
      const report = JSON.parse(readFileSync(path, 'utf8'));
      const specs = allSpecs(report);
      const exact =
        !Object.hasOwn(report, 'notRunReason') &&
        Array.isArray(report.errors) &&
        report.errors.length === 0 &&
        report.stats?.expected === 1 &&
        report.stats?.skipped === 0 &&
        report.stats?.unexpected === 0 &&
        report.stats?.flaky === 0 &&
        specs.length === 1 &&
        specs[0]?.file === contract.file &&
        specs[0]?.title === contract.title &&
        specs[0]?.ok === true &&
        Array.isArray(specs[0]?.tests) &&
        specs[0].tests.length === 1 &&
        specs[0].tests[0]?.projectName === 'chromium' &&
        specs[0].tests[0]?.expectedStatus === 'passed' &&
        specs[0].tests[0]?.status === 'expected' &&
        Array.isArray(specs[0].tests[0]?.results) &&
        specs[0].tests[0].results.length === 1 &&
        specs[0].tests[0].results[0]?.status === 'passed' &&
        specs[0].tests[0].results[0]?.retry === 0;
      if (!exact)
        missing.push(`${contract.report} did not contain its one exact first-attempt pass`);
    } catch {
      missing.push(`${contract.report} is missing or unreadable`);
    }
  }
  return { complete: missing.length === 0, missing };
}

function main() {
  const result = inspectPhase1CustomizationReports(process.argv.slice(2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `complete=${result.complete}\n`);
  }
  const message = result.complete
    ? 'All three required Phase 1 customization journeys passed exactly once on their first attempt.'
    : `NON-VERDICT: Phase 1 customization coverage is incomplete: ${result.missing.join('; ')}.`;
  console.log(JSON.stringify(result));
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
