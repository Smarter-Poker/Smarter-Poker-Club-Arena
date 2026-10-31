#!/usr/bin/env node
// Closed modern-web proof only. No release, source-switch, engine or legacy authority.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStatsClientPin as readClientPin } from './stats-pagination-proof.mjs';
export const PRIVATE_RECORD_CLIENT_TITLE =
  'published private record client survives its isolated engine channel outage';
const REPO = 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena';
const SHA = /^[0-9a-f]{40}$/;
const ROOT = 'e2e-report/private-record-client';
class ProofRefusal extends Error {}
const requireProof = (condition, message) => {
  if (!condition) throw new ProofRefusal(message);
};
// Optional display aliases never establish the reserved actor or roster row.
export function snapshotPrivateRecordFixtureProfile(rows, userId) {
  requireProof(
    Array.isArray(rows) &&
      rows.length === 1 &&
      rows[0]?.id === userId &&
      ['avatar_url', 'arena_avatar_url'].every(
        (key) =>
          rows[0][key] === null || (typeof rows[0][key] === 'string' && rows[0][key].length <= 2048)
      ),
    'Exact own profile and cosmetic restoration fields are required'
  );
  return {
    id: rows[0].id,
    avatar_url: rows[0].avatar_url,
    arena_avatar_url: rows[0].arena_avatar_url,
  };
}
export function readPrivateRecordFixturePlayerNumber(detail, userId) {
  const number = detail?.identity?.player_number;
  requireProof(
    detail?.identity?.user_id === userId &&
      typeof number === 'string' &&
      /^[0-9]{1,20}$/.test(number),
    'Authorized member identity and bounded player number are required'
  );
  return number;
}
export function assertPrivateRecordFixtureRoster(body, userId, playerNumber) {
  requireProof(
    typeof playerNumber === 'string' && /^[0-9]{1,20}$/.test(playerNumber),
    'The authoritative player number is required'
  );
  const rows = body?.items;
  requireProof(Array.isArray(rows), 'The actual roster response is required');
  const matches = rows.filter((row) => row?.player_number === playerNumber);
  requireProof(
    matches.length === 1 &&
      matches[0].user_id === userId &&
      rows.filter((row) => row?.user_id === userId).length === 1,
    'The actual roster must contain one exact reserved actor and player number'
  );
  return matches[0];
}
export function admitPrivateRecordClientProof(payload, environment = process.env) {
  requireProof(
    environment.GITHUB_EVENT_NAME === 'repository_dispatch' &&
      environment.RECORD_CLIENT_PROOF_ACTION === 'run-private-record-client-proof' &&
      environment.GITHUB_REPOSITORY === REPO &&
      environment.GITHUB_REPOSITORY_ID === '1132369872' &&
      environment.GITHUB_REF === 'refs/heads/main' &&
      SHA.test(environment.GITHUB_SHA || ''),
    'Only the fixed protected-main event can admit this proof'
  );
  requireProof(
    payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      Object.keys(payload).sort().join() === 'client_sha,gateway_run_id,gateway_sha' &&
      SHA.test(payload.client_sha || '') &&
      SHA.test(payload.gateway_sha || '') &&
      /^[1-9][0-9]{0,19}$/.test(String(payload.gateway_run_id || '')),
    'Exact client, gateway and owning gateway-publisher identities are required'
  );
  return {
    clientSha: payload.client_sha,
    gatewaySha: payload.gateway_sha,
    gatewayRunId: String(payload.gateway_run_id),
  };
}
export function assertQualifiedGateway(input, run, jobs, evidence) {
  requireProof(
    run?.repository?.id === 1132369872 &&
      run.repository.full_name === REPO &&
      String(run.id) === input.gatewayRunId &&
      run.head_sha === input.gatewaySha &&
      run.head_branch === 'main' &&
      run.path === '.github/workflows/publish-club-arena.yml' &&
      run.event === 'repository_dispatch' &&
      run.status === 'completed' &&
      run.conclusion === 'success',
    'The exact protected gateway publisher has not completed successfully'
  );
  const gateway = jobs?.filter(
    (job) =>
      job.name === 'publish-record-gateway' || job.name?.endsWith(' / publish-record-gateway')
  );
  requireProof(
    gateway?.length === 1 &&
      gateway[0].status === 'completed' &&
      gateway[0].conclusion === 'success',
    'The owning gateway publication job is missing or unsuccessful'
  );
  for (const name of [
    'Activate only the prepared independent service',
    'Verify authenticated gateway record delivery',
    'Ensure the reserved gateway canary account is retired',
  ]) {
    const steps = gateway[0].steps?.filter((step) => step.name === name);
    requireProof(
      steps?.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success',
      'Actual activation, authenticated source delivery and cleanup must precede client proof'
    );
  }
  requireProof(
    evidence?.schema === 1 &&
      evidence.component === 'private-record-gateway-live' &&
      evidence.revision === input.gatewaySha &&
      [
        'genuineAuthAndSession',
        'allowedRosterReady',
        'deniedForeignTopic',
        'cosmeticSourceInvalidation',
        'readerReadback',
        'cleanupVerified',
      ].every((key) => evidence[key] === true) &&
      evidence.paidRetirementQualified === false,
    'The exact token-free gateway functional receipt is incomplete'
  );
  return true;
}
export async function readPrivateRecordClientPin(input, { fetchImpl = fetch, readPaid } = {}) {
  requireProof(typeof readPaid === 'function', 'Actual paid-source readback is required');
  const client = await readClientPin(fetchImpl);
  requireProof(
    client.sha === input.clientSha,
    'The published client differs from the selected client'
  );
  const response = await fetchImpl('https://ca-static.smarter.poker/private-record/health', {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  requireProof(response.ok, 'Gateway health is unavailable');
  const gateway = await response.json();
  requireProof(
    gateway?.service === 'private-record-gateway' &&
      gateway.revision === input.gatewaySha &&
      gateway.processReachable === true &&
      gateway.sourceReady === true,
    'Exact gateway source readiness is missing'
  );
  requireProof((await readPaid()) === true, 'Paid Realtime must remain enabled');
  return {
    clientSha: client.sha,
    gatewaySha: gateway.revision,
    paidSourceEnabled: true,
    origins: client.builds.map(({ url, sha }) => ({ url, sha })),
    observedAt: new Date().toISOString(),
  };
}
export function assertPrivateRecordClientProof(
  report,
  input,
  before,
  after,
  cleanup,
  readAttachment = readFileSync
) {
  for (const point of [before, after])
    requireProof(
      point?.clientSha === input.clientSha &&
        point.gatewaySha === input.gatewaySha &&
        point.paidSourceEnabled === true &&
        point.origins?.length === 2 &&
        point.origins.every(
          (origin, index) =>
            origin.sha === input.clientSha &&
            origin.url ===
              [
                'https://smarter.poker/hub/club-arena/build-info.json',
                'https://ca-static.smarter.poker/build-info.json',
              ][index]
        ),
      'Exact before/after client, gateway and paid-source pins are required'
    );
  requireProof(cleanup?.verified === true, 'Reserved-account cleanup was not verified');
  requireProof(
    Array.isArray(report?.suites) && Array.isArray(report.errors) && report.errors.length === 0,
    'Browser report is missing or failed'
  );
  const entries = [];
  function visit(suite) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        entries.push({ spec, test, file: spec.file ?? suite.file });
    for (const child of suite.suites ?? []) visit(child);
  }
  report.suites.forEach(visit);
  requireProof(entries.length === 1, 'Exactly one modern-client case must execute');
  const { spec, test, file } = entries[0];
  requireProof(
    file === 'production-private-record-failover.spec.ts' &&
      spec.title === PRIVATE_RECORD_CLIENT_TITLE &&
      spec.ok === true &&
      test.projectName === 'chromium' &&
      test.status === 'expected' &&
      test.expectedStatus === 'passed' &&
      test.results?.length === 1 &&
      test.results[0].status === 'passed' &&
      test.results[0].retry === 0 &&
      !test.results[0].errors?.length,
    'The actual browser case must pass once without skips or retries'
  );
  const attachments = test.results[0].attachments?.filter(
    (a) => a.name === 'published-private-record-failover' && a.contentType === 'application/json'
  );
  requireProof(attachments?.length === 1, 'Actual SDK/reader browser evidence is missing');
  const attachment = attachments[0];
  let raw;
  if (attachment.body) raw = Buffer.from(attachment.body, 'base64').toString('utf8');
  else {
    const path = realpathSync(attachment.path);
    requireProof(
      path.startsWith(resolve('test-results/private-record-client') + '/'),
      'Browser attachment escaped its owned output'
    );
    raw = readAttachment(path, 'utf8');
  }
  requireProof(Buffer.byteLength(raw) < 32_768, 'Browser evidence exceeds its fixed budget');
  const proof = JSON.parse(raw);
  requireProof(
    proof.clientSha === input.clientSha &&
      proof.gatewaySha === input.gatewaySha &&
      [
        'actualPublishedClient',
        'authoritativeFixtureIdentity',
        'rosterIdentityVerified',
        'genuineSession',
        'engineReadyBefore',
        'isolatedEngineChannelFault',
        'gatewayReadyAfterFault',
        'gatewayRecordChanged',
        'readerReadback',
        'visibleAvatarReadback',
        'engineReadyAfterRestore',
        'gatewayRecordChangedAfterRestore',
        'secondVisibleAvatarReadback',
        'faultRestored',
        'rosterGatewayVerified',
        'rosterPaidVerified',
        'memberPaidVerified',
        'bothPreferredPathsInterrupted',
        'allFaultsRestored',
        'preferredReadyAfterPaid',
        'cosmeticRestoreVerified',
      ].every((key) => proof[key] === true) &&
      proof.paidIsolation?.activeAtStart === 0 &&
      proof.paidIsolation?.activeAtEnd === 0 &&
      proof.paidIsolation?.joins === 0 &&
      proof.paidIsolation?.matchingChangedFrames === 0 &&
      Number.isInteger(proof.paidIsolation?.observedFrames) &&
      proof.paidIsolation.observedFrames >= 0 &&
      Number.isInteger(proof.gatewayRetention?.openSocketsBeforeSecondWrite) &&
      proof.gatewayRetention.openSocketsBeforeSecondWrite > 0 &&
      Number.isInteger(proof.gatewayRetention?.openSocketsAfterSecondWrite) &&
      proof.gatewayRetention.openSocketsAfterSecondWrite > 0 &&
      Number.isInteger(proof.gatewayRetention?.matchingChangesAfterRecovery) &&
      proof.gatewayRetention.matchingChangesAfterRecovery > 0 &&
      ['member', 'roster'].every(
        (topic) =>
          Number.isInteger(proof.paidFallback?.[topic]?.confirmedJoins) &&
          proof.paidFallback[topic].confirmedJoins > 0 &&
          Number.isInteger(proof.paidFallback?.[topic]?.receivedChanges) &&
          proof.paidFallback[topic].receivedChanges > 0
      ) &&
      proof.observationsOverflow === false &&
      proof.cosmeticWrites === 5 &&
      proof.syntheticFrames === 0 &&
      proof.paidRetirementQualified === false,
    'Published SDK outage, genuine event, reader/UI or recovery evidence is incomplete'
  );
  return {
    schema: 1,
    scope: 'modern-published-web-client-only',
    clientSha: input.clientSha,
    gatewaySha: input.gatewaySha,
    gatewayRunId: input.gatewayRunId,
    modernClientFailoverVerified: true,
    cleanupVerified: true,
    paidSourceEnabled: true,
    paidRetirementQualified: false,
  };
}
async function readPaidSource() {
  const { default: pg } = await import('pg');
  const { enginePgSsl } = await import('../../server/src/services/supabase/enginePgSession.ts');
  const url = new URL(process.env.DATABASE_URL || '');
  requireProof(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.pathname === '/postgres' &&
      (url.hostname === 'db.kuklfnapbkmacvwxktbh.supabase.co' ||
        (url.hostname.endsWith('.pooler.supabase.com') &&
          decodeURIComponent(url.username) === 'postgres.kuklfnapbkmacvwxktbh')),
    'Canonical production readback endpoint is required'
  );
  for (const key of [...url.searchParams.keys()])
    if (/^ssl/i.test(key)) url.searchParams.delete(key);
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: enginePgSsl(),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    application_name: 'ca-private-record-client-proof-readonly',
  });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT supabase_enabled FROM public.ca_private_record_transport_state WHERE singleton'
    );
    return result.rows.length === 1 && result.rows[0].supabase_enabled === true;
  } finally {
    await client.end();
  }
}
async function main() {
  const [mode, output] = process.argv.slice(2);
  const inputFile = join(ROOT, 'inputs.json');
  if (mode === 'admit') {
    const input = admitPrivateRecordClientProof(
      JSON.parse(process.env.RECORD_CLIENT_PROOF_PAYLOAD || 'null')
    );
    const api = (path) =>
      JSON.parse(
        execFileSync('gh', ['api', path], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        })
      );
    const run = api(`repos/${REPO}/actions/runs/${input.gatewayRunId}`);
    const pages = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--paginate',
          '--slurp',
          `repos/${REPO}/actions/runs/${input.gatewayRunId}/jobs?per_page=100`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
      )
    );
    const directory = resolve(process.env.RUNNER_TEMP, 'private-record-client-gateway-receipt');
    mkdirSync(directory); // Existing/unknown data is refused, never adopted.
    execFileSync(
      'gh',
      [
        'run',
        'download',
        input.gatewayRunId,
        '--repo',
        REPO,
        '--name',
        `private-record-gateway-live-${input.gatewayRunId}`,
        '--dir',
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
    );
    const evidence = JSON.parse(
      readFileSync(join(directory, 'private-record-gateway-live.json'), 'utf8')
    );
    assertQualifiedGateway(
      input,
      run,
      pages.flatMap((page) => page.jobs),
      evidence
    );
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(inputFile, JSON.stringify(input));
    appendFileSync(
      process.env.GITHUB_ENV,
      `LIVE_SHA=${input.clientSha}\nEXPECTED_GATEWAY_REVISION=${input.gatewaySha}\nE2E_PRIVATE_RECORD_CLIENT_PROOF=1\n`
    );
  } else if (mode === 'pin' && ['before.json', 'after.json'].includes(output)) {
    const pin = await readPrivateRecordClientPin(JSON.parse(readFileSync(inputFile, 'utf8')), {
      readPaid: readPaidSource,
    });
    writeFileSync(join(ROOT, output), JSON.stringify(pin));
  } else if (mode === 'verify') {
    for (const key of [
      'ACCOUNT_OUTCOME',
      'BROWSER_OUTCOME',
      'AFTER_PIN_OUTCOME',
      'CLEANUP_OUTCOME',
    ])
      requireProof(process.env[key] === 'success', `${key} did not succeed`);
    const read = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
    const verdict = assertPrivateRecordClientProof(
      read('report.json'),
      read('inputs.json'),
      read('before.json'),
      read('after.json'),
      read('cleanup.json')
    );
    writeFileSync(join(ROOT, 'verdict.json'), JSON.stringify(verdict));
    console.log(JSON.stringify(verdict));
  } else throw new ProofRefusal('Use admit | pin before.json/after.json | verify');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof ProofRefusal
        ? error.message
        : 'Private record client proof refused; provider input or bounded read failed. No retirement qualified.'
    );
    process.exitCode = 1;
  });
