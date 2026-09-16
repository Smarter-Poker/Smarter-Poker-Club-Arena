import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { admitCurrentPrCi, githubPrReader } from '../../scripts/ci/admit-current-pr-ci.mjs';

const repo = {
  id: 1132369872,
  full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena',
};
const A = 'a'.repeat(40),
  B = 'b'.repeat(40);
function fixture(head = A) {
  const pr = {
    id: 1001,
    number: 42,
    state: 'open',
    base: { ref: 'main', repo: { ...repo } },
    head: { ref: 'fix/seat', sha: head, repo: { ...repo } },
  };
  return { repository: { ...repo }, number: 42, pull_request: pr };
}
function admit(event, live, options = {}) {
  return admitCurrentPrCi({
    eventName: 'pull_request',
    event,
    repositoryName: repo.full_name,
    readPr: async (number) => {
      assert.equal(number, 42);
      return live;
    },
    ...options,
  });
}

test('A -> B -> A admits the actual current head without stale memory', async () => {
  const event = fixture(A);
  assert.equal((await admit(event, fixture(A).pull_request)).admitted, true);
  await assert.rejects(admit(event, fixture(B).pull_request), /PR_CI_HEAD_SUPERSEDED/);
  assert.equal((await admit(event, fixture(A).pull_request)).admitted, true);
});
test('a delayed B event is refused when the PR has returned to A', async () => {
  await assert.rejects(admit(fixture(B), fixture(A).pull_request), /PR_CI_HEAD_SUPERSEDED/);
});
test('a delayed duplicate of the still-current head is fully tested again', async () => {
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await admit(fixture(), fixture().pull_request), {
      admitted: true,
      reason: 'current-pr-head',
    });
  }
});
test('each heavyweight job reads the live head afresh', async () => {
  let reads = 0;
  const readPr = async () => fixture(++reads === 1 ? A : B).pull_request;
  await admit(fixture(), null, { readPr });
  await assert.rejects(admit(fixture(), null, { readPr }), /PR_CI_HEAD_SUPERSEDED/);
  assert.equal(reads, 2);
});
test('an unreadable head fails once, without executing work or retrying', async () => {
  let reads = 0,
    worked = false;
  await assert.rejects(
    async () => {
      await admit(fixture(), null, {
        readPr: async () => {
          reads++;
          throw new Error('secret');
        },
      });
      worked = true;
    },
    { message: 'PR_CI_HEAD_UNREADABLE' }
  );
  assert.equal(reads, 1);
  assert.equal(worked, false);
});
test('schedule preserves full checks without any PR read', async () => {
  assert.deepEqual(
    await admit(null, null, {
      eventName: 'schedule',
      readPr: () => assert.fail('schedule read a PR'),
    }),
    { admitted: true, reason: 'scheduled-full-check' }
  );
});
for (const eventName of ['workflow_run', 'pull_request_target', 'workflow_dispatch', 'push', '']) {
  test(`unsupported ${eventName || 'empty'} event has no discovery or privileged fallback`, async () => {
    await assert.rejects(
      admit(fixture(), null, {
        eventName,
        readPr: () => assert.fail('unsupported event read a PR'),
      }),
      /PR_CI_EVENT_UNSUPPORTED/
    );
  });
}
const malformed = [
  [
    'repository name',
    (e) => {
      e.repository.full_name = 'attacker/repo';
    },
  ],
  [
    'repository ID',
    (e) => {
      e.repository.id++;
    },
  ],
  [
    'PR number mismatch',
    (e) => {
      e.number++;
    },
  ],
  [
    'PR identity absent',
    (e) => {
      delete e.pull_request.id;
    },
  ],
  [
    'source SHA absent',
    (e) => {
      delete e.pull_request.head.sha;
    },
  ],
  [
    'source SHA malformed',
    (e) => {
      e.pull_request.head.sha = 'main';
    },
  ],
  [
    'wrong base',
    (e) => {
      e.pull_request.base.ref = 'staging';
    },
  ],
  [
    'wrong head repository',
    (e) => {
      e.pull_request.head.repo.full_name = '../escape';
    },
  ],
];
for (const [name, mutate] of malformed) {
  test(`malformed event ${name} is refused before API access`, async () => {
    const e = fixture();
    mutate(e);
    await assert.rejects(
      admit(e, null, { readPr: () => assert.fail('invalid event read a PR') }),
      /PR_CI_EVENT_/
    );
  });
}
for (const [name, mutate] of [
  ['missing PR', () => null],
  ['different PR ID', (p) => ({ ...p, id: p.id + 1 })],
  ['closed PR', (p) => ({ ...p, state: 'closed' })],
  ['wrong base', (p) => ({ ...p, base: { ...p.base, ref: 'staging' } })],
  ['wrong repository', (p) => ({ ...p, head: { ...p.head, repo: { ...repo, id: repo.id + 1 } } })],
  ['changed branch', (p) => ({ ...p, head: { ...p.head, ref: 'different' } })],
  ['missing head SHA', (p) => ({ ...p, head: { ...p.head, sha: null } })],
]) {
  test(`live ${name} cannot become an explained skip or success`, async () => {
    await assert.rejects(admit(fixture(), mutate(fixture().pull_request)), /PR_CI_LIVE_/);
  });
}
test('fork PRs keep hosted read-only CI when the exact source fork agrees', async () => {
  const event = fixture();
  event.pull_request.head.repo = {
    id: 991,
    full_name: 'contributor/club-arena',
  };
  assert.equal((await admit(event, structuredClone(event.pull_request))).admitted, true);
  const changed = structuredClone(event.pull_request);
  changed.head.repo.id++;
  await assert.rejects(admit(event, changed), /PR_CI_LIVE_HEAD_INVALID/);
});
test('wrong workflow repository is refused even for scheduled checks', async () => {
  await assert.rejects(
    admit(null, null, { eventName: 'schedule', repositoryName: 'other/repo' }),
    /PR_CI_REPOSITORY_INVALID/
  );
});
test('transport uses exactly one cache-revalidated GET at the fixed GitHub host', async () => {
  let calls = 0;
  const reader = githubPrReader('synthetic-token', async (url, options) => {
    calls++;
    assert.equal(url, `https://api.github.com/repos/${repo.full_name}/pulls/42`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(fixture().pull_request));
  });
  assert.deepEqual(await reader(42), fixture().pull_request);
  assert.equal(calls, 1);
});
for (const [name, response] of [
  ['403', () => new Response('private diagnostic', { status: 403 })],
  ['malformed JSON', () => new Response('{')],
  ['oversized JSON', () => new Response(' '.repeat(1024 * 1024 + 1))],
  [
    'network failure',
    () => {
      throw new Error('private diagnostic');
    },
  ],
]) {
  test(`transport ${name} fails closed without exposing response values or retrying`, async () => {
    let calls = 0;
    const reader = githubPrReader('synthetic-token', async () => {
      calls++;
      return response();
    });
    await assert.rejects(reader(42), { message: 'PR_CI_READ_FAILED' });
    assert.equal(calls, 1);
  });
}
test('missing token cannot use another credential or access route', async () => {
  await assert.rejects(
    githubPrReader('', () => assert.fail('network read'))(42),
    /PR_CI_READ_CONTEXT_INVALID/
  );
});
test('CLI context refusal exits nonzero, so skipped work cannot satisfy a check', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../../scripts/ci/admit-current-pr-ci.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      env: { GITHUB_EVENT_NAME: 'schedule', GITHUB_REPOSITORY: 'other/repo' },
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PR_CI_REPOSITORY_INVALID/);
  assert.equal(result.stdout, '');
});

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, name);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/^  [A-Za-z_][A-Za-z_0-9-]*:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
for (const name of [
  'typecheck_compile',
  'unit_shards',
  'accounting_postgres',
  'server_shards',
  'build',
  'css-beats-e2e',
]) {
  test(`${name} admits before dependency setup on the local read-only runner`, () => {
    const source = job(name),
      start = source.indexOf('- name: Admit only the current PR head');
    assert.ok(start > source.indexOf('uses: actions/checkout@'));
    assert.ok(start < source.indexOf('- name: Setup Node'));
    assert.match(source, /^    runs-on: \[self-hosted, smarter-local-linux-arm64\]$/m);
    assert.match(source, /permissions:\n      contents: read\n      pull-requests: read/);
    const gate = source.slice(start, source.indexOf('- name: Setup Node'));
    assert.match(gate, /working-directory: \./);
    assert.match(gate, /run: node scripts\/ci\/admit-current-pr-ci\.mjs/);
    assert.doesNotMatch(gate, /continue-on-error|\bif:|\|\| true|\bwrite\b/);
  });
}
test('every required workflow job uses its exact local architecture without a hosted fallback', () => {
  for (const name of ['ci', 'silent-revert-guard', 'component-fixture-native-smoke']) {
    const source = readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      'utf8'
    );
    const jobs = source.slice(source.indexOf('\njobs:\n') + 7);
    const entries = [...jobs.matchAll(/^  ([A-Za-z_][A-Za-z_0-9-]*):\s*$/gm)];
    assert.ok(entries.length > 0, `${name} declares jobs`);
    for (let i = 0; i < entries.length; i++) {
      const body = jobs.slice(entries[i].index, entries[i + 1]?.index);
      if (/^    uses:/m.test(body)) {
        assert.equal(name, 'ci');
        assert.equal(entries[i][1], 'fixture_native');
        assert.match(
          body,
          /^    uses: \.\/\.github\/workflows\/component-fixture-native-smoke\.yml$/m
        );
      } else {
        assert.match(
          body,
          name === 'component-fixture-native-smoke'
            ? /^    runs-on: \[self-hosted, smarter-local-linux-amd64\]$/m
            : /^    runs-on: \[self-hosted, smarter-local-linux-arm64\]$/m,
          `${name}/${entries[i][1]} must wait for the matching local architecture`
        );
      }
    }
  }
});
test('required TypeScript gate still requires the actual compilation result', () => {
  assert.match(job('typecheck'), /needs: \[typecheck_compile, changes, fixture_native\]/);
  assert.match(job('typecheck'), /COMPILE_RESULT: \$\{\{ needs.typecheck_compile.result \}\}/);
  assert.match(job('typecheck'), /run: node scripts\/ci\/fixture-native-gate.mjs/);
});
test('shard one owns repeated server checks while every full partition remains required', () => {
  const source = job('server_shards');
  const steps = source.split(/^ {6}- name: /m).slice(1);
  const step = (name) => {
    const found = steps.find((body) => body.startsWith(`${name}\n`));
    assert.ok(found, name);
    return found;
  };
  for (const [name, command] of [
    ['TypeScript Check (server)', 'npx tsc --noEmit'],
    [
      'Freeze + watchdog + restart-gate regression suite',
      'npx vitest run src/engine/FreezeRegression.test.ts src/engine/TableWatchdog.test.ts src/maintenance/MaintenanceBreak.test.ts src/maintenance/thawInstallments.test.ts --reporter=verbose',
    ],
  ]) {
    const body = step(name);
    assert.match(body, /^        if: matrix\.shard == 1$/m);
    assert.ok(body.includes(`        run: ${command}\n`));
  }
  assert.match(source, /^        shard: \[1, 2, 3, 4\]$/m);
  assert.match(source, /^      fail-fast: false$/m);
  assert.doesNotMatch(source, /^\s*(?:include|exclude|continue-on-error):/m);
  const full = step('Full server test suite');
  assert.doesNotMatch(full, /^        if:/m);
  assert.match(full, /^          SERVER_TEST_SHARD: \$\{\{ matrix\.shard \}\}$/m);
  assert.match(full, /^          npm test -- --shard="\$SERVER_TEST_SHARD\/4"$/m);
  assert.match(job('server'), /^    needs: \[changes, server_shards\]$/m);
  assert.match(job('server'), /^    if: always\(\)$/m);
  assert.match(job('server'), /MATRIX_RESULT: \$\{\{ needs\.server_shards\.result \}\}/);
});
test('admission refusal cannot trigger fail-fast cancellation of running siblings', () => {
  assert.match(job('unit_shards'), /fail-fast: false/);
  assert.match(job('server_shards'), /fail-fast: false/);
});
function shell(jobName) {
  const source = job(jobName),
    marker = '        run: |\n';
  assert.ok(source.includes(marker));
  return source
    .slice(source.indexOf(marker) + marker.length)
    .split('\n')
    .filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10))
    .join('\n');
}
for (const result of ['failure', 'cancelled']) {
  test(`actual client aggregate refuses ${result} from a refused admission shard`, () => {
    const script = shell('unit').replace('${{ needs.unit_shards.result }}', result);
    assert.throws(() =>
      execFileSync('/bin/bash', ['-c', script], {
        stdio: 'pipe',
        env: { GITHUB_STEP_SUMMARY: '/dev/null' },
      })
    );
  });
  test(`actual server aggregate refuses ${result} from a refused admission shard`, () => {
    assert.throws(() =>
      execFileSync('/bin/bash', ['-c', shell('server')], {
        stdio: 'pipe',
        env: {
          MATRIX_RESULT: result,
          DIFF_RESULT: 'success',
          SERVER_CHANGED: 'true',
          CI_EVENT_NAME: 'pull_request',
        },
      })
    );
  });
}
test('actual server aggregate rejects unexplained skip on affected source', () => {
  assert.throws(() =>
    execFileSync('/bin/bash', ['-c', shell('server')], {
      stdio: 'pipe',
      env: {
        MATRIX_RESULT: 'skipped',
        DIFF_RESULT: 'success',
        SERVER_CHANGED: 'true',
        CI_EVENT_NAME: 'pull_request',
      },
    })
  );
});
test('successful current-head shards retain both required passing aggregates', () => {
  execFileSync(
    '/bin/bash',
    ['-c', shell('unit').replace('${{ needs.unit_shards.result }}', 'success')],
    { stdio: 'pipe', env: { GITHUB_STEP_SUMMARY: '/dev/null' } }
  );
  execFileSync('/bin/bash', ['-c', shell('server')], {
    stdio: 'pipe',
    env: { MATRIX_RESULT: 'success' },
  });
});

// The first local ARM run failed before exercising any journal transaction:
// its default embedded runtime only exists for Linux x64. Use the same PG17
// provider as the other real-database jobs without changing the probe itself.
test('the journal gate uses the installed PostgreSQL 17 provider', () => {
  const body = job('typecheck_compile');
  const step = body
    .split('      - name: Chip journal transactions survive failures and replays\n')[1]
    ?.split(/\n      - /)[0];
  assert.ok(step);
  assert.match(step, /^        env:\n          PGBIN: \/usr\/lib\/postgresql\/17\/bin$/m);
  assert.match(
    step,
    /^        run: bash scripts\/ci\/probes\/chip-journal-atomicity\/run-isolated\.sh$/m
  );
  assert.doesNotMatch(step, /continue-on-error/);
  const condition = step.match(/^        if: (.+)$/m)?.[1];
  assert.equal(
    condition,
    "needs.changes.result != 'success' || needs.changes.outputs.server != 'false'"
  );
  const shouldRun = new Function('needs', `return (${condition});`);
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '', undefined]) {
    for (const server of ['true', 'false', '', 'unknown', undefined]) {
      assert.equal(
        shouldRun({ changes: { result, outputs: { server } } }),
        !(result === 'success' && server === 'false'),
        `${result}/${server}`
      );
    }
  }
});

test('classification failure cannot skip compilation, but workflow cancellation does', () => {
  const body = job('typecheck_compile');
  assert.match(body, /^    needs: changes$/m);
  const condition = body.match(/^    if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.equal(condition, "!cancelled() && github.event_name == 'pull_request'");
  const shouldCompile = new Function('cancelled', 'github', 'needs', `return (${condition});`);
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '', undefined]) {
    const needs = { changes: { result } };
    assert.equal(
      shouldCompile(() => false, { event_name: 'pull_request' }, needs),
      true
    );
    assert.equal(
      shouldCompile(() => true, { event_name: 'pull_request' }, needs),
      false
    );
    assert.equal(
      shouldCompile(() => false, { event_name: 'push' }, needs),
      false
    );
  }
  const compile = body.split('      - name: TypeScript Check\n')[1]?.split(/\n      - /)[0];
  assert.ok(compile);
  assert.doesNotMatch(compile, /if:|continue-on-error/);
  assert.match(compile, /npx tsc --noEmit/);
  assert.match(compile, /npx tsc -p tsconfig.node.json --noEmit/);
});

test('installed dependency caches cannot cross local CPU architectures', () => {
  const source = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const keys = [...source.matchAll(/^          key: (nm-[^\n]+)$/gm)];
  assert.ok(keys.length >= 5);
  for (const [, key] of keys) assert.ok(key.includes('${{ runner.arch }}'), key);
});
