import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAssignmentRun, guardAssignmentRun } from './lightning-pilot-assignment-run.mjs';
const operationId = '365d94ad-73fa-43b1-b8db-1d9070868d9d';
const baseline = {
  id: 1,
  event: 'workflow_dispatch',
  head_branch: 'main',
  path: '.github/workflows/lightning-pilot-assignment.yml',
  run_attempt: 1,
  conclusion: 'success',
  display_title: `Lightning Assignment prepare ${operationId}`,
  created_at: '2026-01-01T00:00:00Z',
};
const current = {
  ...baseline,
  id: 2,
  display_title: `Lightning Assignment withdraw ${operationId}`,
  created_at: '2026-01-01T00:01:00Z',
};
const good = { phase: 'withdraw', operationId, baseline, current, runs: [baseline, current] };
test('only one exact first withdrawal can consume a successful preparation', () => {
  assert.doesNotThrow(() => assertAssignmentRun(good));
  for (const conclusion of ['success', 'failure', 'cancelled', null])
    assert.throws(() =>
      assertAssignmentRun({ ...good, runs: [...good.runs, { ...current, id: 3, conclusion }] })
    );
  assert.throws(() => assertAssignmentRun({ ...good, runs: [] }));
  for (const patch of [
    { conclusion: 'failure' },
    { run_attempt: 2 },
    { created_at: current.created_at },
    { head_branch: 'other' },
  ])
    assert.throws(() => assertAssignmentRun({ ...good, baseline: { ...baseline, ...patch } }));
});
test('every phase requires exact main manual run identity and refuses provider reruns', () => {
  for (const phase of ['prepare', 'assign', 'release', 'report']) {
    const input = {
      phase,
      operationId,
      current: { ...current, display_title: `Lightning Assignment ${phase} ${operationId}` },
    };
    assert.doesNotThrow(() => assertAssignmentRun(input));
    for (const patch of [
      { run_attempt: 2 },
      { event: 'push' },
      { path: 'other' },
      { display_title: 'other' },
      { head_branch: 'other' },
      { created_at: 'bad' },
    ])
      assert.throws(() =>
        assertAssignmentRun({ ...input, current: { ...input.current, ...patch } })
      );
  }
});
test('unreadable provider inventory never becomes an empty successful history', async () => {
  await assert.rejects(
    guardAssignmentRun(
      {
        GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
        GITHUB_REPOSITORY_ID: '1132369872',
        GITHUB_RUN_ID: '2',
        GITHUB_TOKEN: 'sb_secret_test_fixture_provider',
      },
      async () => ({ ok: false })
    )
  );
});
test('assignment workflow is explicit, serialized and checks ownership before credentials', () => {
  const s = readFileSync(
    new URL('../../.github/workflows/lightning-pilot-assignment.yml', import.meta.url),
    'utf8'
  );
  assert.match(s, /workflow_dispatch:/);
  assert.doesNotMatch(s, /schedule:|cron:/);
  assert.match(s, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(s, /group: lightning-private-pilot-setup/);
  assert.match(s, /cancel-in-progress: false/);
  assert.ok(
    s.indexOf('node scripts/ops/lightning-pilot-assignment-run.mjs') < s.indexOf('SP_PASS:')
  );
  assert.match(s, /run-id: \$\{\{ inputs.prepare_run \}\}/);
});

test('transferred immutable assignment preserves provider refusal before mutation',async()=>{let calls=0;await assert.rejects(guardAssignmentRun({GITHUB_REPOSITORY:'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',GITHUB_REPOSITORY_ID:'1132369872',GITHUB_RUN_ID:'2',GITHUB_TOKEN:'modeled'},async url=>{calls++;assert.match(url,/repos\/Smarter-Software-PIQ\/Smarter-Poker-Club-Arena\/actions\/runs\/2$/);return {ok:false}}));assert.equal(calls,1);for(const id of [undefined,'42']){calls=0;await assert.rejects(guardAssignmentRun({GITHUB_REPOSITORY:'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',GITHUB_REPOSITORY_ID:id,GITHUB_RUN_ID:'2',GITHUB_TOKEN:'modeled'},async()=>{calls++;throw Error('unexpected credential use')}));assert.equal(calls,0)}});
