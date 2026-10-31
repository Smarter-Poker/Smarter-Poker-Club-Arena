import { execFileSync } from 'node:child_process';
import { gitEnvironmentForCwd } from './classify-ci-changes.mjs';

const workflowPath = '.github/workflows/publish-club-arena.yml';
const clientWorkflowPath = '.github/workflows/publish-club-arena-client.yml';
const unsupported = () => {
  throw Error('Publisher client shard source is unreadable or unsupported');
};

/** A deliberately small supported YAML shape, not a permissive YAML parser.
 * Unknown layouts decline optional reuse and keep full backlog qualification.
 * Read the producer's immutable source, never the current checkout's matrix.
 */
export function publisherClientShardPlan(source) {
  if (
    typeof source !== 'string' ||
    source.length > 512_000 ||
    /[\t\0\r]/.test(source) ||
    (source.match(/^jobs:\s*$/gm) || []).length !== 1 ||
    (source.match(/^  client-tests:\s*$/gm) || []).length !== 1
  )
    unsupported();
  const block = source
    .slice(source.indexOf('\n  client-tests:') + 1)
    .split(/\n(?=  [A-Za-z0-9_-]+:)/)[0];
  if (
    !block.startsWith('  client-tests:\n') ||
    /^    (?:name|continue-on-error):/m.test(block) ||
    /^\s*<<:|:\s*[&*!]/m.test(block)
  )
    unsupported();
  const strategy = /^    strategy:\n((?: {6}[^\n]*\n|\n)+)/m.exec(block)?.[0];
  if (
    (block.match(/^    strategy:/gm) || []).length !== 1 ||
    !/^    strategy:\n      fail-fast: true\n      matrix:\n        shard: \[([0-9, ]+)\]\n$/.test(
      strategy || ''
    )
  )
    unsupported();
  const indices = /shard: \[([0-9, ]+)\]/.exec(strategy)[1].split(', ').map(Number);
  if (![4, 16].includes(indices.length) || indices.some((value, index) => value !== index + 1))
    unsupported();
  const total = indices.length;
  const testName = `Client tests must pass before the bundle ships (shard \${{ matrix.shard }}/${total})`;
  const tests = block
    .split(/\n(?=      - )/)
    .filter((part) => part.startsWith(`      - name: ${testName}\n`));
  if (tests.length !== 1 || /^        (?:if|continue-on-error|shell):/m.test(tests[0]))
    unsupported();
  const commands = [...tests[0].matchAll(/^        run: (.+)$/gm)].map((m) => m[1]);
  const selector = `node scripts/ci/ui-test-selection.mjs unit --shard=\${{ matrix.shard }}/${total}`;
  const legacy = `npx vitest run tests/ --shard=\${{ matrix.shard }}/${total}`;
  if (
    commands.length !== 1 ||
    !(commands[0] === selector || (total === 4 && commands[0] === legacy))
  )
    unsupported();
  return { indices, total };
}

export function readImmutablePublisherClientShards(cwd, sha, timeout = 5000) {
  if (!/^[0-9a-f]{40}$/.test(sha || '') || !Number.isSafeInteger(timeout) || timeout <= 0)
    unsupported();
  const deadline = Date.now() + Math.min(timeout, 5000);
  const git = (...args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) unsupported();
    return execFileSync('git', ['-C', cwd, ...args], {
      env: gitEnvironmentForCwd(),
      encoding: 'utf8',
      timeout: remaining,
      maxBuffer: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  if (
    git('ls-tree', sha, '--', workflowPath) !==
    `100644 blob ${git('rev-parse', `${sha}:${workflowPath}`).trim()}\t${workflowPath}\n`
  )
    unsupported();
  const source = git('show', `${sha}:${workflowPath}`);
  if (/^  client-tests:\s*$/m.test(source)) return publisherClientShardPlan(source);
  // Only the one maintained same-repository caller may move the matrix.
  // Never follow an arbitrary uses path or infer its plan from today's checkout.
  const caller = source
    .slice(source.indexOf('\n  client-publication:') + 1)
    .split(/\n(?=  [A-Za-z0-9_-]+:)/)[0];
  if (
    (source.match(/^  client-publication:\s*$/gm) || []).length !== 1 ||
    !/^    uses: \.\/\.github\/workflows\/publish-club-arena-client\.yml$/m.test(caller) ||
    (caller.match(/^    uses:/gm) || []).length !== 1 ||
    !/^    needs: publish-needed$/m.test(caller)
  )
    unsupported();
  if (
    git('ls-tree', sha, '--', clientWorkflowPath) !==
    `100644 blob ${git('rev-parse', `${sha}:${clientWorkflowPath}`).trim()}\t${clientWorkflowPath}\n`
  )
    unsupported();
  const clientSource = git('show', `${sha}:${clientWorkflowPath}`);
  if (
    !/^  workflow_call:\s*$/m.test(clientSource) ||
    /^  (?:push|pull_request|repository_dispatch|workflow_dispatch|schedule):/m.test(clientSource)
  )
    unsupported();
  return { ...publisherClientShardPlan(clientSource), jobPrefix: 'client-publication / ' };
}
