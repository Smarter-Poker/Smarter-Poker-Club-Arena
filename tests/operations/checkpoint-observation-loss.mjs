// Real isolated target/controller and maintained host collector. No production calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
const directory = mkdtempSync(join(tmpdir(), 'checkpoint-observation-loss-'));
const helper =
  process.argv[2] ?? pathToFileURL(resolve('server/scripts/legacy-engine-checkpoint.mjs')).href;
const formatter = pathToFileURL(resolve('server/scripts/legacy-engine-checkpoint.mjs')).href;
const collectorFailure = process.argv[3] === 'collector_failure';
let target, controller, collector, hardLimit;
const bounded = async (promise, ms) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('isolated fixture deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const owner = join(directory, 'owner.mjs');
  writeFileSync(
    owner,
    `export let calls=0; export class GameServer { checkpoint(){ calls++; return {ok:true,completedCalls:1,privatePayload:'synthetic-secret-never-export'}; } }`
  );
  writeFileSync(
    join(directory, 'target.mjs'),
    `
import {GameServer,calls} from './owner.mjs'; import {createInterface} from 'node:readline';
const server=new GameServer(); globalThis.fixtureServer=server;
const inspector=process.getBuiltinModule('node:inspector');
const lines=createInterface({input:process.stdin});
lines.on('line', line=>{if(line==='state')console.log(JSON.stringify({calls,inspectorOpen:!!inspector.url()}));if(line==='quit'){inspector.close();lines.close();process.stdin.pause();}});
console.log('ready');`
  );
  target = spawn(
    process.execPath,
    ['--inspect-port=127.0.0.1:' + port, join(directory, 'target.mjs')],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const lines = createInterface({ input: target.stdout });
  const queue = [];
  let waiter;
  lines.on('line', (line) => (waiter ? (waiter(line), (waiter = null)) : queue.push(line)));
  const next = () =>
    bounded(queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => (waiter = r)), 3000);
  assert.equal(await next(), 'ready');
  const intent = JSON.stringify({
    runId: '12345-1',
    controlSha: 'b'.repeat(40),
    source: 'a'.repeat(40),
    instance: '1-12345678',
    hostPid: target.pid,
    container: 'c'.repeat(64),
    startedAt: '2026-10-30T00:00:00Z',
    at: 1793318400,
    retryAllowed: false,
  });
  const intentPath = join(directory, '12345-1.legacy-checkpoint-intent');
  const receiptFor = (text) =>
    join(
      directory,
      '12345-1.legacy-checkpoint-observation-' + createHash('sha256').update(text).digest('hex')
    );
  const receiptPath = receiptFor(intent);
  writeFileSync(intentPath, intent + '\n', {
    mode: 0o600,
  });
  collector = spawn(
    'python3',
    [
      '-B',
      resolve('server/scripts/retain-checkpoint-observation.py'),
      collectorFailure ? intent.replace('b'.repeat(40), 'd'.repeat(40)) : intent,
      intentPath,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let journal = '',
    finalStdout = '';
  collector.stderr.on('data', (b) => (journal += b));
  collector.stdout.on('data', (b) => (finalStdout += b));
  const expression = `process.getBuiltinModule('node:vm').runInThisContext(${JSON.stringify(`import(${JSON.stringify(pathToFileURL(owner).href)}).then(gameServer=>({gameServer}))`)},{importModuleDynamically:process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})`;
  writeFileSync(
    join(directory, 'controller.mjs'),
    `
import {runLegacyEngineCheckpoint} from ${JSON.stringify(helper)};
import {writeCheckpointGuardObservation} from ${JSON.stringify(formatter)};
const actualSend=WebSocket.prototype.send;
const result=await runLegacyEngineCheckpoint({pid:${target.pid},port:${port},instanceId:'1-12345678',releaseSha:'a'.repeat(40),moduleExpression:${JSON.stringify(expression)},guard:async function(options,objects,modules){return this.checkpoint();},
onGuardResult: checkpoint=>writeCheckpointGuardObservation(checkpoint,${JSON.stringify(intent)},'a'.repeat(40),'1-12345678'),
createWebSocket(endpoint){const socket=new WebSocket(endpoint);socket.send=function(raw){const command=JSON.parse(raw);if(command.method==='Runtime.releaseObjectGroup'){process.send({type:'cleanup_started'});if(!${collectorFailure})return;}return actualSend.call(this,raw);};return socket;}});
process.send({type:'final',result});process.exit(result.ok?0:1);`
  );
  controller = spawn(
    process.execPath,
    [
      ...(process.versions.node.startsWith('20.') ? ['--experimental-websocket'] : []),
      join(directory, 'controller.mjs'),
    ],
    {
      stdio: ['ignore', collector.stdin, 'pipe', 'ipc'],
    }
  );
  // One fixed outer-client limit, not a delay added to the live helper.
  // It expires inside the synthetic cleanup's unchanged five-second slice.
  hardLimit = setTimeout(() => {
    controller.kill('SIGKILL');
    collector.kill('SIGKILL');
  }, 3000);
  collector.stdin.on('error', () => {});
  controller.once('close', () => collector.stdin.end());
  let finalResult;
  controller.on('message', (message) => {
    if (message.type === 'final') finalResult = message.result;
  });
  let controllerError = '';
  controller.stderr.on('data', (b) => (controllerError += b));
  // The original controller is killed inside its configured cleanup slice;
  // the real native guard has returned but the cleanup request remains pending.
  await bounded(
    new Promise((r, reject) => {
      controller.on('message', (m) => {
        if (m.type === 'cleanup_started') r();
      });
      controller.once('exit', () =>
        reject(Error('controller ended before cleanup ' + controllerError))
      );
    }),
    4000
  );
  const exit = await bounded(
    new Promise((r) => controller.once('close', (code, signal) => r({ code, signal }))),
    4000
  );
  assert.equal(exit.signal, collectorFailure ? null : 'SIGKILL');
  if (collectorFailure) assert.equal(exit.code, 1);
  if (collector.exitCode === null && collector.signalCode === null)
    await bounded(new Promise((r) => collector.once('close', r)), 2000);
  target.stdin.write('state\n');
  const state = JSON.parse(await next());
  assert.equal(state.calls, 1);
  assert.equal(state.inspectorOpen, !collectorFailure);
  let receipt;
  if (collectorFailure) {
    assert.equal(existsSync(receiptPath), false);
    assert.equal(finalResult.ok, false);
    assert.equal(finalResult.retryAllowed, false);
    assert.equal(finalResult.inspectorClosed, true);
    assert.equal(finalResult.checkpointInvoked, true);
    assert.equal(collector.exitCode, 1);
    assert.ok(journal.includes('guard observation retention refused'));
  } else {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.cleanupStatus, 'not_yet_verified');
    assert.equal(receipt.retryAllowed, false);
    assert.deepEqual(receipt.checkpoint, { ok: true, completedCalls: 1 });
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
    assert.equal(journal.split('LEGACY_CHECKPOINT_GUARD_OBSERVATION=').length - 1, 1);
    assert.equal(finalStdout, '', 'early observation must not change final stdout protocol');
    assert.ok(!JSON.stringify(receipt).includes('synthetic-secret'));
    assert.ok(!('inspectorClosed' in receipt));
    // An existing receipt must not be overwritten, and a different original
    // invocation cannot bind the observed result to itself.
    for (const [binding, path] of [
      [intent, intentPath],
      [intent.replace('12345-1', '12346-1'), join(directory, '12346-1.legacy-checkpoint-intent')],
    ]) {
      const rejected = spawnSync(
        'python3',
        ['-B', resolve('server/scripts/retain-checkpoint-observation.py'), binding, path],
        { input: journal, encoding: 'utf8', timeout: 1000 }
      );
      assert.equal(rejected.status, 1);
      assert.ok(!rejected.stderr.includes('synthetic-secret'));
    }
  }
  assert.ok(!JSON.stringify(finalResult ?? {}).includes('synthetic-secret'));
  assert.ok(!journal.includes('synthetic-secret'));
  if (!collectorFailure) {
    // A cleanup-verified non-acting deferral can retire its intent and later
    // create another under this SAME run key. Preserve both original receipts.
    const nextIntent = intent.replace('1793318400', '1793318401');
    const nextReceipt = {
      ...receipt,
      intentSha256: createHash('sha256').update(nextIntent).digest('hex'),
    };
    rmSync(intentPath);
    writeFileSync(intentPath, nextIntent + '\n', { mode: 0o600, flag: 'wx' });
    const command = [
      '-B',
      resolve('server/scripts/retain-checkpoint-observation.py'),
      nextIntent,
      intentPath,
    ];
    const nextLine = 'LEGACY_CHECKPOINT_GUARD_OBSERVATION=' + JSON.stringify(nextReceipt) + '\n';
    const retained = spawnSync('python3', command, {
      input: nextLine,
      encoding: 'utf8',
      timeout: 1000,
    });
    assert.equal(retained.status, 0, retained.stderr);
    assert.deepEqual(JSON.parse(readFileSync(receiptFor(nextIntent), 'utf8')), nextReceipt);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf8')), receipt);
    const duplicate = spawnSync('python3', command, {
      input: nextLine,
      encoding: 'utf8',
      timeout: 1000,
    });
    assert.equal(duplicate.status, 1, 'a duplicate original intent never overwrites its receipt');
  }
  target.stdin.write('quit\n');
  target.stdin.end();
  await bounded(new Promise((r) => target.once('close', r)), 2000);
  console.log(
    JSON.stringify({
      ok: true,
      guardCalls: state.calls,
      controllerKilled: !collectorFailure,
      cleanupStatus: collectorFailure ? 'verified_after_collector_failure' : receipt.cleanupStatus,
      retryAllowed: false,
      inspectorClosureUnproved: !collectorFailure,
      receiptMode: collectorFailure ? 'not_created' : '0600',
      privateFieldsAbsent: true,
    })
  );
} finally {
  clearTimeout(hardLimit);
  for (const child of [controller, collector, target])
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
}
