import { createHash } from 'node:crypto';
import { operationPolicyDigest } from './operation-policy.mjs';

export const certificateTargets = Object.freeze(['club-arena-engine', 'club-arena-web']);
export const fixtureSlots = Object.freeze([
  'postdeploy',
  'theme-primary',
  'theme-other',
  'buyer',
  'bundle',
  'observer',
  'missions',
  'settlement',
  'freeze',
]);
export const certificateReports = Object.freeze([
  'cashier',
  'stats',
  'lobby',
  'live-table-realtime',
  'club-members',
  'customization-realtime',
  'customization-commerce',
  'daily-missions',
  'daily-missions-accessibility',
  'daily-missions-settlement',
  'sweep',
]);
export const fullSha = /^[0-9a-f]{40}$/;
export const artifactIdentity = /^sha256:[0-9a-f]{64}$/;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function requireCertificate(value, reason = 'RELEASE_COMPONENT_CERTIFICATE_REFUSED') {
  if (!value) throw new Error(reason);
}
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const sameFacts = (a, b) => canonicalJSON(a) === canonicalJSON(b);
export const factDigest = (value) =>
  createHash('sha256').update(canonicalJSON(value)).digest('hex');

export function validateComponentTuple(components) {
  requireCertificate(components && sameFacts(Object.keys(components).sort(), certificateTargets));
  for (const target of certificateTargets) {
    const c = components[target];
    requireCertificate(
      c &&
        fullSha.test(c.source_sha) &&
        artifactIdentity.test(c.identity) &&
        ['changed', 'retained'].includes(c.mode)
    );
    if (c.mode === 'changed') requireCertificate(uuid.test(c.publication_operation_id));
    else
      requireCertificate(uuid.test(c.verified_receipt_id) && uuid.test(c.compatibility_receipt_id));
    if (target === 'club-arena-web')
      requireCertificate(
        c.identity === `sha256:${c.manifest_digest}` && /^[0-9a-f]{64}$/.test(c.manifest_digest)
      );
  }
  return components;
}
export function validateFixtureRoster(roster) {
  requireCertificate(roster && sameFacts(Object.keys(roster).sort(), [...fixtureSlots].sort()));
  requireCertificate(
    new Set(Object.values(roster).map((x) => x.user_id)).size === fixtureSlots.length
  );
  for (const slot of fixtureSlots) {
    const account = roster[slot];
    requireCertificate(
      uuid.test(account?.user_id) &&
        account.email === `ca-customization-cert-${slot}-${account.user_id}@example.invalid`
    );
  }
  return roster;
}
export function validateComponentRequest(r, operation, env) {
  requireCertificate(
    r?.certificate_version === 2 &&
      r.phase === 'CERTIFY' &&
      uuid.test(operation) &&
      uuid.test(r.release_id) &&
      /^[0-9a-f]{64}$/.test(r.manifest_digest) &&
      fullSha.test(r.admission_sha) &&
      fullSha.test(r.control_sha) &&
      r.repository === env.GITHUB_REPOSITORY &&
      r.control_sha === env.GITHUB_SHA &&
      /^[1-9][0-9]*$/.test(String(r.repository_id)) &&
      Number.isSafeInteger(r.workflow_id) &&
      r.workflow_id > 0 &&
      r.operation_policy_digest === operationPolicyDigest &&
      r.fixture_authority?.audience === 'club-arena-release-certification' &&
      /^https:\/\/[a-z0-9.-]+\/certification$/.test(r.fixture_authority?.url ?? '') &&
      uuid.test(r.fixture_authority?.installation_receipt)
  );
  validateComponentTuple(r.component_tuple);
  validateFixtureRoster(r.fixture_roster);
  return r;
}

// Missing, skipped-only, retried and red reports remain red. Digests cover the
// original report bytes; these summaries never replace the preserved reports.
export function reportFact(name, bytes) {
  requireCertificate(
    certificateReports.includes(name) && Buffer.isBuffer(bytes) && bytes.length <= 32 * 1024 * 1024
  );
  const result = {
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    executed: 0,
    failed: 0,
    skipped: 0,
    retried: 0,
    complete: true,
  };
  let report;
  try {
    report = JSON.parse(bytes);
  } catch {
    result.complete = false;
    return result;
  }
  if (report.notRunReason || !Array.isArray(report.suites) || report.errors?.length)
    result.complete = false;
  function walk(suite) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const outcomes = test.results ?? [];
        if (outcomes.length > 1 || outcomes.some((r) => r.retry !== undefined && r.retry !== 0))
          result.retried++;
        if (outcomes.length === 1 && outcomes[0].status === 'passed') result.executed++;
        else if (
          outcomes.length &&
          outcomes.some((r) => !['passed', 'skipped'].includes(r.status))
        ) {
          result.failed++;
          result.executed++;
        } else result.skipped++;
      }
    for (const child of suite.suites ?? []) walk(child);
  }
  for (const suite of report.suites ?? []) walk(suite);
  result.complete &&= result.executed > 0;
  return result;
}
export function reportsPassed(reports) {
  return (
    Array.isArray(reports) &&
    sameFacts(reports.map((r) => r.name).sort(), [...certificateReports].sort()) &&
    reports.every(
      (r) =>
        /^[0-9a-f]{64}$/.test(r.sha256) &&
        r.complete === true &&
        Number.isSafeInteger(r.executed) &&
        r.executed > 0 &&
        r.failed === 0 &&
        r.retried === 0
    )
  );
}
