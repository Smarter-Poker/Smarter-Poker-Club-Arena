import assert from 'node:assert/strict';
import test from 'node:test';
import { invocation, servingIdentity, promotionReady, receiptSourceMatches, evaluatorArguments } from './gto-v31-qualification.mjs';

const id = '2687c795-6014-543e-85fd-460f418da6c3';
const valid = { eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'Smarter-Poker/Smarter-Poker-Club-Arena', repositoryId: '1132369872', inputs: { dataset: id, operation: 'evaluate' } };

test('only an explicit main dispatch with a canonical dataset can acquire the provider route', () => {
  assert.deepEqual(invocation(valid), { dataset: id, operation: 'evaluate' });
  for (const bad of [{ eventName: 'push' }, { ref: 'refs/heads/other' }, { repository: 'other/fork' },
    { inputs: { ...valid.inputs, source_sha: 'a'.repeat(40) } }, { inputs: { dataset: `${id};echo injected`, operation: 'evaluate' } },
    { inputs: { dataset: [id], operation: 'evaluate' } }, { inputs: { dataset: id, operation: 'retry-loop' } }]) assert.throws(() => invocation({ ...valid, ...bad }));
});

test('serving source cannot come from a short SHA or unready decision workers', () => {
  const good = { status: 'ok', releaseSha: 'b'.repeat(40), liveHorseDecision: { phase: 'ready' } };
  assert.deepEqual(servingIdentity(good), { releaseSha: good.releaseSha });
  for (const bad of [{ releaseSha: 'b'.repeat(8) }, { releaseSha: [good.releaseSha] }, { status: 'degraded' }, { liveHorseDecision: { phase: 'starting' } }])
    assert.throws(() => servingIdentity({ ...good, ...bad }));
});

test('partial immutable receipts cannot silently resume against a different serving source', () => {
  const source = 'a'.repeat(40);
  receiptSourceMatches({ evaluations: [] }, source);
  receiptSourceMatches({ evaluations: [{ kind: 'heldout' }, { kind: 'league', metrics: { candidate_config: { evaluation_engine_commit: source } } }] }, source);
  for (const metrics of [undefined, { candidate_config: { evaluation_engine_commit: 'b'.repeat(40) } }])
    assert.throws(() => receiptSourceMatches({ evaluations: [{ kind: 'paired_replay', metrics }] }, source));
});

test('promotion admission refuses partial, losing, duplicated or different-dataset receipts', () => {
  const evaluations = ['paired_replay', 'league'].flatMap((kind) => ['cash', 'spin', 'tourney_ev', 'tourney_icm']
    .map((game_family) => ({ kind, game_family, verdict: 'tie' })));
  const candidate = { dataset_id: id, state: 'candidate', evaluations };
  promotionReady(candidate, id);
  for (const changed of [{ state: 'evaluating' }, { dataset_id: 'other' }, { evaluations: evaluations.slice(1) },
    { evaluations: [...evaluations.slice(1), evaluations[1]] }, { evaluations: evaluations.map((r, i) => i ? r : { ...r, verdict: 'loss' }) }])
    assert.throws(() => promotionReady({ ...candidate, ...changed }, id));
});

test('the finite worker CLI receives no source override, shell interpolation or environment-file argument', () => {
  assert.deepEqual(evaluatorArguments(id, 'evaluate'), ['scripts/gto-v31-evaluate-worker.mjs', `--dataset=${id}`]);
  assert.equal(evaluatorArguments(id, 'promote').at(-1), '--promote');
  assert.throws(() => evaluatorArguments('not-a-uuid', 'promote'));
});

test('organization transfer retains immutable source authority',()=>{assert.deepEqual(invocation({...valid,repository:'Smarter-Software-PIQ/Smarter-Poker-Club-Arena'}),{dataset:id,operation:'evaluate'});for(const repositoryId of [undefined,'','42'])assert.throws(()=>invocation({...valid,repositoryId}));});
