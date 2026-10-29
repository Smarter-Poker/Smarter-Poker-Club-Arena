import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertRosterRun, guardRosterRun } from './lightning-pilot-roster-run.mjs';
const operationId = '365d94ad-73fa-43b1-b8db-1d9070868d9d';
const baseline = {
  id: 1,
  event: 'workflow_dispatch',
  head_branch: 'main',
  path: '.github/workflows/lightning-pilot-roster.yml',
  run_attempt: 1,
  conclusion: 'success',
  display_title: `Lightning Roster prepare ${operationId}`,
  created_at: '2026-01-01T00:00:00Z',
};
const current = {
  ...baseline,
  id: 2,
  display_title: `Lightning Roster execute ${operationId}`,
  created_at: '2026-01-01T00:01:00Z',
};
const good = { phase: 'execute', operationId, current, baseline, runs: [current, baseline] };
test('first exact execution requires durable successful preparation', () =>
  assert.doesNotThrow(() => assertRosterRun(good)));
test('prior execute including failed or unknown outcomes forbids a retry', () => {
  for (const conclusion of ['failure', 'cancelled', null, 'success'])
    assert.throws(() =>
      assertRosterRun({ ...good, runs: [current, { ...current, id: 3, conclusion }] })
    );
});
test('changed provider identities, baseline and reruns fail closed', () => {
  for (const patch of [
    { run_attempt: 2 },
    { created_at: 'bad' },
    { head_branch: 'feature' },
    { event: 'push' },
    { path: 'other' },
    { display_title: 'other' },
  ])
    assert.throws(() => assertRosterRun({ ...good, current: { ...current, ...patch } }));
  for (const patch of [
    { run_attempt: 2 },
    { conclusion: 'failure' },
    { display_title: 'other' },
    { created_at: current.created_at },
    { head_branch: 'feature' },
  ])
    assert.throws(() => assertRosterRun({ ...good, baseline: { ...baseline, ...patch } }));
  assert.throws(() => assertRosterRun({ ...good, runs: [] }));
});
test('provider read errors never become an empty successful inventory', async () => {
  await assert.rejects(
    guardRosterRun(
      {
        GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
        GITHUB_REPOSITORY_ID: '1132369872',
        GITHUB_RUN_ID: '2',
        GITHUB_TOKEN: 'not-a-real-token',
      },
      async () => ({ ok: false, status: 403 })
    )
  );
});
test('manual workflow verifies ownership and durable baseline before any production door', () => {
  const s = readFileSync(
    new URL('../../.github/workflows/lightning-pilot-roster.yml', import.meta.url),
    'utf8'
  );
  assert.match(s, /workflow_dispatch:/);
  assert.doesNotMatch(s, /schedule:|cron:/);
  assert.match(s, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(s, /cancel-in-progress: false/);
  assert.ok(
    s.indexOf('node scripts/ops/lightning-pilot-roster-run.mjs') <
      s.indexOf('node scripts/ops/lightning-pilot-roster.mjs')
  );
  assert.match(s, /run-id: \$\{\{ inputs.prepare_run \}\}/);
  assert.match(s, /if: always\(\)/);
});

test('transferred immutable repository reaches only original provider read route',async()=>{let calls=0;await assert.rejects(guardRosterRun({GITHUB_REPOSITORY:'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',GITHUB_REPOSITORY_ID:'1132369872',GITHUB_RUN_ID:'2',GITHUB_TOKEN:'modeled'},async url=>{calls++;assert.match(url,/repos\/Smarter-Software-PIQ\/Smarter-Poker-Club-Arena\/actions\/runs\/2$/);return {ok:false}}));assert.equal(calls,1);for(const id of [undefined,'42']){calls=0;await assert.rejects(guardRosterRun({GITHUB_REPOSITORY:'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',GITHUB_REPOSITORY_ID:id,GITHUB_RUN_ID:'2',GITHUB_TOKEN:'modeled'},async()=>{calls++;throw Error('unexpected credential use')}));assert.equal(calls,0)}});
