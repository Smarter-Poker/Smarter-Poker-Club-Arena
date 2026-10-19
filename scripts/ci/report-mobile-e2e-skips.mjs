#!/usr/bin/env node
/** Retain named skip evidence for Cashier, club lobby, first-run iPhone and mobile sweep checks only. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const MOBILE_FILE =
  /^(?:(?:production-)?mobile-.*|.*-mobile|footer-route|header-portrait-frame)\.spec\.ts$/;

export function skipsIn(report, reportName) {
  if (!Array.isArray(report.suites)) throw new Error(`${reportName}: no Playwright suites`);
  const wholeReport = ['cashier.json', 'lobby.json', 'first-run-iphone.json'].includes(
    basename(reportName)
  );
  const skips = [];
  const walk = (suite, parents) => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file ?? '';
      if (!wholeReport && !MOBILE_FILE.test(basename(file))) continue;
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        if (last?.status !== 'skipped') continue;
        const reasons = (test.annotations ?? [])
          .filter((entry) => ['skip', 'fixme'].includes(entry.type))
          .map((entry) => entry.description)
          .filter((value) => typeof value === 'string' && value.trim().length > 0);
        skips.push({
          report: reportName,
          file,
          line: spec.line ?? 0,
          project: test.projectName ?? '',
          title: [...parents, spec.title].filter(Boolean).join(' > '),
          reasons,
          reasonProvided: reasons.length > 0,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...parents, child.title]);
  };
  for (const suite of report.suites) walk(suite, [suite.title]);
  return skips;
}

export function collect(paths, read = (path) => JSON.parse(readFileSync(path, 'utf8'))) {
  const skips = [];
  const unavailable = [];
  for (const path of paths) {
    try {
      const report = read(path);
      if (report.notRunReason) {
        unavailable.push({ report: path, reason: report.notRunReason });
      } else {
        skips.push(...skipsIn(report, path));
      }
    } catch (error) {
      unavailable.push({ report: path, reason: error.message });
    }
  }
  return {
    schemaVersion: 1,
    scope: 'cashier, club lobby, first-run iPhone, and mobile sweep checks',
    skips,
    unavailable,
    complete: unavailable.length === 0 && skips.every((skip) => skip.reasonProvided),
  };
}

export function summary(evidence) {
  const lines = [
    '### Mobile check skip evidence',
    '',
    `${evidence.skips.length} skipped test(s). Reporting ${evidence.complete ? 'complete' : 'INCOMPLETE'}.`,
    '',
  ];
  for (const skip of evidence.skips) {
    // Indented JSON preserves exact text without interpreting Markdown or workflow commands.
    lines.push(`    ${JSON.stringify(skip)}`, '');
  }
  for (const unavailable of evidence.unavailable) {
    lines.push(`    ${JSON.stringify({ unavailable })}`, '');
  }
  if (evidence.skips.some((skip) => !skip.reasonProvided)) {
    lines.push(
      'A named skipped test omitted its reason. Supply an explicit skip/fixme description; no reason was invented.',
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

export function main(args, env = process.env) {
  const [output, ...paths] = args;
  if (!output || paths.length === 0)
    throw new Error('Usage: report-mobile-e2e-skips.mjs OUTPUT_JSON REPORT_JSON...');
  const evidence = collect(paths);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const skip of evidence.skips) console.log(`MOBILE_TEST_SKIPPED ${JSON.stringify(skip)}`);
  for (const unavailable of evidence.unavailable)
    console.log(`MOBILE_SKIP_REPORT_UNAVAILABLE ${JSON.stringify(unavailable)}`);
  const markdown = summary(evidence);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  console.log(
    `${evidence.skips.length} named mobile/lobby/Cashier skip(s); reporting ${evidence.complete ? 'complete' : 'INCOMPLETE'}.`
  );
  return evidence.complete ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
