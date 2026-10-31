import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
const child = spawn(
  process.execPath,
  [
    '--max-old-space-size=4096',
    new URL('./legacy-census-interruption-target.mjs', import.meta.url).pathname,
    process.argv[2],
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
let ws;
const targetExited = new Promise((resolve) => child.once('exit', resolve));
const fixtureDeadline = setTimeout(() => {
  child.kill('SIGKILL');
  process.exitCode = 1;
}, 35000);
fixtureDeadline.unref();
try {
  const endpoint = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (x) => {
      out += x;
      try {
        resolve(JSON.parse(out.trim()).endpoint);
      } catch {}
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(Error('early targetexit ' + code)));
  });
  ws = new WebSocket(endpoint);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  });
  const post = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  assert.equal(process.version, 'v22.23.2');
  await post('Debugger.enable', {});
  let paused = 0;
  const pauseWitnesses = [];
  let pauseProof = Promise.resolve();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Debugger.paused') {
      paused++;
      pauseProof = (async () => {
        try {
          const proof = await post('Debugger.evaluateOnCallFrame', {
            callFrameId: m.params.callFrames[0].callFrameId,
            expression:
              'globalThis.__concurrent.tops.every(x=>Object.getPrototypeOf(x)===Object.prototype)',
            returnByValue: true,
          });
          pauseWitnesses.push(proof.result.value);
        } finally {
          await post('Debugger.resume', {});
        }
      })();
    }
  });
  const holderKey = '__legacyEngineCensus_33333333333333333333333333333333';
  const deadline = Date.now() + 30000;
  const modules = await post('Runtime.evaluate', {
    expression: 'globalThis.__concurrent.modules',
    objectGroup: 'concurrent',
  });
  const source = await import(process.argv[2]);
  const bound = await post('Runtime.callFunctionOn', {
    objectId: modules.result.objectId,
    functionDeclaration: source.bindLegacyCensusModules.toString(),
    arguments: [{ value: holderKey }, { value: deadline }],
    returnByValue: true,
  });
  assert.equal(bound.exceptionDetails, undefined);
  assert.equal(bound.result.value, true);
  const began = performance.now();
  let workSettled = false;
  const work = post('Runtime.evaluate', {
    expression: `Promise.resolve().then(()=>globalThis.__concurrent.record('promise'));process.nextTick(()=>globalThis.__concurrent.record('nextTick'));setImmediate(()=>globalThis.__concurrent.record('immediate'));(${source.collectMarkedLegacyCensus.toString()})(${JSON.stringify(holderKey)},${deadline})`,
    disableBreaks: true,
    awaitPromise: false,
    objectGroup: 'concurrent',
  });
  void work.then(
    () => {
      workSettled = true;
    },
    () => {
      workSettled = true;
    }
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    workSettled,
    false,
    'interruptions must be dispatched while native work is outstanding'
  );
  const cleanupMode = true;
  const pause = post('Debugger.pause', {});
  const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
  const interrupt = post('Runtime.evaluate', {
    expression:
      '({elapsed:Date.now(),restored:globalThis.__concurrent.tops.every(x=>Object.getPrototypeOf(x)===Object.prototype)})',
    returnByValue: true,
  });
  const cleanup = post('Runtime.evaluate', {
    expression: `(${source.retireLegacyCensusBinding.toString()})(${JSON.stringify(holderKey)},${deadline})`,
    disableBreaks: true,
    returnByValue: true,
  });
  const [worked, observed, , retired] = await Promise.all([work, interrupt, pause, cleanup]);
  assert.equal(retired.exceptionDetails, undefined);
  assert.equal(retired.result.value, true);
  assert.equal(worked.exceptionDetails, undefined, JSON.stringify(worked.exceptionDetails));
  await new Promise((r) => setTimeout(r, 30));
  const witnesses = await post('Runtime.evaluate', {
    expression: 'globalThis.__concurrent.events',
    returnByValue: true,
  });
  await pauseProof;
  assert.equal(paused, 1);
  assert.deepEqual(pauseWitnesses, [true]);
  const events = witnesses.result.value;
  assert.equal(observed.result.value.restored, true);
  assert.equal(
    events.every((x) => x.restored),
    true
  );
  for (const kind of ['promise', 'nextTick', 'immediate', 'async_before'])
    assert.ok(
      events.some((x) => x.kind === kind),
      kind
    );
  let nativeClosed = false;
  if (cleanupMode) {
    await post('Runtime.releaseObjectGroup', { objectGroup: 'concurrent' });
    await post('Runtime.evaluate', {
      expression:
        "setImmediate(() => process.getBuiltinModule('node:inspector').close()); undefined",
      returnByValue: true,
    });
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(Error('cleanup timeout')), 5000)),
    ]);
    const port = Number(new URL(endpoint).port);
    const portClosed = await new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', (error) => {
        socket.destroy();
        resolve(error.code === 'ECONNREFUSED');
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    assert.equal(portClosed, true, 'original inspector port must refuse connections');
    assert.equal(child.exitCode, null, 'target must remain alive after inspector cleanup');
    assert.equal(child.signalCode, null, 'target must not have been killed');
    assert.equal(child.kill(0), true, 'original target process remains alive');
    nativeClosed = true;
  }
  assert.ok(performance.now() - began < 30000);
  console.log(
    JSON.stringify({
      ok: true,
      paused,
      pauseWitnesses,
      disabledBreaks: true,
      version: process.version,
      elapsedMs: performance.now() - began,
      simulatedWorkDeadlineMs: 100,
      concurrentBindingCleanup: true,
      workOutstandingAtInterrupt: true,
      cleanupMode,
      nativeClosed,
      portClosed: nativeClosed,
      sameProcessAliveAfterCleanup: true,
      concurrentEvaluate: observed.result.value,
      events,
      allRestored: true,
    })
  );
} finally {
  ws?.close();
  child.kill('SIGTERM');
  const killDeadline = setTimeout(() => child.kill('SIGKILL'), 1000);
  await targetExited;
  clearTimeout(killDeadline);
  clearTimeout(fixtureDeadline);
}
