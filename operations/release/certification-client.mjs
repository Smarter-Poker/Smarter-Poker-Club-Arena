import { randomUUID } from 'node:crypto';
import { readFile, writeFile, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  requireCertificate as need,
  validateComponentRequest,
  uuid,
} from './component-certificate.mjs';

export function controlledCertificate(environment = process.env) {
  if (!environment.RELEASE_CERTIFICATE_REQUEST) return null;
  const request = JSON.parse(environment.RELEASE_CERTIFICATE_REQUEST);
  if (request.certificate_version !== 2) return null;
  validateComponentRequest(request, environment.RELEASE_CERTIFICATE_OPERATION, environment);
  need(
    environment.RELEASE_CERTIFICATION_AUTHORITY_URL === request.fixture_authority.url &&
      environment.RELEASE_CERTIFICATION_INGRESS_RECEIPT ===
        request.fixture_authority.installation_receipt &&
      environment.GITHUB_REPOSITORY_ID === request.repository_id,
    'RELEASE_INSTALLED_CERTIFICATION_IDENTITY_REQUIRED'
  );
  need(environment.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID));
  return request;
}
export async function jsonResponse(response) {
  need(response.ok, 'RELEASE_CERTIFICATION_AUTHORITY_UNAVAILABLE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    need(size <= 65536);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}
export async function certificateAuthority(
  body,
  { environment = process.env, fetchImpl = fetch } = {}
) {
  const request = controlledCertificate(environment);
  need(
    request &&
      environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN &&
      environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    'RELEASE_INSTALLED_CERTIFICATION_IDENTITY_REQUIRED'
  );
  const tokenURL = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  need(
    tokenURL.protocol === 'https:' &&
      !tokenURL.username &&
      !tokenURL.password &&
      tokenURL.hostname.endsWith('.actions.githubusercontent.com')
  );
  tokenURL.searchParams.set('audience', request.fixture_authority.audience);
  const token = await jsonResponse(
    await fetchImpl(tokenURL, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
        'Cache-Control': 'no-cache',
      },
    })
  );
  need(typeof token.value === 'string' && token.value.length <= 16384);
  // No retry after an ambiguous mutation response. The persisted claim key and
  // exact reserved user ID provide reconciliation without another create grant.
  return jsonResponse(
    await fetchImpl(request.fixture_authority.url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${token.value}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        ...body,
        operation_id: environment.RELEASE_CERTIFICATE_OPERATION,
        ...(environment.RELEASE_CLEANUP_RECOVERY
          ? { recovery_id: environment.RELEASE_CLEANUP_RECOVERY }
          : {}),
      }),
    })
  );
}
export async function consumeFixture(
  slot,
  { environment = process.env, authority = certificateAuthority } = {}
) {
  const request = controlledCertificate(environment);
  if (!request) return null;
  need(!environment.RELEASE_CLEANUP_RECOVERY, 'RELEASE_CLEANUP_ONLY_ACTION_REFUSED');
  const account = request.fixture_roster[slot];
  need(account && uuid.test(account.user_id));
  const directory = path.join(environment.RUNNER_TEMP, 'release-certificate', 'fixture-claims');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${slot}.json`);
  let intent;
  try {
    const handle = await open(filename, 'wx', 0o600);
    try {
      intent = {
        slot,
        ...account,
        claim_key: randomUUID(),
        operation_id: environment.RELEASE_CERTIFICATE_OPERATION,
        run_id: environment.GITHUB_RUN_ID,
        run_attempt: 1,
      };
      await handle.writeFile(JSON.stringify(intent));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    intent = JSON.parse(await readFile(filename, 'utf8'));
    need(
      intent.user_id === account.user_id &&
        intent.email === account.email &&
        intent.operation_id === environment.RELEASE_CERTIFICATE_OPERATION &&
        intent.run_id === environment.GITHUB_RUN_ID
    );
  }
  const grant = await authority(
    { action: 'consume', slot, claim_key: intent.claim_key },
    { environment }
  );
  need(
    grant.user_id === account.user_id &&
      grant.email === account.email &&
      uuid.test(grant.claim_event)
  );
  await writeFile(`${filename}.receipt`, JSON.stringify(grant), { mode: 0o600 });
  need(grant.may_create === true, 'RELEASE_FIXTURE_ALREADY_CLAIMED_RECONCILE_ONLY');
  return { ...account, claim_event: grant.claim_event };
}

export async function recordFixtureCreated(
  slot,
  userId,
  { environment = process.env, authority = certificateAuthority } = {}
) {
  const request = controlledCertificate(environment);
  if (!request) return null;
  const account = request.fixture_roster[slot];
  need(account?.user_id === userId);
  const proof = { ...account, outcome: 'CREATED' };
  const directory = path.join(environment.RUNNER_TEMP, 'release-certificate', 'fixture-claims');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(path.join(directory, `${slot}.created.json`), 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(proof));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return authority({ action: 'creation-result', slot, proof }, { environment });
}
