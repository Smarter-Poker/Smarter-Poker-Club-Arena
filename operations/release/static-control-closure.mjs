import { createHash } from 'node:crypto';
import {
  requireCertificate as need,
  fullSha,
  sameFacts,
  factDigest,
} from './component-certificate.mjs';

// Versioned, reviewed execution/read closure of the existing static writer.
// This list is an installation contract, not a caller-extensible allowlist or
// an inferred import graph. The workflow hash covers every inline host command,
// checkout, third-party action and privilege boundary. Its build inputs remain
// candidate inputs; they cannot change this privileged closure without upgrade.
export const staticControlFiles = Object.freeze(
  [
    '.github/workflows/publish-club-arena.yml',
    'operations/release/adapters/github-static.mjs',
    'operations/release/adapters/github.mjs',
    'operations/release/certification-client.mjs',
    'operations/release/component-certificate.mjs',
    'operations/release/frontend-artifact-proof.mjs',
    'operations/release/native/read-native-frontend.py',
    'operations/release/operation-policy.mjs',
    'operations/release/operationPolicy.json',
    'operations/release/static-control-closure.mjs',
    'scripts/ci/classify-club-arena-components.mjs',
    'scripts/ci/classify-engine-release.mjs',
    'scripts/ci/production-e2e-provenance.mjs',
    'scripts/ci/prove-retained-frontend.mjs',
    'scripts/ci/read-native-frontend.py',
    'scripts/ci/static-publication-journal.mjs',
  ].sort()
);
const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const digest = /^[0-9a-f]{64}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blobHash = (bytes) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function staticControlReceipt({ sourceSha, repositoryId, files }) {
  need(fullSha.test(sourceSha) && /^[1-9][0-9]*$/.test(String(repositoryId)));
  need(
    sameFacts(Object.keys(files).sort(), staticControlFiles),
    'RELEASE_STATIC_CONTROL_FILE_SET_REFUSED'
  );
  const entries = staticControlFiles.map((name) => {
    const file = files[name];
    need(
      Buffer.isBuffer(file.bytes) &&
        file.bytes.length > 0 &&
        file.bytes.length <= 1024 * 1024 &&
        ['100644', '100755'].includes(file.mode),
      'RELEASE_STATIC_CONTROL_FILE_REFUSED'
    );
    return {
      path: name,
      mode: file.mode,
      bytes: file.bytes.length,
      git_blob_sha: blobHash(file.bytes),
      sha256: hash(file.bytes),
    };
  });
  const body = {
    version: 1,
    purpose: 'club-arena-static-control',
    repository,
    repository_id: String(repositoryId),
    source_sha: sourceSha,
    files: entries,
  };
  return { ...body, digest: factDigest(body) };
}

export function validateStaticControlReceipt(receipt) {
  need(
    receipt?.version === 1 &&
      receipt.purpose === 'club-arena-static-control' &&
      receipt.repository === repository &&
      fullSha.test(receipt.source_sha) &&
      /^[1-9][0-9]*$/.test(receipt.repository_id) &&
      Array.isArray(receipt.files) &&
      sameFacts(
        receipt.files.map((f) => f.path),
        staticControlFiles
      ),
    'RELEASE_STATIC_CONTROL_RECEIPT_REQUIRED'
  );
  for (const file of receipt.files)
    need(
      sameFacts(Object.keys(file).sort(), ['bytes', 'git_blob_sha', 'mode', 'path', 'sha256']) &&
        ['100644', '100755'].includes(file.mode) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        file.bytes <= 1024 * 1024 &&
        fullSha.test(file.git_blob_sha) &&
        digest.test(file.sha256),
      'RELEASE_STATIC_CONTROL_RECEIPT_REQUIRED'
    );
  const { digest: claimed, ...body } = receipt;
  need(
    sameFacts(Object.keys(body).sort(), [
      'files',
      'purpose',
      'repository',
      'repository_id',
      'source_sha',
      'version',
    ]) && claimed === factDigest(body),
    'RELEASE_STATIC_CONTROL_RECEIPT_REQUIRED'
  );
  return receipt;
}

// Reads exact immutable Git objects, with two fresh main/repository/workflow
// reads around them. githubTransport enforces no-cache, no redirects and bounded
// bodies. Nothing checks out source or executes a source-supplied dependency.
export async function proveStaticControl({ request, installedReceipt, sourceSha, workflowId }) {
  const installed = validateStaticControlReceipt(installedReceipt);
  need(fullSha.test(sourceSha) && Number.isSafeInteger(workflowId) && workflowId > 0);
  const prefix = `/repos/${repository}`;
  async function current() {
    const repo = await request(prefix);
    const ref = await request(`${prefix}/git/ref/heads/main`);
    const workflow = await request(`${prefix}/actions/workflows/${workflowId}`);
    need(
      String(repo.id) === installed.repository_id &&
        repo.full_name === repository &&
        repo.default_branch === 'main' &&
        ref.ref === 'refs/heads/main' &&
        ref.object?.type === 'commit' &&
        ref.object.sha === sourceSha &&
        workflow.id === workflowId &&
        workflow.path === staticControlFiles[0] &&
        workflow.state === 'active',
      'RELEASE_STATIC_DEFAULT_CONTROL_CHANGED'
    );
  }
  await current();
  const commit = await request(`${prefix}/git/commits/${sourceSha}`);
  need(
    commit.sha === sourceSha && fullSha.test(commit.tree?.sha),
    'RELEASE_STATIC_CONTROL_COMMIT_REFUSED'
  );
  const trees = new Map();
  async function tree(sha) {
    if (!trees.has(sha)) {
      const value = await request(`${prefix}/git/trees/${sha}`);
      need(
        value.sha === sha &&
          value.truncated === false &&
          Array.isArray(value.tree) &&
          value.tree.length <= 10000,
        'RELEASE_STATIC_CONTROL_TREE_REFUSED'
      );
      trees.set(sha, value.tree);
    }
    return trees.get(sha);
  }
  for (const file of installed.files) {
    let treeSha = commit.tree.sha;
    const parts = file.path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entries = (await tree(treeSha)).filter((entry) => entry.path === parts[i]);
      need(entries.length === 1, 'RELEASE_STATIC_CONTROL_FILE_MISSING');
      const [entry] = entries;
      if (i < parts.length - 1) {
        need(
          entry.type === 'tree' && entry.mode === '040000' && fullSha.test(entry.sha),
          'RELEASE_STATIC_CONTROL_TREE_REFUSED'
        );
        treeSha = entry.sha;
      } else {
        need(
          entry.type === 'blob' && entry.mode === file.mode && entry.sha === file.git_blob_sha,
          'RELEASE_STATIC_CONTROL_UPGRADE_REQUIRED'
        );
        const blob = await request(`${prefix}/git/blobs/${entry.sha}`);
        need(
          blob.sha === entry.sha &&
            blob.encoding === 'base64' &&
            typeof blob.content === 'string' &&
            blob.size === file.bytes &&
            blob.content.length <= 1500000,
          'RELEASE_STATIC_CONTROL_BLOB_REFUSED'
        );
        const bytes = Buffer.from(blob.content, 'base64');
        need(
          bytes.length === file.bytes &&
            blobHash(bytes) === file.git_blob_sha &&
            hash(bytes) === file.sha256,
          'RELEASE_STATIC_CONTROL_UPGRADE_REQUIRED'
        );
      }
    }
  }
  await current();
  return {
    version: 1,
    installed_control_sha: installed.source_sha,
    control_sha: sourceSha,
    repository_id: installed.repository_id,
    workflow_id: workflowId,
    closure_digest: installed.digest,
    file_count: installed.files.length,
  };
}
