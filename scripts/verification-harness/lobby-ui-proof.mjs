import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const UI_FIX = 'b5d39fb0f50ea29452f39e9f606bd31564365b23';
const CASE_FIX = '4965250a689063414ccc8d6d66ddba5e5a9d7732';
const ORIGINS = ['https://ca-static.smarter.poker', 'https://smarter.poker/hub/club-arena'];
export const COMPONENT_PATHS = [
  'src/components/table/HubFrame.tsx',
  'src/pages/MultiTablePage.tsx',
  'src/pages/ClubHomePage.tsx',
  'src/components/lobby/lobbyViewPrefs.ts',
  'src/utils/tabSlots.ts',
];
export const CASES = [
  'the selected game list survives a cold return to the lobby',
  'tournament Details stays inside the spectator table lobby tab',
];

export function admitDispatch(environment, event) {
  if (
    environment.GITHUB_EVENT_NAME !== 'repository_dispatch' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    environment.GITHUB_REPOSITORY_ID !== '1132369872' ||
    !SHA.test(environment.GITHUB_SHA || '') ||
    !ID.test(environment.PROOF_RUN_ID || '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.GITHUB_REPOSITORY || '') ||
    event?.action !== 'verify-lobby-ui' ||
    !event.client_payload ||
    Array.isArray(event.client_payload) ||
    typeof event.client_payload !== 'object' ||
    Object.keys(event.client_payload).length !== 0
  ) {
    throw new Error('Lobby UI proof requires a closed default-branch repository dispatch.');
  }
}

export function assertCases(report) {
  if (!report || report.errors?.length || report.notRunReason || !Array.isArray(report.suites))
    throw new Error('Lobby browser report is missing or contains errors.');
  const actual = [];
  const visit = (suite) => {
    for (const spec of suite.specs || []) {
      const file = String(spec.file || suite.file || '').replaceAll('\\', '/');
      for (const test of spec.tests || []) {
        if (
          !file.endsWith('production-mobile-lobby-chrome.spec.ts') ||
          !CASES.includes(spec.title) ||
          spec.ok !== true ||
          test.projectName !== 'chromium' ||
          test.status !== 'expected' ||
          test.expectedStatus !== 'passed' ||
          test.results?.length !== 1 ||
          test.results[0].status !== 'passed' ||
          test.results[0].retry !== 0 ||
          test.annotations?.some((a) => a.type === 'skip' || a.type === 'fixme')
        )
          throw new Error('Each selected Lobby case must pass once without skips or retries.');
        actual.push(spec.title);
      }
    }
    for (const child of suite.suites || []) visit(child);
  };
  report.suites.forEach(visit);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...CASES].sort()))
    throw new Error('Exactly the saved-lobby and plus-page-retention cases must execute.');
  return actual;
}

export function assertPins(before, after, cleanup) {
  for (const pin of [before, after]) {
    if (
      pin?.schema !== 1 ||
      !SHA.test(pin.clientSha || '') ||
      !SHA.test(pin.verificationSha || '') ||
      !ID.test(pin.runId || '') ||
      !ID.test(pin.publisherRunId || '') ||
      pin.publisherVerified !== true ||
      !Array.isArray(pin.endpoints) ||
      pin.endpoints.length !== 2 ||
      pin.endpoints.some(
        (e, i) =>
          e.origin !== ORIGINS[i] ||
          e.clientSha !== pin.clientSha ||
          e.publisherRunId !== pin.publisherRunId
      ) ||
      Object.keys(pin.components || {})
        .sort()
        .join('|') !== [...COMPONENT_PATHS].sort().join('|') ||
      Object.values(pin.components).some((value) => !SHA.test(value))
    )
      throw new Error('Lobby provenance is incomplete.');
  }
  if (before.clientSha !== after.clientSha || before.publisherRunId !== after.publisherRunId)
    throw new Error('The serving client changed during the cases; no scoped verdict.');
  if (
    before.verificationSha !== after.verificationSha ||
    before.runId !== after.runId ||
    JSON.stringify(before.components) !== JSON.stringify(after.components)
  )
    throw new Error('Verification source or component provenance changed.');
  if (cleanup?.verified !== true || cleanup.runId !== before.runId)
    throw new Error('The owned isolated account cleanup was not verified.');
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim();
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
async function jsonResponse(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Provenance read failed (${response.status}).`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('Provenance response exceeded its bound.');
  return JSON.parse(body);
}

export async function pin(file, environment = process.env) {
  if (
    ![
      'before.json',
      'after.json',
      'e2e-report/lobby-ui-proof/before.json',
      'e2e-report/lobby-ui-proof/after.json',
    ].includes(file)
  )
    throw new Error('Unknown proof phase.');
  admitDispatch(environment, readJson(environment.GITHUB_EVENT_PATH));
  const source = git('rev-parse', 'HEAD');
  if (source !== environment.GITHUB_SHA)
    throw new Error('Verification checkout differs from its admitted source.');
  git('fetch', '--no-tags', '--filter=blob:none', 'origin', 'main');
  git('merge-base', '--is-ancestor', source, 'origin/main');
  git('merge-base', '--is-ancestor', CASE_FIX, source);
  const endpoints = [];
  for (const origin of ORIGINS) {
    const info = await jsonResponse(
      `${origin}/build-info.json?lobby-proof=${environment.PROOF_RUN_ID}-${file}`
    );
    if (
      !SHA.test(info.ca_sha || '') ||
      !ID.test(String(info.run_id || '')) ||
      info.built_by !== 'publish-club-arena.yml'
    )
      throw new Error('Invalid published client identity.');
    endpoints.push({ origin, clientSha: info.ca_sha, publisherRunId: String(info.run_id) });
  }
  const { clientSha, publisherRunId } = endpoints[0];
  if (endpoints.some((e) => e.clientSha !== clientSha || e.publisherRunId !== publisherRunId))
    throw new Error('The two public client endpoints disagree.');
  git('cat-file', '-e', `${clientSha}^{commit}`);
  git('merge-base', '--is-ancestor', UI_FIX, clientSha);
  git('merge-base', '--is-ancestor', clientSha, 'origin/main');
  const components = {};
  for (const path of COMPONENT_PATHS) {
    const live = git('rev-parse', `${clientSha}:${path}`);
    if (live !== git('rev-parse', `${source}:${path}`))
      throw new Error(`The served Lobby component differs from the verifier source: ${path}`);
    components[path] = live;
  }
  if (!environment.GITHUB_TOKEN)
    throw new Error('Read-only publisher provenance access is unavailable.');
  const api = `https://api.github.com/repos/${environment.GITHUB_REPOSITORY}/actions/runs/${publisherRunId}`;
  const headers = {
    Authorization: `Bearer ${environment.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
  };
  const run = await jsonResponse(api, headers);
  if (
    String(run.repository?.id) !== environment.GITHUB_REPOSITORY_ID ||
    run.path !== '.github/workflows/publish-club-arena.yml' ||
    run.head_branch !== 'main' ||
    !['push', 'repository_dispatch'].includes(run.event) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('The live client lacks a successful protected publisher.');
  const jobs = [];
  let expected;
  for (let page = 1; page <= 10; page++) {
    const value = await jsonResponse(`${api}/jobs?per_page=100&page=${page}`, headers);
    if (!Array.isArray(value.jobs) || !Number.isSafeInteger(value.total_count))
      throw new Error('Publisher job metadata is incomplete.');
    expected ??= value.total_count;
    if (expected !== value.total_count) throw new Error('Publisher job metadata changed.');
    jobs.push(...value.jobs);
    if (jobs.length >= expected) break;
  }
  if (
    jobs.length !== expected ||
    !jobs.some(
      (j) =>
        (j.name === 'publish-to-origin' || j.name.endsWith(' / publish-to-origin')) &&
        j.conclusion === 'success'
    )
  )
    throw new Error('The actual client origin installation did not pass.');
  const result = {
    schema: 1,
    runId: environment.PROOF_RUN_ID,
    verificationSha: source,
    clientSha,
    publisherRunId,
    publisherVerified: true,
    endpoints,
    components,
    observedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(`Pinned Lobby UI ${clientSha}; publisher ${publisherRunId}; verification ${source}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'admit' && process.argv.length === 3) {
    admitDispatch(process.env, readJson(process.env.GITHUB_EVENT_PATH));
    if (git('rev-parse', 'HEAD') !== process.env.GITHUB_SHA)
      throw new Error('Wrong verifier checkout.');
    git('merge-base', '--is-ancestor', CASE_FIX, process.env.GITHUB_SHA);
  } else if (process.argv[2] === 'pin' && process.argv.length === 4) await pin(process.argv[3]);
  else if (process.argv[2] === 'assert' && process.argv.length === 7) {
    const [before, after, report, cleanup] = process.argv.slice(3).map(readJson);
    assertPins(before, after, cleanup);
    const cases = assertCases(report);
    writeFileSync(
      'lobby-ui-proof.json',
      JSON.stringify(
        {
          schema: 1,
          verdict: 'passed',
          scope: cases,
          clientSha: before.clientSha,
          publisherRunId: before.publisherRunId,
          verificationSha: before.verificationSha,
          runId: before.runId,
          cleanupVerified: true,
        },
        null,
        2
      ) + '\n'
    );
    console.log(
      'Both scoped Lobby cases passed once on the pinned live client; owned account cleanup verified.'
    );
  } else
    throw new Error(
      'Usage: lobby-ui-proof.mjs pin before.json|after.json | assert BEFORE AFTER REPORT CLEANUP'
    );
}
