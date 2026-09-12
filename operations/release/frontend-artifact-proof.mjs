import { createHash, randomUUID } from 'node:crypto';
const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const fullSha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const need = (value, reason) => {
  if (!value) throw new Error(`Frontend retention refused: ${reason}`);
};
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function publicDocuments(fetchImpl = fetch) {
  const result = {};
  for (const [name, base] of Object.entries({
    origin: 'https://ca-static.smarter.poker',
    public: 'https://smarter.poker/hub/club-arena',
  })) {
    result[name] = {};
    for (const file of ['build-info.json', 'ca-provenance.json']) {
      const response = await fetchImpl(`${base}/${file}?retention=${randomUUID()}`, {
        headers: { 'Cache-Control': 'no-cache' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      need(response.status === 200, 'public provenance unreadable');
      const text = await response.text();
      need(Buffer.byteLength(text) <= 1024 * 1024, 'oversized public provenance');
      result[name][file] = { value: JSON.parse(text), sha256: hash(text) };
    }
  }
  return result;
}
export function sourceOf(documents) {
  const source = documents?.origin?.['build-info.json']?.value?.ca_sha;
  need(
    fullSha.test(source ?? '') &&
      !/^0+$/.test(source) &&
      documents?.public?.['build-info.json']?.value?.ca_sha === source,
    'origin and public source disagree'
  );
  return source;
}
export function nativeIdentity(proof) {
  need(
    proof?.schema === 1 &&
      fullSha.test(proof.source_sha ?? '') &&
      digest.test(proof.manifest_sha256 ?? '') &&
      digest.test(proof.build_info_sha256 ?? '') &&
      digest.test(proof.provenance_sha256 ?? '') &&
      Number.isSafeInteger(proof.file_count) &&
      proof.file_count > 2 &&
      [proof.lock?.device, proof.lock?.inode, proof.release?.device, proof.release?.inode].every(
        Number.isSafeInteger
      ),
    'malformed native artifact proof'
  );
  const { observed_at, ...identity } = proof;
  need(
    typeof observed_at === 'string' && Number.isFinite(Date.parse(observed_at)),
    'missing native observation time'
  );
  return identity;
}
export function bindDocuments(documents, proof) {
  const identity = nativeIdentity(proof);
  need(sourceOf(documents) === proof.source_sha, 'native and public sources disagree');
  for (const side of ['origin', 'public']) {
    need(
      documents[side]['build-info.json'].sha256 === identity.build_info_sha256 &&
        documents[side]['ca-provenance.json'].sha256 === identity.provenance_sha256,
      'served documents differ from the existing immutable artifact'
    );
  }
  return identity;
}
export function requirePriorPublication(run, jobs, proof) {
  const id = proof.build_info?.run_id;
  need(
    typeof id === 'string' &&
      /^[1-9][0-9]*$/.test(id) &&
      String(run?.id) === id &&
      run.path === '.github/workflows/publish-club-arena.yml' &&
      run.head_branch === 'main' &&
      ['push', 'repository_dispatch'].includes(run.event) &&
      run.status === 'completed' &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      proof.provenance?.ciRun === `https://github.com/${repository}/actions/runs/${id}`,
    'original trusted publisher run not proven'
  );
  need(
    Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.total_count <= 100,
    'original publisher jobs incomplete'
  );
  const origin = jobs.jobs.filter((job) => job.name === 'publish-to-origin');
  need(
    origin.length === 1 && origin[0].status === 'completed' && origin[0].conclusion === 'success',
    'original origin job not successful'
  );
  const steps = (origin[0].steps ?? []).filter(
    (step) => step.name === 'Verify the origin serves this bundle'
  );
  need(
    steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success',
    'original artifact publication not verified'
  );
  return { run_id: id, run_attempt: run.run_attempt, origin_job_id: origin[0].id };
}
export async function proveExistingArtifact({
  expected,
  readPublic = publicDocuments,
  readNative,
  priorPublication,
}) {
  const before = await readPublic();
  const source = sourceOf(before);
  if (expected) need(expected.source_sha === source, 'retained source changed');
  const first = await readNative(source);
  const identity = bindDocuments(before, first);
  if (expected)
    need(
      JSON.stringify(identity) === JSON.stringify(nativeIdentity(expected)),
      'retained artifact changed'
    );
  const publication = await priorPublication(first);
  const after = await readPublic();
  const second = await readNative(source);
  need(
    JSON.stringify(bindDocuments(after, second)) === JSON.stringify(identity),
    'native artifact changed during proof'
  );
  return { native: second, publication, observed_at: new Date().toISOString() };
}
