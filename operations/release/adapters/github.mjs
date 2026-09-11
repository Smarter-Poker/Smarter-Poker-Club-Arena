import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const uuid = /^[0-9a-f-]{36}$/;
const refuse = () => {
  throw new Error('RELEASE_GITHUB_CONTRACT_REFUSED');
};
const need = (condition) => {
  if (!condition) refuse();
};
const pending = (reason) => ({ terminal: false, reason });

// No redirects or automatic retries on authenticated API calls. Error bodies
// and signed archive locations are never journal evidence.
export function githubTransport(token, fetcher = fetch) {
  need(typeof token === 'string' && token.length > 0);
  return async (route, { method = 'GET', body, archive = false } = {}) => {
    need(route.startsWith('/repos/') && !route.includes('..'));
    const response = await fetcher(`https://api.github.com${route}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (archive) {
      need(method === 'GET' && response.status === 302);
      const location = new URL(response.headers.get('location'));
      need(
        location.protocol === 'https:' &&
          !location.username &&
          !location.password &&
          (location.hostname.endsWith('.blob.core.windows.net') ||
            location.hostname.endsWith('.actions.githubusercontent.com'))
      );
      // An ephemeral GitHub artifact URL receives no GitHub token.
      const download = await fetcher(location, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      need(download.ok);
      return boundedBody(download, 2 * 1024 * 1024);
    }
    need(response.ok);
    if (response.status === 204) return { status: 204 };
    const bytes = await boundedBody(response, 2 * 1024 * 1024);
    return JSON.parse(bytes.toString('utf8'));
  };
}
async function boundedBody(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    need(size <= limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The receipt archive has one ordinary file, never an extracted filesystem.
export function readReceiptArchive(bytes, expectedDigest) {
  need(
    Buffer.isBuffer(bytes) &&
      bytes.length <= 2 * 1024 * 1024 &&
      expectedDigest === `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  );
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  need(end >= 0 && bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1);
  const central = bytes.readUInt32LE(end + 16);
  need(central + 46 <= end && bytes.readUInt32LE(central) === 0x02014b50);
  const flags = bytes.readUInt16LE(central + 8),
    method = bytes.readUInt16LE(central + 10);
  const compressed = bytes.readUInt32LE(central + 20),
    length = bytes.readUInt32LE(central + 24);
  const nameLength = bytes.readUInt16LE(central + 28),
    local = bytes.readUInt32LE(central + 42);
  need(
    (flags & 1) === 0 &&
      [0, 8].includes(method) &&
      length <= 65536 &&
      bytes.subarray(central + 46, central + 46 + nameLength).toString() === 'receipt.json' &&
      local + 30 <= central &&
      bytes.readUInt32LE(local) === 0x04034b50
  );
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  need(start + compressed <= central);
  const raw = bytes.subarray(start, start + compressed);
  const content = method === 8 ? inflateRawSync(raw, { maxOutputLength: 65536 }) : raw;
  need(content.length === length);
  return JSON.parse(content.toString('utf8'));
}

export class GitHubMergeAdapter {
  constructor({ repo, baseBranch = 'main', request, beforeMerge }) {
    need(repository.test(repo) && /^[A-Za-z0-9_./-]+$/.test(baseBranch));
    Object.assign(this, { repo, baseBranch, request, beforeMerge });
  }
  validate(r) {
    need(
      r?.repository === this.repo &&
        Number.isSafeInteger(r.pr) &&
        r.pr > 0 &&
        [r.accepted_head_sha, r.expected_base_sha, r.tested_tree_sha].every((v) => sha.test(v)) &&
        digest.test(r.manifest_digest)
    );
  }
  async readPR(pr) {
    return this.request(`/repos/${this.repo}/pulls/${pr}`);
  }
  async commit(id) {
    need(sha.test(id));
    return this.request(`/repos/${this.repo}/git/commits/${id}`);
  }
  async candidate(pr, head) {
    const p = await this.readPR(pr);
    need(
      p.number === pr &&
        p.state === 'open' &&
        p.merged === false &&
        p.draft === false &&
        p.base?.repo?.full_name === this.repo &&
        p.base.ref === this.baseBranch &&
        p.head?.sha === head &&
        p.mergeable === true &&
        sha.test(p.base.sha) &&
        sha.test(p.merge_commit_sha)
    );
    const c = await this.commit(p.merge_commit_sha);
    need(
      c.sha === p.merge_commit_sha &&
        sha.test(c.tree?.sha) &&
        c.parents?.length === 2 &&
        c.parents[0].sha === p.base.sha &&
        c.parents[1].sha === head
    );
    return {
      accepted_head_sha: head,
      expected_base_sha: p.base.sha,
      candidate_sha: c.sha,
      tested_tree_sha: c.tree.sha,
    };
  }
  async preflight(r) {
    this.validate(r);
    const c = await this.candidate(r.pr, r.accepted_head_sha);
    need(c.expected_base_sha === r.expected_base_sha && c.tested_tree_sha === r.tested_tree_sha);
    // Registered target-specific check (e.g. Vercel staged Git configuration)
    // is required by coordinator construction before any controlled merge.
    await this.beforeMerge?.(r);
    return c;
  }
  async submit(r) {
    this.validate(r);
    await this.request(`/repos/${this.repo}/pulls/${r.pr}/merge`, {
      method: 'PUT',
      body: { sha: r.accepted_head_sha, merge_method: 'squash' },
    });
    return pending('MERGE_RESPONSE_REQUIRES_EXACT_READBACK');
  }
  async reconcile(r) {
    this.validate(r);
    const p = await this.readPR(r.pr);
    if (
      p.number !== r.pr ||
      p.base?.repo?.full_name !== this.repo ||
      p.head?.sha !== r.accepted_head_sha
    )
      return pending('MERGE_SOURCE_IDENTITY_CHANGED');
    if (p.merged !== true) return pending('MERGE_NOT_TERMINALLY_PROVEN');
    if (!sha.test(p.merge_commit_sha)) return pending('MERGE_COMMIT_UNAVAILABLE');
    const c = await this.commit(p.merge_commit_sha);
    if (
      c.sha !== p.merge_commit_sha ||
      c.tree?.sha !== r.tested_tree_sha ||
      c.parents?.length !== 1 ||
      c.parents[0].sha !== r.expected_base_sha
    )
      return {
        terminal: true,
        outcome: 'FAILED',
        reason: 'MERGED_RESULT_DIFFERS_FROM_TESTED_BASE_TREE',
        merged_sha: p.merge_commit_sha,
      };
    return {
      terminal: true,
      outcome: 'SUCCEEDED',
      accepted_head_sha: r.accepted_head_sha,
      expected_base_sha: r.expected_base_sha,
      merged_sha: c.sha,
      merged_tree_sha: c.tree.sha,
    };
  }
}

export class GitHubWorkflowAdapter {
  constructor({
    repo,
    controlRef,
    controlSha,
    workflowId,
    workflowPath = '.github/workflows/release-candidate.yml',
    runtimeImage,
    request,
  }) {
    need(
      repository.test(repo) &&
        /^heads\/[A-Za-z0-9_./-]+$/.test(controlRef) &&
        sha.test(controlSha) &&
        Number.isSafeInteger(workflowId) &&
        workflowId > 0 &&
        ['.github/workflows/release-candidate.yml', '.github/workflows/post-deploy-e2e.yml'].includes(workflowPath) &&
        /^node:22[^@\s]*@sha256:[0-9a-f]{64}$/.test(runtimeImage)
    );
    Object.assign(this, {
      repo,
      controlRef,
      controlSha,
      workflowId,
      workflowPath,
      runtimeImage,
      request,
    });
  }
  validate(r) {
    need(
      r?.repository === this.repo &&
        ['VALIDATION', 'BUILD'].includes(r.phase) &&
        sha.test(r.source_sha) &&
        sha.test(r.expected_base_sha) &&
        sha.test(r.accepted_head_sha) &&
        sha.test(r.tested_tree_sha) &&
        digest.test(r.manifest_digest) &&
        Array.isArray(r.components) &&
        r.components.length === 1 &&
        new Set(r.components).size === r.components.length &&
        r.components.every((c) => c === 'club-arena-engine') &&
        r.control_sha === this.controlSha &&
        r.workflow_id === this.workflowId &&
        r.runtime_image === this.runtimeImage
    );
  }
  async preflight(r) {
    this.validate(r);
    const ref = await this.request(`/repos/${this.repo}/git/ref/${this.controlRef}`);
    const workflow = await this.request(`/repos/${this.repo}/actions/workflows/${this.workflowId}`);
    need(
      ref.object?.sha === this.controlSha &&
        workflow.id === this.workflowId &&
        workflow.path === this.workflowPath &&
        workflow.state === 'active'
    );
    return { control_sha: this.controlSha, workflow_id: this.workflowId };
  }
  async submit(r, operation) {
    this.validate(r);
    need(uuid.test(operation.id));
    const result = await this.request(
      `/repos/${this.repo}/actions/workflows/${this.workflowId}/dispatches`,
      {
        method: 'POST',
        body: {
          ref: this.controlRef.slice(6),
          inputs: {
            operation_id: operation.id,
            request: JSON.stringify(r),
          },
        },
      }
    );
    return {
      ...pending('WORKFLOW_ACCEPTED_AWAITING_TERMINAL_RESULT'),
      ...(Number.isSafeInteger(result.workflow_run_id)
        ? { provider_operation_id: String(result.workflow_run_id) }
        : {}),
    };
  }
  async reconcile(r, operation) {
    this.validate(r);
    need(uuid.test(operation.id));
    const list = await this.request(
      `/repos/${this.repo}/actions/workflows/${this.workflowId}/runs?event=workflow_dispatch&head_sha=${this.controlSha}&created=${encodeURIComponent(`>=${operation.created_at}`)}&per_page=100`
    );
    if (!Array.isArray(list.workflow_runs) || list.total_count > 100)
      return pending('WORKFLOW_CORRELATION_INVENTORY_INCOMPLETE');
    const found = list.workflow_runs.filter(
      (v) => v.display_title === `release:${operation.id}:${r.phase}`
    );
    if (found.length !== 1)
      return pending(
        found.length ? 'WORKFLOW_CORRELATION_DUPLICATED' : 'WORKFLOW_CORRELATION_NOT_YET_VISIBLE'
      );
    const run = found[0];
    if (
      run.workflow_id !== this.workflowId ||
      run.head_sha !== this.controlSha ||
      run.event !== 'workflow_dispatch' ||
      run.path !== this.workflowPath ||
      run.run_attempt !== 1 ||
      !Number.isSafeInteger(run.id)
    )
      return pending('WORKFLOW_EXECUTION_IDENTITY_MISMATCH');
    if (run.status !== 'completed')
      return { ...pending('WORKFLOW_RUNNING'), provider_operation_id: String(run.id) };
    if (run.conclusion !== 'success')
      return {
        terminal: true,
        outcome: run.conclusion === 'cancelled' ? 'CANCELLED' : 'FAILED',
        provider_operation_id: String(run.id),
        reason: 'WORKFLOW_COMPLETED_WITHOUT_SUCCESS',
      };
    const inventory = await this.request(
      `/repos/${this.repo}/actions/runs/${run.id}/artifacts?per_page=100`
    );
    if (!Array.isArray(inventory.artifacts) || inventory.total_count > 100)
      return pending('WORKFLOW_ARTIFACT_INVENTORY_INCOMPLETE');
    const receipts = inventory.artifacts.filter(
      (a) => a.name === `release-receipt-${operation.id}`
    );
    if (
      receipts.length !== 1 ||
      receipts[0].expired ||
      !/^sha256:[0-9a-f]{64}$/.test(receipts[0].digest)
    )
      return pending('WORKFLOW_RECEIPT_UNAVAILABLE');
    const artifact = receipts[0];
    const bytes = await this.request(`/repos/${this.repo}/actions/artifacts/${artifact.id}/zip`, {
      archive: true,
    });
    const proof = readReceiptArchive(bytes, artifact.digest);
    need(
      proof.operation_id === operation.id &&
        proof.control_sha === this.controlSha &&
        proof.run_id === String(run.id) &&
        proof.success === true &&
        JSON.stringify(proof.request) === JSON.stringify(r)
    );
    if (r.phase === 'BUILD') {
      need(
        proof.artifact &&
          proof.artifact.components &&
          Object.keys(proof.artifact.components).length === r.components.length
      );
      for (const target of r.components) {
        const a = proof.artifact.components[target];
        need(a && /^sha256:[0-9a-f]{64}$/.test(a.identity));
        const matches = inventory.artifacts.filter((v) => v.name === a.artifact_name);
        need(matches.length === 1 && !matches[0].expired);
        a.github_artifact_id = String(matches[0].id);
        a.github_archive_digest = matches[0].digest;
        a.github_archive_bytes = matches[0].size_in_bytes;
        a.build_operation_id = operation.id;
      }
    }
    return {
      terminal: true,
      outcome: 'SUCCEEDED',
      provider_operation_id: String(run.id),
      receipt_archive_digest: artifact.digest,
      receipt_artifact_id: String(artifact.id),
      proof,
    };
  }
}
