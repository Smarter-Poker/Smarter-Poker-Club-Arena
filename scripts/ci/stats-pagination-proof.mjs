#!/usr/bin/env node
// A closed, one-case production proof. No caller-selected code, route or test inputs.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readBuildInfoSha } from './production-e2e-provenance.mjs';

export const STATS_PAGINATION_TITLE =
  'published downline pagination survives the initial debounce and resets only for changed search';
const SHA = /^[0-9a-f]{40}$/;
const origins = [
  'https://smarter.poker/hub/club-arena/build-info.json',
  'https://ca-static.smarter.poker/build-info.json',
];

export function admitStatsPaginationProof(payload, environment = process.env) {
  if (
    environment.GITHUB_EVENT_NAME !== 'repository_dispatch' ||
    environment.STATS_PROOF_ACTION !== 'run-stats-pagination-proof' ||
    environment.GITHUB_REPOSITORY !== 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' ||
    environment.GITHUB_REPOSITORY_ID !== '1132369872' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    !SHA.test(environment.GITHUB_SHA || '') ||
    !payload ||
    Array.isArray(payload) ||
    typeof payload !== 'object' ||
    Object.keys(payload).length !== 0
  )
    throw new Error(
      'Stats pagination proof requires its fixed trusted main event and an empty payload'
    );
  return true;
}

export async function readStatsClientPin(fetchImpl = fetch) {
  const builds = await Promise.all(
    origins.map(async (url) => {
      const response = await fetchImpl(url, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Client origin is unreadable (${response.status})`);
      const raw = await response.text();
      return { url, sha: readBuildInfoSha(raw), build: JSON.parse(raw) };
    })
  );
  if (builds[0].sha !== builds[1].sha) throw new Error('The two client origins disagree');
  return { sha: builds[0].sha, builds, observedAt: new Date().toISOString() };
}

function requirePin(pin, expected) {
  if (
    !pin ||
    pin.sha !== expected ||
    !Array.isArray(pin.builds) ||
    pin.builds.length !== 2 ||
    pin.builds.some(
      (build, i) =>
        build.url !== origins[i] ||
        build.sha !== expected ||
        readBuildInfoSha(JSON.stringify(build.build)) !== expected
    )
  ) {
    throw new Error('Both client origins must preserve the exact before/after SHA');
  }
}

export function assertStatsPaginationProof(
  report,
  before,
  after,
  cleanup,
  attachmentReader = readFileSync
) {
  const expected = before?.sha;
  if (!SHA.test(expected || '')) throw new Error('Missing exact client pin');
  requirePin(before, expected);
  requirePin(after, expected);
  if (cleanup?.verified !== true)
    throw new Error('Actual isolated-account cleanup was not verified');
  if (
    !report ||
    !Array.isArray(report.suites) ||
    !Array.isArray(report.errors) ||
    report.errors.length
  ) {
    throw new Error('Missing or failed Stats pagination report');
  }
  const actual = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? [])
        actual.push({ spec, test, file: spec.file ?? suite.file });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  if (actual.length !== 1) throw new Error('Exactly one fixed Stats pagination case must execute');
  const { spec, test, file } = actual[0];
  if (
    file !== 'stats-deep.spec.ts' ||
    spec.title !== STATS_PAGINATION_TITLE ||
    spec.ok !== true ||
    test.projectName !== 'chromium' ||
    test.status !== 'expected' ||
    test.expectedStatus !== 'passed' ||
    test.results?.length !== 1 ||
    test.results[0].status !== 'passed' ||
    test.results[0].retry !== 0 ||
    test.results[0].errors?.length
  ) {
    throw new Error('The exact Stats pagination case must pass once, without skips or retries');
  }
  const attachments = (test.results[0].attachments ?? []).filter(
    (a) => a.name === 'published-downline-pagination' && a.contentType === 'application/json'
  );
  if (attachments.length !== 1) throw new Error('Missing the actual browser pagination evidence');
  const attachment = attachments[0];
  const evidence = JSON.parse(
    attachment.body
      ? Buffer.from(attachment.body, 'base64').toString('utf8')
      : attachmentReader(attachment.path, 'utf8')
  );
  if (
    evidence.clientSha !== expected ||
    evidence.syntheticReadResponses !== true ||
    evidence.actualPublishedAssets !== true ||
    evidence.blockedWrites !== 0 ||
    JSON.stringify(evidence.reads) !==
      JSON.stringify([
        { limit: 501, search: null },
        { limit: 1001, search: null },
        { limit: 501, search: 'river' },
      ]) ||
    !Array.isArray(evidence.bracket) ||
    evidence.bracket.length !== 2 ||
    evidence.bracket.some(
      (point, i) =>
        point.point !== ['before', 'after'][i] || point.sha !== expected || point.reason !== null
    )
  ) {
    throw new Error(
      'Pagination assertions and both browser release reads must certify the pinned client'
    );
  }
  return {
    clientSha: expected,
    executed: 1,
    passed: 1,
    skipped: 0,
    failed: 0,
    retries: 0,
    cleanupVerified: true,
  };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'admit' && args.length === 0) {
    admitStatsPaginationProof(JSON.parse(process.env.STATS_PROOF_PAYLOAD || 'null'));
  } else if (mode === 'pin' && args.length === 1) {
    const pin = await readStatsClientPin();
    writeFileSync(args[0], `${JSON.stringify(pin, null, 2)}\n`);
    if (process.env.LIVE_SHA && pin.sha !== process.env.LIVE_SHA)
      throw new Error('Client changed during the Stats pagination proof');
    process.stdout.write(`${pin.sha}\n`);
  } else if (mode === 'verify' && args.length === 4) {
    for (const key of [
      'ACCOUNT_OUTCOME',
      'PROOF_OUTCOME',
      'AFTER_PIN_OUTCOME',
      'CLEANUP_OUTCOME',
    ]) {
      if (process.env[key] !== 'success') throw new Error(`${key} did not succeed`);
    }
    const verdict = assertStatsPaginationProof(
      ...args.map((path) => JSON.parse(readFileSync(path, 'utf8')))
    );
    console.log(JSON.stringify(verdict));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `One Stats pagination case passed on client \`${verdict.clientSha}\`, with zero skips/retries and verified isolated-account cleanup.\n`
      );
  } else
    throw new Error(
      'Usage: stats-pagination-proof.mjs admit | pin FILE | verify REPORT BEFORE AFTER CLEANUP'
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[stats-pagination-proof] ${error.message}`);
    process.exitCode = 1;
  });
}
