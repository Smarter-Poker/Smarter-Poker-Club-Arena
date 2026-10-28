import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import {
  validateRequest,
  healthMatches,
  candidateHandKeys,
  loadedAcceptedWitness,
  receiptMatches,
  LIMITS,
  inspect,
} from '../../scripts/ci/inspect-v31-worker-readiness.mjs';
const now = Date.parse('2026-10-28T04:00:00.000Z');
const p = {
  version: 1,
  sourceSha: 'a'.repeat(40),
  datasetId: '19b3d7e7-ba18-4d90-866f-b0c86867e2c9',
  datasetChecksum: 'b'.repeat(64),
  cellCount: 106,
  workerCount: 8,
  afterUtc: '2026-10-28T03:00:00.000Z',
};
const store = {
  postflopV31: 106,
  postflopV31Dataset: { id: p.datasetId, checksum: p.datasetChecksum },
};
const records = () =>
  ['decision', 'execution', 'accepted_hand'].map((kind, i) => ({
    kind,
    producerId: '40000000-0000-4000-8000-000000000001',
    sourceRelease: p.sourceSha,
    handKey: 'c'.repeat(64),
    turnKey: 'd'.repeat(64),
    atMs: Date.parse(p.afterUtc) + 1000 + i,
    sha256: String(i + 1).repeat(64),
    body: JSON.stringify(
      i === 0
        ? {
            snapshot: { type: 'DECIDE_FAST', fence: 'table:hand' },
            readiness: { solverStores: structuredClone(store) },
            privateCards: 'NEVER_EMIT',
          }
        : i === 1
          ? { executionStatus: 'intended', privateCards: 'NEVER_EMIT' }
          : { privateCards: 'NEVER_EMIT' }
    ),
  }));
const api = {
  validateHorseJournalRecord: () => {},
  reconcileHorseJournalHand: () => ({ status: 'reconciled' }),
  horseDecisionShard: () => 0,
  bindHorseDecisionToCommittedHand: () => ({ status: 'bound', actionOrdinal: 4 }),
};
test('only bounded fixed metadata requests are admitted', () => {
  assert.equal(validateRequest(p, now), p);
  for (const change of [
    { path: '/private' },
    { workerCount: 7 },
    { cellCount: 0 },
    { sourceSha: 'bad' },
    { datasetChecksum: 'bad' },
    { afterUtc: '2026-10-26T03:00:00.000Z' },
    { afterUtc: '2026-10-29T03:00:00.000Z' },
  ])
    assert.throws(() => validateRequest({ ...p, ...change }, now));
});
test('health identity requires actual eight ready workers and exact target first store', () => {
  const h = {
    status: 'ok',
    releaseSha: p.sourceSha,
    liveHorseDecision: { phase: 'ready', workerCount: 8, solverStores: store },
  };
  assert.equal(healthMatches(h, p), true);
  assert.equal(healthMatches({ ...h, releaseSha: 'f'.repeat(40) }, p), false);
  assert.equal(
    healthMatches({ ...h, liveHorseDecision: { ...h.liveHorseDecision, workerCount: 7 } }, p),
    false
  );
  assert.equal(
    healthMatches(
      {
        ...h,
        liveHorseDecision: { ...h.liveHorseDecision, solverStores: { ...store, postflopV31: 0 } },
      },
      p
    ),
    false
  );
});
test('actual SQLite selection reads only last 1024 metadata rows and at most eight distinct hands', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE archive_events(hand_key TEXT)');
    const add = db.prepare('INSERT INTO archive_events VALUES(?)');
    for (let i = 0; i < 1025; i++) add.run(String(i).padStart(64, '0'));
    const keys = candidateHandKeys(db);
    assert.equal(keys.length, LIMITS.handsPerWorker);
    assert.equal(keys[0], String(1024).padStart(64, '0'));
    assert.equal(keys.includes('0'.repeat(64)), false);
  } finally {
    db.close();
  }
});
test('loaded store is proved only beside reconciled matched natural accepted execution', () => {
  const out = loadedAcceptedWitness(records(), p, 0, api, now);
  assert.equal(out.datasetId, p.datasetId);
  assert.equal(out.actionOrdinal, 4);
  assert.equal(JSON.stringify(out).includes('NEVER_EMIT'), false);
  for (const failure of [
    { ...api, reconcileHorseJournalHand: () => ({ status: 'incomplete' }) },
    { ...api, horseDecisionShard: () => 1 },
    { ...api, bindHorseDecisionToCommittedHand: () => ({ status: 'unavailable' }) },
  ])
    assert.equal(loadedAcceptedWitness(records(), p, 0, failure, now), null);
  for (const mutate of [
    (rs) => (rs[0].sourceRelease = 'f'.repeat(40)),
    (rs) => (rs[0].atMs = Date.parse(p.afterUtc) - 1),
    (rs) => (rs[1].body = JSON.stringify({ executionStatus: 'changed' })),
    (rs) => (rs[1].producerId = 'another'),
    (rs) => rs.pop(),
    (rs) =>
      (rs[0].body = JSON.stringify({
        snapshot: { type: 'DECIDE_FAST', fence: 'table:hand' },
        readiness: {
          solverStores: {
            ...store,
            postflopV31Dataset: { id: p.datasetId, checksum: 'f'.repeat(64) },
          },
        },
      })),
  ]) {
    const rs = records();
    mutate(rs);
    assert.equal(loadedAcceptedWitness(rs, p, 0, api, now), null);
  }
  assert.throws(() =>
    loadedAcceptedWitness(
      records(),
      p,
      0,
      {
        ...api,
        validateHorseJournalRecord: () => {
          throw Error('private');
        },
      },
      now
    )
  );
});
test('real maintained record, full-hand reconciler, committed-action binder and shard fixture integrate', () => {
  if (process.platform === 'darwin')
    assert.ok(process.env.TMPDIR?.startsWith('/Volumes/SmarterWork/'));
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const scratch = mkdtempSync(join(tmpdir(), 'v31-readiness-integration-'));
  try {
    const original = readFileSync(
      join(root, 'server/src/services/horseDecisionJournal/review.test.ts'),
      'utf8'
    );
    const parsed = ts.createSourceFile('review.test.ts', original, ts.ScriptTarget.Latest, true);
    const fixture = parsed.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'fixture'
    );
    assert.ok(fixture, 'maintained fixture must remain available');
    const constants = original.slice(original.indexOf('const table = '), fixture.getStart(parsed));
    const at = (relative) => JSON.stringify(pathToFileURL(join(root, 'server/src', relative)).href);
    // Standard isolated TypeScript loader, preserving each real source URL and
    // its relative resources; only this fixture's real module graph is loaded.
    const typescript = pathToFileURL(createRequire(import.meta.url).resolve('typescript')).href;
    writeFileSync(
      join(scratch, 'loader.mjs'),
      `
      import ts from ${JSON.stringify(typescript)};
      import {readFileSync,existsSync} from 'node:fs';
      import {fileURLToPath} from 'node:url';
      export async function resolve(specifier,context,next) {
        if ((specifier.startsWith('.')||specifier.startsWith('file:'))&&specifier.endsWith('.js')) {
          const url=new URL(specifier,context.parentURL).href.replace(/\\.js$/,'.ts');
          if(existsSync(fileURLToPath(url)))return {url,shortCircuit:true};
        }
        return next(specifier,context);
      }
      export async function load(url,context,next) {
        if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',shortCircuit:true,
          source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{
            module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
        return next(url,context);
      }
    `
    );
    writeFileSync(
      join(scratch, 'register.mjs'),
      `
      import {register} from 'node:module';
      import {Socket} from 'node:net';
      Socket.prototype.connect=function(){throw Error('fixture_network_refused')};
      globalThis.fetch=async()=>{throw Error('fixture_network_refused')};
      register(new URL('./loader.mjs',import.meta.url));
    `
    );
    writeFileSync(
      join(scratch, 'fixture.ts'),
      `
      import assert from 'node:assert/strict';
      import {jointPolicyFixture} from ${at('engine/multiway/JointRangeFixture.test-support.ts')};
      import {captureHorseHandJournalContext,bindHorseDecisionToCommittedHand} from ${at('engine/HorseDecisionHandBinding.ts')};
      import {buildHorseDecisionKey} from ${at('engine/horseDecision/protocol.ts')};
      import {horseDecisionShard} from ${at('engine/horseDecision/shard.ts')};
      import {encodeHorseDecisionReads} from ${at('engine/HorseDecisionReadFrame.ts')};
      import {HorseMind} from ${at('engine/HorseMind.ts')};
      import {createHorseExecutionWitness,settleHorseExecutionWitness} from ${at('engine/HorseExecutionWitness.ts')};
      import {journalHash,makeHorseJournalRecord,validateHorseJournalRecord} from ${at('services/horseDecisionJournal/record.ts')};
      import {reconcileHorseJournalHand} from ${at('services/horseDecisionJournal/review.ts')};
      import {loadedAcceptedWitness} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/ci/inspect-v31-worker-readiness.mjs')).href)};
      ${constants}
      ${fixture.getText(parsed)}
      const p=${JSON.stringify(p)},now=${now};
      const f=fixture();
      f.d.readiness={solverStores:${JSON.stringify(store)}};
      const rows=f.rows().map((r,i)=>makeHorseJournalRecord({...r,atMs:Date.parse(p.afterUtc)+1000+i},JSON.parse(r.body)));
      assert.equal(reconcileHorseJournalHand(rows,handKey).status,'reconciled');
      const api={validateHorseJournalRecord,reconcileHorseJournalHand,bindHorseDecisionToCommittedHand,horseDecisionShard};
      const worker=horseDecisionShard(f.d.snapshot.fence,8);
      const result=loadedAcceptedWitness(rows,p,worker,api,now);
      assert.ok(result);assert.equal(result.datasetId,p.datasetId);assert.equal(result.worker,worker);
      assert.equal(result.actionOrdinal,f.a.actions.length-1);
      const changed=rows.map(r=>r.kind==='execution'?makeHorseJournalRecord({...r,producerId:'50000000-0000-4000-8000-000000000001'},JSON.parse(r.body)):r);
      assert.equal(loadedAcceptedWitness(changed,p,worker,api,now),null);
      console.log('REAL_V31_READINESS_BINDING_OK');process.exit(0);
    `
    );
    const out = execFileSync(
      process.execPath,
      ['--import', join(scratch, 'register.mjs'), join(scratch, 'fixture.ts')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          TMPDIR: scratch,
          VITEST: 'true',
          SUPABASE_URL: 'http://127.0.0.1:9',
          SUPABASE_SERVICE_ROLE_KEY: 'test-placeholder-key',
        },
      }
    );
    assert.ok(out.includes('REAL_V31_READINESS_BINDING_OK'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('all eight metadata rows are required and never promoted into policy or qualification proof', () => {
  const witness = loadedAcceptedWitness(records(), p, 0, api, now);
  const r = {
    version: 1,
    scope: 'v31_loaded_before_natural_accepted_decisions',
    status: 'verified',
    sourceSha: p.sourceSha,
    observedAt: now,
    workers: Array.from({ length: 8 }, (_, worker) => ({ ...witness, worker })),
    qualified: false,
    activationAllowed: false,
    policyApplicationProven: false,
  };
  assert.equal(receiptMatches(r, p), true);
  for (const bad of [
    { ...r, workers: r.workers.slice(1) },
    { ...r, qualified: true },
    { ...r, policyApplicationProven: true },
    { ...r, privateCards: 'bad' },
    { ...r, workers: r.workers.map((w) => ({ ...w, privateCards: 'bad' })) },
  ])
    assert.equal(receiptMatches(bad, p), false);
});
test('unavailable identity emits only named sanitized refusal, never private exception contents', async () => {
  const liveP = { ...p, afterUtc: new Date(Date.now() - 1000).toISOString() };
  const r = await inspect(liveP, {
    GIT_COMMIT_SHA: 'wrong',
    HORSE_DECISION_JOURNAL_DIR: '/private/NEVER_EMIT',
  });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reason, 'serving_identity_refused');
  assert.equal(JSON.stringify(r).includes('NEVER_EMIT'), false);
});
test('provider reader has fixed pinned authority, read-only compiled APIs and no release path', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/inspect-v31-worker-readiness.yml', import.meta.url),
    'utf8'
  );
  const script = readFileSync(
    new URL('../../scripts/ci/inspect-v31-worker-readiness.mjs', import.meta.url),
    'utf8'
  );
  for (const part of [
    'secrets.HETZNER_HOST',
    'secrets.HETZNER_SSH_PRIVATE_KEY',
    'secrets.HETZNER_HOST_KEY',
    'flock -n 9',
    'StrictHostKeyChecking=yes',
    'org.opencontainers.image.revision',
    '--health',
    '--receipt',
  ])
    assert.ok(workflow.includes(part), part);
  for (const part of [
    'readonlyHorseJournalStoreOptions',
    'readHorseJournalHandRecords',
    'reconcileHorseJournalHand',
    'bindHorseDecisionToCommittedHand',
    'validateHorseJournalRecord',
    'readOnly: true',
    'PRAGMA query_only=ON',
  ])
    assert.ok(script.includes(part), part);
  assert.equal(
    /schedule:|workflow_run:|docker restart|systemctl|supabase|service_role/.test(workflow),
    false
  );
});
