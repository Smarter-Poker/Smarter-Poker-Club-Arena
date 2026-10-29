import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const sha = (value) => /^[0-9a-f]{40}$/.test(value ?? '');
const seal = 'gateway-release.json';
function inventory(root, directory = root) {
  const files = Object.create(null);
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith('.env')) throw new Error('credentials are forbidden in gateway artifacts');
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error('artifact links/special files are forbidden');
    if (stat.isDirectory()) Object.assign(files, inventory(root, path));
    else if (path !== join(root, seal))
      files[path.slice(root.length + 1)] = createHash('sha256')
        .update(readFileSync(path))
        .digest('hex');
  }
  return files;
}
export function sealGatewayArtifact(directory, revision, provenance = { validationOnly: true }) {
  if (!sha(revision)) throw new Error('one full revision is required');
  const root = resolve(directory);
  if (lstatSync(root).isSymbolicLink()) throw new Error('artifact root must not be a symlink');
  const files = inventory(root);
  if (!files['dist/privateRecordGateway.js'] || !files['package.json'])
    throw new Error('gateway entry/package absent');
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).type !== 'module')
    throw new Error('gateway must use ESM');
  const receipt = {
    schema: 1,
    component: 'private-record-gateway',
    revision,
    entry: 'dist/privateRecordGateway.js',
    provenance,
    files,
  };
  writeFileSync(join(root, seal), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}
export function verifyGatewayArtifact(directory, revision) {
  const root = resolve(directory);
  if (!sha(revision) || lstatSync(root).isSymbolicLink()) throw new Error('invalid revision/root');
  const receipt = JSON.parse(readFileSync(join(root, seal), 'utf8'));
  const files = inventory(root);
  if (
    receipt.schema !== 1 ||
    receipt.component !== 'private-record-gateway' ||
    receipt.revision !== revision ||
    receipt.entry !== 'dist/privateRecordGateway.js' ||
    JSON.stringify(files) !== JSON.stringify(receipt.files)
  )
    throw new Error('gateway artifact identity or exact inventory mismatch');
  return receipt;
}
/** Evidence triage only; never mutates a source switch or certifies supplied provenance. */
export function assessClientCoverage(evidence) {
  const reasons = [];
  const census = evidence?.census;
  if (
    census?.complete !== true ||
    !Array.isArray(census?.connections) ||
    !Array.isArray(census?.clusterNodes) ||
    census.clusterNodes.length === 0 ||
    !census.snapshotId
  )
    reasons.push(
      'Complete provider Broadcast cluster census is missing; samples and error reports are insufficient.'
    );
  if (
    census?.connections?.some(
      (peer) => !peer.connectionId || !sha(peer.build) || peer.fallbackVerified !== true
    ) ||
    census?.unqualified !== 0
  )
    reasons.push('One or more current connections are unknown or unqualified.');
  if (
    evidence?.returningLegacy?.verified !== true ||
    !['retained-compatible-delivery', 'enforced-safe-record-admission'].includes(
      evidence?.returningLegacy?.mode
    ) ||
    !sha(evidence?.returningLegacy?.revision) ||
    !evidence?.returningLegacy?.proof
  )
    reasons.push(
      'Returning/resumed old browser and native clients lack a verified compatibility or safe admission boundary.'
    );
  // A retained paid path covers legacy clients only while that source stays on.
  // It must never be used as evidence for removing its own dependency.
  if (evidence?.returningLegacy?.paidSourceDependency !== 'none')
    reasons.push(
      'Returning-client compatibility still depends on paid delivery, or that dependency is unknown.'
    );
  if (
    !sha(evidence?.gateway?.revision) ||
    evidence?.gateway?.independentHostVerified !== true ||
    evidence?.gateway?.authenticatedFailoverVerified !== true ||
    !evidence?.gateway?.proof
  )
    reasons.push('Independent hosted gateway and authenticated outage proof are missing.');
  return {
    schema: 1,
    scope: 'input-evidence-triage-only',
    eligible: reasons.length === 0,
    reasons,
    limitation:
      'Passing input validation is not proof that its sources are authoritative/current, nor authorization to disable paid delivery. Verify provenance and atomic admission at the owning source.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, revision] = process.argv.slice(2);
  if (command === 'seal') console.log(JSON.stringify(sealGatewayArtifact(directory, revision)));
  else if (command === 'verify') {
    const receipt = verifyGatewayArtifact(directory, revision);
    console.log(JSON.stringify({ verified: true, revision: receipt.revision }));
  } else if (command === 'coverage') {
    const result = assessClientCoverage(JSON.parse(readFileSync(directory, 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.eligible ? 0 : 3;
  } else throw new Error('use seal|verify <artifact> <revision> or coverage <evidence.json>');
}
