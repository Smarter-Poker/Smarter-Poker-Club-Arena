import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import {
  VercelPromoteAdapter,
  vercelTransport,
} from '../../operations/release/adapters/vercel.mjs';
import {
  HetznerIntakeAdapter,
  engineTransport,
} from '../../operations/release/adapters/hetzner.mjs';

test('native HTTP response loss performs one POST; redirects cannot forward credentials', async () => {
  let posts = 0;
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === '/lost') {
      posts++;
      request.resume();
      request.on('end', () => request.socket.destroy());
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: '/secret-destination' });
      response.end();
    } else {
      redirected++;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const transport = vercelTransport('isolated-test-token', (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.vercel.com');
      return fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options);
    });
    await assert.rejects(transport('/lost', { method: 'POST', body: {} }));
    assert.equal(posts, 1);
    await assert.rejects(transport('/redirect'));
    assert.equal(redirected, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function vercelFixture(change = {}) {
  const request = {
    target: 'world-hub-web',
    project_id: 'prj_one',
    team_id: 'team_one',
    deployment_id: 'dpl_new',
    source_sha: 'a'.repeat(40),
    manifest_digest: 'b'.repeat(64),
    domains: ['smarter.poker', 'www.smarter.poker'],
    expected_current: { deployment_id: 'dpl_old', last_alias_requested_at: 10 },
  };
  const state = {
    target: 'production',
    readyState: 'READY',
    readySubstate: 'STAGED',
    current: 'dpl_old',
    autoAssignCustomDomains: false,
    last: {
      type: 'promote',
      fromDeploymentId: 'dpl_before',
      toDeploymentId: 'dpl_old',
      requestedAt: 10,
      jobStatus: 'succeeded',
    },
    ...change,
  };
  let posts = 0;
  const adapter = new VercelPromoteAdapter({
    projectId: 'prj_one',
    teamId: 'team_one',
    domains: request.domains,
    request: async (url, options) => {
      if (options?.method === 'POST') {
        posts++;
        return { status: 202 };
      }
      if (url.includes('/domains?'))
        return {
          domains: (state.inventory ?? request.domains).map((name) => ({
            name,
            projectId: 'prj_one',
            verified: true,
          })),
          pagination: { next: state.nextPage ?? null },
        };
      if (url.startsWith('/v9/'))
        return {
          id: 'prj_one',
          accountId: 'team_one',
          autoAssignCustomDomains: state.autoAssignCustomDomains,
          targets: { production: { id: state.current } },
          lastAliasRequest: state.last,
          rollingRelease: state.rollingRelease,
        };
      if (url.startsWith('/v13/'))
        return {
          id: 'dpl_new',
          projectId: 'prj_one',
          ownerId: 'team_one',
          target: state.target,
          readyState: state.readyState,
          readySubstate: state.readySubstate,
          meta: { githubCommitSha: request.source_sha },
        };
      const domain = decodeURIComponent(url.split('/').pop().split('?')[0]);
      return {
        alias: domain,
        projectId: 'prj_one',
        deploymentId: state.current,
        deployment: { id: state.current },
      };
    },
  });
  return { request, state, adapter, count: () => posts };
}
test('preview, auto-domain assignment, rolling release and stale prior production cannot promote', async () => {
  for (const change of [
    { target: null },
    { autoAssignCustomDomains: true },
    { rollingRelease: { stages: [] } },
    { current: 'dpl_foreign' },
    { inventory: ['smarter.poker', 'www.smarter.poker', 'unqualified.example'] },
    { nextPage: 123 },
  ]) {
    const f = vercelFixture(change);
    await assert.rejects(f.adapter.preflight(f.request));
    assert.equal(f.count(), 0);
  }
  const f = vercelFixture();
  await f.adapter.preflight(f.request);
  assert.equal((await f.adapter.submit(f.request)).terminal, false);
  assert.equal(f.count(), 1);
});
test('failed exact promotion is terminal, old/foreign/skipped/pending promotion never is', async () => {
  const f = vercelFixture();
  for (const last of [
    null,
    f.state.last,
    {
      type: 'promote',
      fromDeploymentId: 'dpl_other',
      toDeploymentId: 'dpl_new',
      requestedAt: 20,
      jobStatus: 'succeeded',
    },
    ...['pending', 'in-progress', 'skipped'].map((jobStatus) => ({
      type: 'promote',
      fromDeploymentId: 'dpl_old',
      toDeploymentId: 'dpl_new',
      requestedAt: 20,
      jobStatus,
    })),
  ]) {
    f.state.last = last;
    assert.equal((await f.adapter.reconcile(f.request)).terminal, false);
  }
  f.state.last = {
    type: 'promote',
    fromDeploymentId: 'dpl_old',
    toDeploymentId: 'dpl_new',
    requestedAt: 20,
    jobStatus: 'failed',
  };
  assert.equal((await f.adapter.reconcile(f.request)).outcome, 'FAILED');
});

test('real child-process transport uses a fixed command, exact envelope and sanitizes noisy host errors', async () => {
  let sent;
  const transport = engineTransport('existing-engine-alias', (executable, args, options) => {
    assert.equal(executable, '/usr/bin/ssh');
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.equal(
      args.at(-1),
      '/usr/local/lib/club-arena-release-controller/engine-boundary.py preflight'
    );
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' });
    sent = args;
    return spawn(
      process.execPath,
      [
        '-e',
        "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{process.stderr.write('secret-like-error-must-not-escape');process.stdout.write(JSON.stringify({received:JSON.parse(s)}));})",
      ],
      options
    );
  });
  const result = await transport('preflight', {
    operation_id: 'fixture-id',
    request: { actor: 'literal $(not a shell)' },
  });
  assert.equal(result.received.request.actor, 'literal $(not a shell)');
  assert.ok(sent);
  assert.throws(() => engineTransport('-oProxyCommand=bad'));
});
test('engine intake acceptance never releases barrier; exact immutable image and run are required', async () => {
  const request = {
    target: 'club-arena-engine',
    source_sha: 'a'.repeat(40),
    control_sha: 'c'.repeat(40),
    manifest_digest: 'f'.repeat(64),
    run_key: '34611012800-1',
    server_tree_sha: 'e'.repeat(40),
    artifact_image_id: 'sha256:' + 'd'.repeat(64),
    actor: 'test-controller',
    not_after_epoch: 1999999999,
    expected_current: { source_sha: 'b'.repeat(40), image_id: 'sha256:' + 'b'.repeat(64) },
  };
  const operation = { id: 'a'.repeat(36), epoch: 'b'.repeat(36) };
  let response = {
    terminal: false,
    operation_id: operation.id,
    run_key: request.run_key,
    source_sha: request.source_sha,
    control_sha: request.control_sha,
  };
  const actions = [];
  const adapter = new HetznerIntakeAdapter({
    controlSha: request.control_sha,
    request: async (action) => {
      actions.push(action);
      return action === 'resume-acceptance'
        ? { accepted: true, requires_readback: true }
        : response;
    },
  });
  assert.equal((await adapter.submit(request, operation)).terminal, false);
  assert.equal((await adapter.reconcile(request, operation)).terminal, false);
  response.acceptance_state = 'PARTIAL';
  actions.length = 0;
  assert.equal(
    (await adapter.reconcile(request, operation)).reason,
    'EXISTING_NATIVE_ACCEPTANCE_AWAITS_EXECUTE'
  );
  assert.deepEqual(actions, ['observe']);
  await assert.rejects(
    adapter.reconcile(request, operation, {
      execute: true,
      beforeEffect: async () => {
        throw new Error('execution disabled');
      },
    }),
    /execution disabled/
  );
  assert.deepEqual(actions, ['observe', 'observe']);
  await adapter.reconcile(request, operation, {
    execute: true,
    beforeEffect: async () => {
      actions.push('fence');
    },
  });
  assert.deepEqual(actions.slice(-3), ['observe', 'fence', 'resume-acceptance']);
  response = {
    ...response,
    terminal: true,
    outcome: 'SUCCEEDED',
    image_id: request.artifact_image_id,
    result: 'sealed',
  };
  assert.equal((await adapter.reconcile(request, operation)).outcome, 'SUCCEEDED');
  response.image_id = 'sha256:' + 'a'.repeat(64);
  await assert.rejects(adapter.reconcile(request, operation));
});
