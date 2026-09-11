import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import {
  GitHubMergeAdapter,
  GitHubWorkflowAdapter,
  githubTransport,
  readReceiptArchive,
} from '../../operations/release/adapters/github.mjs';
import { verifiedDelivery } from '../../operations/release/event-admission.mjs';
const sha = (s) => s.repeat(40),
  repo = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const config = {
  repo,
  controlRef: 'heads/release-control',
  controlSha: sha('c'),
  workflowId: 123,
  runtimeImage: `node:22-slim@sha256:${'e'.repeat(64)}`,
};
const request = {
  repository: repo,
  phase: 'VALIDATION',
  target: 'club-arena-engine',
  source_sha: sha('e'),
  accepted_head_sha: sha('a'),
  expected_base_sha: sha('b'),
  tested_tree_sha: sha('1'),
  manifest_digest: 'd'.repeat(64),
  control_sha: config.controlSha,
  workflow_id: config.workflowId,
  runtime_image: config.runtimeImage,
  components: ['club-arena-engine'],
};
function zip(proof) {
  const name = Buffer.from('receipt.json'),
    body = Buffer.from(JSON.stringify(proof));
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const offset = local.length + name.length + body.length;
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('GitHub current dispatch ID is evidence, lost ID cannot trigger resend; exact operation receipt and immutable artifact are required', async () => {
  const op = { id: randomUUID(), created_at: new Date().toISOString() };
  const proof = {
    operation_id: op.id,
    control_sha: config.controlSha,
    run_id: '567',
    success: true,
    request,
  };
  let bytes = zip(proof),
    count = 0,
    duplicates = false,
    attempt = 1;
  const run = () => ({
    id: 567,
    workflow_id: config.workflowId,
    head_sha: config.controlSha,
    display_title: `release:${op.id}:VALIDATION`,
    event: 'workflow_dispatch',
    path: '.github/workflows/release-candidate.yml',
    status: 'completed',
    conclusion: 'success',
    run_attempt: attempt,
  });
  const adapter = new GitHubWorkflowAdapter({
    ...config,
    request: async (path, options) => {
      if (options?.method === 'POST') {
        count++;
        return { workflow_run_id: 567 };
      }
      if (path.includes('/git/ref/')) return { object: { sha: config.controlSha } };
      if (path.endsWith('/workflows/123'))
        return { id: 123, state: 'active', path: '.github/workflows/release-candidate.yml' };
      if (path.includes('/workflows/123/runs?'))
        return {
          total_count: duplicates ? 2 : 1,
          workflow_runs: duplicates ? [run(), run()] : [run()],
        };
      if (path.includes('/runs/567/artifacts'))
        return {
          total_count: 1,
          artifacts: [
            { id: 999, name: `release-receipt-${op.id}`, digest: hash(bytes), expired: false },
          ],
        };
      if (path.endsWith('/999/zip')) return bytes;
      throw new Error('unexpected endpoint');
    },
  });
  await adapter.preflight(request);
  assert.equal((await adapter.submit(request, op)).provider_operation_id, '567');
  assert.equal((await adapter.reconcile(request, op)).outcome, 'SUCCEEDED');
  duplicates = true;
  assert.equal((await adapter.reconcile(request, op)).terminal, false);
  duplicates = false;
  attempt = 2;
  assert.equal((await adapter.reconcile(request, op)).terminal, false);
  attempt = 1;
  bytes = zip({ ...proof, request: { ...request, source_sha: sha('9') } });
  await assert.rejects(adapter.reconcile(request, op), /RELEASE_GITHUB_CONTRACT_REFUSED/);
  assert.equal(count, 1);
});

test('merge verifies exact prospective parents and tree, then refuses a merged result from another base', async () => {
  let base = sha('b'),
    merged = false;
  const adapter = new GitHubMergeAdapter({
    repo,
    request: async (path) =>
      path.includes('/pulls/')
        ? {
            number: 42,
            state: 'open',
            merged,
            draft: false,
            mergeable: true,
            base: { sha: base, ref: 'main', repo: { full_name: repo } },
            head: { sha: sha('a') },
            merge_commit_sha: sha('e'),
          }
        : {
            sha: sha('e'),
            tree: { sha: sha('1') },
            parents: merged ? [{ sha: base }] : [{ sha: base }, { sha: sha('a') }],
          },
  });
  const r = { ...request, pr: 42 };
  await adapter.preflight(r);
  base = sha('9');
  await assert.rejects(adapter.preflight(r));
  merged = true;
  assert.equal((await adapter.reconcile(r)).outcome, 'FAILED');
  base = sha('b');
  assert.equal((await adapter.reconcile(r)).outcome, 'SUCCEEDED');
});

test('authenticated GitHub delivery rejects tampering, wrong event and mismatched repository before admission', () => {
  const secret = Buffer.from('fixture-only-secret-that-is-not-installed');
  const body = Buffer.from(
    JSON.stringify({
      action: 'release_intent',
      repository: { full_name: repo },
      sender: { id: 1 },
      client_payload: { client_key: 'key', intent: { repository: repo } },
    })
  );
  const headers = {
    'x-github-event': 'repository_dispatch',
    'x-github-delivery': randomUUID(),
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  };
  assert.equal(verifiedDelivery({ body, headers, secret, repositories: [repo] }).client_key, 'key');
  assert.throws(() =>
    verifiedDelivery({
      body: Buffer.concat([body, Buffer.from(' ')]),
      headers,
      secret,
      repositories: [repo],
    })
  );
  assert.throws(() =>
    verifiedDelivery({
      body,
      headers: { ...headers, 'x-github-event': 'push' },
      secret,
      repositories: [repo],
    })
  );
  assert.throws(() => verifiedDelivery({ body, headers, secret, repositories: ['another/repo'] }));
});

test('authenticated transport never follows an API redirect or retries a mutation, archive digest mismatch is refused', async () => {
  let calls = 0;
  const transport = githubTransport('native-fixture-token', async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } });
  });
  await assert.rejects(transport(`/repos/${repo}/pulls/42/merge`, { method: 'PUT', body: {} }));
  assert.equal(calls, 1);
  await assert.rejects(transport(`/repos/${repo}/actions/artifacts/1/zip`, { archive: true }));
  const bytes = zip({});
  assert.throws(() => readReceiptArchive(bytes, `sha256:${'0'.repeat(64)}`));
});
