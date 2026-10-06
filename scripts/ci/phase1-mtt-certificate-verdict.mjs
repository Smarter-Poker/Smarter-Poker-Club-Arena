#!/usr/bin/env node
/**
 * The live-table spec contains MTT, Spin, SNG and cash cases. Its general
 * honesty gate correctly accepts the file when any case executes, because an
 * absent natural production subject is not a product failure. Phase 1 has a
 * narrower cutover rule: its MTT-only Final Table transition cannot be sealed
 * unless the exact MTT case itself executed and passed.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PHASE1_MTT_CASE_TITLE =
  'an already-running MTT table stays realtime and recovers one owner';

function collectSpecs(suite, out) {
  for (const spec of suite.specs ?? []) out.push(spec);
  for (const child of suite.suites ?? []) collectSpecs(child, out);
}

function annotationDetail(test, result) {
  const descriptions = [...(test.annotations ?? []), ...(result?.annotations ?? [])]
    .map((annotation) => annotation?.description)
    .filter(Boolean);
  return descriptions.join(' | ') || 'no reason recorded';
}

/**
 * @returns {{certified: boolean, kind: 'certified'|'non-verdict'|'failed', detail: string}}
 */
export function phase1MttCertificateVerdict(report) {
  const specs = [];
  for (const suite of report?.suites ?? []) collectSpecs(suite, specs);
  const matches = specs.filter(
    (spec) =>
      spec.title === PHASE1_MTT_CASE_TITLE &&
      String(spec.file ?? '').endsWith('production-live-table-realtime.spec.ts')
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one Phase 1 MTT case named "${PHASE1_MTT_CASE_TITLE}", found ${matches.length}.`
    );
  }
  const tests = matches[0].tests ?? [];
  if (tests.length !== 1) {
    throw new Error(
      `Expected one Playwright result for the Phase 1 MTT case, found ${tests.length}.`
    );
  }
  const test = tests[0];
  const results = test.results ?? [];
  const result = results.at(-1);
  if (!result) throw new Error('The Phase 1 MTT case has no Playwright result.');
  if (result.status === 'passed') {
    return {
      certified: true,
      kind: 'certified',
      detail: 'The required Phase 1 MTT case executed and passed.',
    };
  }
  if (result.status === 'skipped') {
    return {
      certified: false,
      kind: 'non-verdict',
      detail: annotationDetail(test, result),
    };
  }
  return {
    certified: false,
    kind: 'failed',
    detail: `The required Phase 1 MTT case ended with status ${String(result.status)}.`,
  };
}

function appendOutput(certified) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `certified=${certified ? 'true' : 'false'}\n`);
}

function appendSummary(verdict) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const heading = verdict.certified
    ? '### Phase 1 MTT subject certified'
    : '### Phase 1 MTT subject not certified';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${heading}\n\n${verdict.detail}\n`);
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('usage: phase1-mtt-certificate-verdict.mjs <playwright-report.json>');
    return 2;
  }
  try {
    const report = JSON.parse(readFileSync(argv[0], 'utf8'));
    const verdict = phase1MttCertificateVerdict(report);
    appendOutput(verdict.certified);
    appendSummary(verdict);
    if (verdict.certified) {
      console.log(verdict.detail);
      return 0;
    }
    if (verdict.kind === 'non-verdict') {
      console.warn(`NON-VERDICT: ${verdict.detail}`);
      return 0;
    }
    console.error(verdict.detail);
    return 1;
  } catch (error) {
    appendOutput(false);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
