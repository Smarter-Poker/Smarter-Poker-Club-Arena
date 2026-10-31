import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
import {
  assembleFeatureAblation,
  readRawPairs,
  featureAblationDealSeed,
  rawPairTransportFile,
  sha256,
  canonical,
  operationId,
  providerOperations,
  providerState,
} from '../../server/scripts/feature-ablation-assemble.mjs';
const H = 'a'.repeat(64),
  SHA = 'b'.repeat(40);
const cell = {
  key: 'cell',
  profileId: 'p',
  variant: 'plo6',
  seed: 25304119,
  shard: 0,
  firstPair: 0,
  pairs: 2,
};
const bindings = {
  policyDigestsDigest: H,
  dependencyDigest: H,
  storeInputsDigest: H,
  admissionDigest: H,
  historyDigest: H,
};
const plan = {
  schema: 'test-fixture-only',
  version: 'test',
  state: 'heldout_locked',
  maxAttempts: 3,
  target: 'test-plo6',
  ...bindings,
  heldoutSeeds: [25304119, 25305233, 25306349],
  criticalCells: ['profile', 'relative_position', 'depth'],
  profiles: [{ id: 'p', weight: 1 }],
  matrix: [
    cell,
    { ...cell, key: 'seed2', seed: 25305233 },
    { ...cell, key: 'seed3', seed: 25306349 },
  ],
};
function op(n = 1) {
  return {
    providerRunId: '123',
    runAttempt: n,
    jobId: String(456 + n),
    createdAt: `2026-10-27T03:0${n}:00Z`,
    createdAtSource: 'job.created_at',
    attemptOrdinal: n,
    firstOperationId: '123:1:457',
    ...(n > 1
      ? {
          recoveryOf: `123:${n - 1}:${455 + n}`,
          recoveryReason: 'provider interruption; same original operation',
        }
      : {}),
  };
}
const raw = {
  rawPairsSha256: H,
  rawPairCount: 2,
  pairDigest: H,
  sums: { n: 2, s1: '1', s2: '5', s3: '7', s4: '17' },
  strata: {},
  positionCounts: [1, 1],
  candidateNetCents: 101,
  referenceNetCents: 100,
  changedPairs: 1,
  candidateHeroActionContrastPairs: 1,
  rakeCents: 2,
  bbjCents: 0,
};
function attempt(n = 1, override = {}) {
  const operation = op(n),
    result = { ...raw, complete: true, durationMs: n };
  delete result.rawPairsSha256;
  delete result.rawPairCount;
  return {
    artifactName: 'cell-a' + n,
    cellKey: 'cell',
    operation,
    exitCode: 0,
    identity: { planDigest: H, target: plan.target, sourceSha: SHA, ...bindings, cell },
    rawEvidence: { ...raw },
    receiptText: JSON.stringify({
      schema: 'horse-feature-ablation-cell-v1',
      mode: 'contract',
      planDigest: H,
      target: plan.target,
      cellKey: 'cell',
      sourceSha: SHA,
      ...bindings,
      operation,
      result,
      rawPairsSha256: H,
      rawPairCount: 2,
    }),
    ...override,
  };
}
function assemble(attempts, more = {}) {
  const extra = plan.matrix.slice(1).map((c, i) => {
    const a = attempt();
    a.cellKey = c.key;
    a.identity = { ...a.identity, cell: c };
    a.operation = {
      ...a.operation,
      jobId: String(900 + i),
      firstOperationId: '123:1:' + String(900 + i),
    };
    const r = JSON.parse(a.receiptText);
    r.cellKey = c.key;
    r.operation = a.operation;
    a.receiptText = JSON.stringify(r);
    return a;
  });
  const all = [...attempts, ...extra];
  return assembleFeatureAblation({
    plan,
    planDigest: H,
    sourceSha: SHA,
    attempts: all,
    authorizedOperations: [
      ...new Map(
        all.map((a) => [operationId(a.operation), { cellKey: a.cellKey, operation: a.operation }])
      ).values(),
    ],
    validateCell: () => [],
    summarize: () => ({ qualified: true, scope: 'isolated fixture, no production authority' }),
    ...more,
  });
}
test('complete exact matrix reaches original contract scorer but never activates', () => {
  const a = assemble([attempt()]);
  assert.equal(a.qualified, true);
  assert.equal(a.activationAllowed, false);
  assert.equal(a.attempts.length, 3);
});
test('all development/unlocked plans and missing mandatory critical cells fail closed', () => {
  for (const state of ['development_pilot_required', 'development', 'awaiting_pilot', null])
    assert.equal(assemble([], { plan: { ...plan, state } }).qualified, false);
  assert.equal(assemble([], { plan: { ...plan, criticalCells: [] } }).qualified, false);
});
test('missing cells, foreign source/store/admission/range and unknown artifacts refuse', () => {
  assert.match(assemble([]).reasons.join(), /missing_cell/);
  for (const f of ['sourceSha', 'storeInputsDigest', 'admissionDigest']) {
    const a = attempt();
    a.identity[f] = 'c'.repeat(64);
    assert.equal(assemble([a]).qualified, false);
  }
  const a = attempt();
  a.identity.cell = { ...cell, firstPair: 2 };
  assert.equal(assemble([a]).qualified, false);
  assert.equal(assemble([{ ...attempt(), cellKey: 'foreign' }]).qualified, false);
});
test('raw moments and digests are independently checked before scoring', () => {
  for (const f of [
    'sums',
    'pairDigest',
    'rakeCents',
    'positionCounts',
    'candidateHeroActionContrastPairs',
  ]) {
    const a = attempt();
    a.rawEvidence = { ...raw, [f]: null };
    assert.match(assemble([a]).reasons.join(), /raw_pair_proof/);
  }
});
test('failure and same-operation deterministic recovery retain every prior attempt', () => {
  const a = attempt(1, { exitCode: 137, receiptText: null, rawEvidence: null }),
    b = attempt(2);
  const r = assemble([b, a]);
  assert.equal(r.qualified, true);
  assert.equal(r.attempts.length, 4);
  assert.equal(r.selected[0].operation.runAttempt, 2);
  assert.match(
    assemble([{ ...a, rawProofError: 'incorrect data check' }, b]).reasons.join(),
    /transport_or_proof_error/
  );
  delete b.operation.recoveryReason;
  assert.equal(assemble([a, b]).qualified, false);
});
test('missing authorized first attempt and gaps cannot manufacture a fresh trial', () => {
  assert.equal(assemble([attempt(2)]).qualified, false);
  assert.equal(assemble([attempt(), attempt(3)]).qualified, false);
});
test('later complete attempt cannot select a favorable result or conflict silently', () => {
  const a = attempt(),
    b = attempt(2);
  assert.equal(assemble([b, a]).qualified, true);
  const body = JSON.parse(b.receiptText);
  body.result.changedPairs = 0;
  b.receiptText = JSON.stringify(body);
  b.rawEvidence = { ...raw, changedPairs: 0 };
  assert.match(assemble([a, b]).reasons.join(), /conflicting_complete_replay/);
});
test('duplicate copies of same attempt require byte equality and are all retained', () => {
  const a = attempt();
  assert.equal(assemble([a, { ...a }]).attempts.length, 4);
  assert.equal(assemble([a, { ...a, receiptText: a.receiptText + ' ' }]).qualified, false);
});
test('contract trust/coverage rejection and negative strength cannot be bypassed', () => {
  assert.equal(
    assemble([attempt()], { validateCell: () => ['authority_missing'] }).qualified,
    false
  );
  assert.equal(
    assemble([attempt()], { summarize: () => ({ qualified: false, reasons: ['inert'] }) })
      .qualified,
    false
  );
});
test('raw pair reader reconstructs exact CRN, rotation, powers and fees; corruption refuses', async () => {
  assert.equal(featureAblationDealSeed('fixed-a', 12345, 0), 1622662316);
  assert.equal(featureAblationDealSeed('fixed-b', 12345, 0), 2422094062);
  assert.notEqual(
    featureAblationDealSeed('fixed-a', 12345, 0),
    featureAblationDealSeed('fixed-b', 12345, 0)
  );
  const dir = mkdtempSync(join(repositoryRoot, 'feature-ablation-'));
  try {
    const rows = [0, 1].map((i) => ({
      index: i,
      dealSeed: featureAblationDealSeed(cell.profileId, cell.seed, i),
      heroSeat: i + 1,
      button: 1,
      relativePosition: i,
      candidateNetCents: 10 + i,
      referenceNetCents: 10,
      differenceCents: i,
      street: i ? 'flop' : 'none',
      candidateTrace: [i ? '0:x:x:flop:raise' : '0:x:x:preflop:call'],
      referenceTrace: [i ? '0:x:x:flop:call' : '0:x:x:preflop:call'],
      candidateFees: { rake: 0.01, bbj: 0 },
      referenceFees: { rake: 0.02, bbj: 0 },
    }));
    const file = join(dir, 'raw.jsonl'),
      text = rows.map(JSON.stringify).join('\n') + '\n';
    writeFileSync(file, text);
    const r = await readRawPairs(file, { ...cell, seats: 2 });
    assert.equal(r.rawPairsSha256, sha256(text));
    assert.deepEqual(r.sums, { n: 2, s1: '1', s2: '1', s3: '1', s4: '1' });
    assert.equal(r.rakeCents, 6);
    await assert.rejects(
      readRawPairs(file, { ...cell, seats: 2, profileId: 'different-profile' }),
      /crn/
    );
    const zipped = join(dir, 'raw-pairs.jsonl.gz');
    writeFileSync(zipped, gzipSync(text));
    assert.deepEqual(await readRawPairs(zipped, { ...cell, seats: 2 }), r);
    assert.equal(rawPairTransportFile(dir), zipped);
    writeFileSync(join(dir, 'raw-pairs.jsonl'), text);
    assert.throws(() => rawPairTransportFile(dir), /transport_ambiguous/);
    const corrupt = gzipSync(text);
    corrupt[corrupt.length - 8] ^= 1;
    writeFileSync(zipped, corrupt);
    await assert.rejects(readRawPairs(zipped, { ...cell, seats: 2 }, { allowIncomplete: true }));

    assert.equal(r.candidateHeroActionContrastPairs, 0); // Opponent-only trace contrast.
    rows[1].candidateTrace = ['2:raise:20:flop'];
    rows[1].referenceTrace = ['2:call:20:flop'];
    writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    assert.equal(
      (await readRawPairs(file, { ...cell, seats: 2 })).candidateHeroActionContrastPairs,
      1
    );
    const forged = attempt(),
      receipt = JSON.parse(forged.receiptText);
    receipt.result.candidateHeroActionContrastPairs = 2;
    forged.receiptText = JSON.stringify(receipt);
    assert.match(assemble([forged]).reasons.join(), /raw_pair_proof/);

    rows[1].dealSeed++;
    writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    await assert.rejects(readRawPairs(file, { ...cell, seats: 2 }), /crn/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('provider inventory uses original jobs and explicit timestamp provenance, never result order', () => {
  const run = { id: 123, created_at: '2026-10-27T03:00:00Z' };
  const jobs = [
    {
      id: 9,
      name: 'Cell cell',
      run_id: 123,
      run_attempt: 2,
      created_at: '2026-10-27T03:10:00Z',
      conclusion: null,
      status: 'in_progress',
    },
    {
      id: 8,
      name: 'Cell cell',
      run_id: 123,
      run_attempt: 1,
      created_at: '2026-10-27T03:01:00Z',
      conclusion: 'cancelled',
    },
  ];
  const r = providerOperations(jobs, run, [cell]);
  assert.equal(r[0].operation.jobId, '8');
  assert.equal(r[1].operation.recoveryOf, '123:1:8');
  assert.equal(r[0].operation.createdAtSource, 'job.created_at');
  delete jobs[1].created_at;
  assert.equal(
    providerOperations(jobs, run, [cell])[0].operation.createdAtSource,
    'run.created_at'
  );
  assert.throws(() => providerOperations([...jobs, jobs[0]], run, [cell]), /binding/);
});
test('hidden provider attempt, ambiguous cell jobs and foreign run refuse', () => {
  const a = attempt(),
    b = attempt(2);
  const r = assemble([a], {
    authorizedOperations: [
      { cellKey: 'cell', operation: a.operation },
      { cellKey: 'cell', operation: b.operation },
      ...plan.matrix.slice(1).map((c, i) => ({
        cellKey: c.key,
        operation: {
          ...op(),
          jobId: String(900 + i),
          firstOperationId: '123:1:' + String(900 + i),
        },
      })),
    ],
  });
  assert.match(r.reasons.join(), /missing_authorized_attempt/);
  assert.throws(
    () =>
      providerOperations(
        [{ name: 'Cell cell', id: 1, run_id: 999, run_attempt: 1 }],
        { id: 123, created_at: '2026-10-27T03:00Z' },
        [cell]
      ),
    /binding/
  );
});
test('matrix cannot omit a preregistered seed or double-count overlapping ranges', () => {
  assert.equal(assemble([attempt()], { plan: { ...plan, matrix: [cell] } }).qualified, false);
  assert.equal(
    assemble([attempt()], {
      plan: { ...plan, matrix: [...plan.matrix, { ...cell, key: 'overlap', shard: 1 }] },
    }).qualified,
    false
  );
});

test('only bounded allowlisted worker execution diagnostics may vary across a replay', () => {
  const a = attempt(),
    b = attempt(2);
  for (const [i, x] of [a, b].entries()) {
    const r = JSON.parse(x.receiptText);
    r.execution = {
      workerReceiptSha256: String(i ? 'c' : 'd').repeat(64),
      workerReceiptCount: 2,
      sampledWorkerReceipts: [{ epoch: i + 100 }],
    };
    x.receiptText = JSON.stringify(r);
  }
  assert.equal(assemble([a, b]).qualified, true);
  const r = JSON.parse(b.receiptText);
  r.execution.hiddenScientificResult = true;
  b.receiptText = JSON.stringify(r);
  assert.match(assemble([a, b]).reasons.join(), /execution_metadata_shape/);
});

test('contract exceptions and logical job names are refusals rather than manufactured qualification', () => {
  assert.equal(
    assemble([attempt()], {
      validateCell: () => {
        throw new Error('missing authority');
      },
    }).qualified,
    false
  );
  assert.equal(
    assemble([attempt()], {
      summarize: () => {
        throw new Error('invalid moments');
      },
    }).qualified,
    false
  );
  const a = attempt();
  a.operation.jobId = 'cell';
  assert.equal(assemble([a]).qualified, false);
});

test('an interrupted valid raw prefix must match recovery; invalid unfinished row stays visible', async () => {
  const dir = mkdtempSync(join(repositoryRoot, 'feature-prefix-'));
  try {
    const rows = [0, 1].map((i) => ({
      index: i,
      dealSeed: featureAblationDealSeed(cell.profileId, cell.seed, i),
      heroSeat: i + 1,
      button: 1,
      relativePosition: i,
      candidateNetCents: 10 + i,
      referenceNetCents: 10,
      differenceCents: i,
      street: i ? 'flop' : 'none',
      candidateTrace: [i ? '0:x:x:flop:raise' : '0:x:x:preflop:call'],
      referenceTrace: [i ? '0:x:x:flop:call' : '0:x:x:preflop:call'],
      candidateFees: { rake: 0.01, bbj: 0 },
      referenceFees: { rake: 0.02, bbj: 0 },
    }));
    const incomplete = join(dir, 'incomplete.jsonl'),
      complete = join(dir, 'complete.jsonl');
    writeFileSync(incomplete, JSON.stringify(rows[0]) + '\n' + '{"interrupted":');
    writeFileSync(complete, rows.map(JSON.stringify).join('\n') + '\n');
    const prefix = await readRawPairs(incomplete, { ...cell, seats: 2 }, { allowIncomplete: true });
    assert.equal(prefix.rawPairCount, 1);
    assert.equal(prefix.interruptionReason, 'raw_pair_json_invalid');
    assert.equal(prefix.nonterminalCorruption, false);
    const full = await readRawPairs(
      complete,
      { ...cell, seats: 2 },
      { prefixCounts: [prefix.rawPairCount] }
    );
    const a = attempt(1, { exitCode: 137, receiptText: null, rawEvidence: prefix }),
      b = attempt(2, { rawEvidence: full });
    const r = JSON.parse(b.receiptText),
      {
        rawPairsSha256,
        rawPairCount,
        interruptionReason,
        nonterminalCorruption,
        prefixDigests,
        ...measurement
      } = full;
    r.result = { ...measurement, complete: true, durationMs: 2 };
    r.rawPairsSha256 = rawPairsSha256;
    r.rawPairCount = rawPairCount;
    b.receiptText = JSON.stringify(r);
    const positive = assemble([a, b]);
    assert.equal(positive.qualified, true);
    assert.equal(
      positive.attempts.find((x) => x.exitCode === 137).rawInterruption,
      'raw_pair_json_invalid'
    );
    a.rawEvidence = { ...prefix, pairDigest: 'e'.repeat(64) };
    assert.match(assemble([a, b]).reasons.join(), /conflicting_incomplete_prefix/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('known integrity violations in an incomplete attempt cannot be selected away', () => {
  const a = attempt(1, { exitCode: 137 }),
    b = attempt(2),
    r = JSON.parse(a.receiptText);
  r.result.complete = false;
  r.result.illegalActions = 1;
  a.receiptText = JSON.stringify(r);
  assert.match(assemble([a, b]).reasons.join(), /observed_integrity_violation/);
});

test('provider state accepts transferred repository identity and refuses substitutions before job custody', async (t) => {
  const prior = process.env;
  process.env = {
    ...prior,
    GITHUB_REPOSITORY: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
    GITHUB_REPOSITORY_ID: '1132369872',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_TOKEN: 'structural-fixture-not-a-credential',
  };
  let repository = { id: 1132369872, full_name: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' };
  const run = {
    id: 123,
    event: 'workflow_dispatch',
    head_branch: 'main',
    path: '.github/workflows/horse-feature-ablation-qualification.yml',
  };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return {
      ok: true,
      json: async () => (url.endsWith('/actions/runs/123') ? { ...run, repository } : { jobs: [] }),
    };
  });
  try {
    const state = await providerState();
    assert.deepEqual(state.run, { ...run, repository });
    assert.deepEqual(state.jobs, []);
    assert.equal(state.currentAttempt, 1);
    assert.deepEqual(urls, [
      'https://api.github.com/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/runs/123',
      'https://api.github.com/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/runs/123/attempts/1/jobs?per_page=100&page=1',
    ]);
    for (const id of [undefined, '', '1132369873']) {
      if (id === undefined) delete process.env.GITHUB_REPOSITORY_ID;
      else process.env.GITHUB_REPOSITORY_ID = id;
      await assert.rejects(providerState(), /provider_metadata_unavailable/);
      assert.equal(urls.length, 2);
    }
    process.env.GITHUB_REPOSITORY_ID = '1132369872';
    process.env.GITHUB_REPOSITORY = 'Smarter-Poker/Smarter-Poker-Club-Arena';
    await assert.rejects(providerState(), /provider_metadata_unavailable/);
    assert.equal(urls.length, 2);
    process.env.GITHUB_REPOSITORY = 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena';
    for (repository of [
      undefined,
      { id: 1132369873, full_name: process.env.GITHUB_REPOSITORY },
      { id: 1132369872, full_name: 'foreign' },
    ]) {
      const calls = urls.length;
      await assert.rejects(providerState(), /provider_workflow_identity/);
      assert.equal(urls.length, calls + 1);
    }
  } finally {
    process.env = prior;
  }
});
