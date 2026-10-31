import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyChangedPaths } from './classify-ci-changes.mjs';
import { assessClientCoverage } from './private-record-gateway-artifact.mjs';

function otherwiseComplete() {
  return {
    census: {
      complete: true,
      connections: [],
      clusterNodes: ['fixture-node'],
      snapshotId: 'fixture-epoch',
      unqualified: 0,
    },
    returningLegacy: {
      verified: true,
      mode: 'retained-compatible-delivery',
      revision: 'a'.repeat(40),
      proof: 'synthetic-validator-fixture',
      paidSourceDependency: 'supabase-realtime',
    },
    gateway: {
      revision: 'b'.repeat(40),
      independentHostVerified: true,
      authenticatedFailoverVerified: true,
      proof: 'synthetic-validator-fixture',
    },
  };
}

test('retaining paid compatibility can never qualify disabling its own source', () => {
  const assessment = assessClientCoverage(otherwiseComplete());
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reasons.join(' '), /paid.*depend|depend.*paid/i);
});

test('unknown legacy transport dependency remains unqualified', () => {
  const input = otherwiseComplete();
  delete input.returningLegacy.paidSourceDependency;
  assert.equal(assessClientCoverage(input).eligible, false);
});

test('explicit independent contract only passes input triage, never production certification', () => {
  const input = otherwiseComplete();
  input.returningLegacy.mode = 'enforced-safe-record-admission';
  input.returningLegacy.paidSourceDependency = 'none';
  const assessment = assessClientCoverage(input);
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.scope, 'input-evidence-triage-only');
  assert.match(assessment.limitation, /not proof/);
});

test('compatibility regression is invoked by the required native runner and selects its CI job', () => {
  const classification = classifyChangedPaths(['scripts/ci/private-record-compatibility.test.mjs']);
  assert.equal(classification.server, true);
  assert.equal(classification.tests, true);
  const runner = readFileSync(new URL('./test-private-record-hosting.sh', import.meta.url), 'utf8');
  assert.equal(
    runner.split('node --test "$repo/scripts/ci/private-record-compatibility.test.mjs"').length - 1,
    1
  );
});
