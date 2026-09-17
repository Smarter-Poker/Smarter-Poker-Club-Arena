import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
const { runLegacyEngineCheckpoint } = await import(process.argv[3]);
const scenario = process.argv[2];
assert.match(process.version, /^v(?:20|22)\./);
assert.equal(typeof WebSocket, 'function');
assert.equal(typeof process.getBuiltinModule, 'function');
assert.equal(
  typeof process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  'symbol'
);
const directory = mkdtempSync(join(tmpdir(), 'checkpoint-transport-'));
let child, lines, exit, hardStop;
const bounded = (promise, ms = 2500) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('fixture deadline')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
try {
  const mode = ['timeout', 'disconnect'].includes(scenario)
    ? 'hang'
    : scenario === 'exception'
      ? 'throw'
      : 'success';
  const count = scenario === 'zero' ? 0 : scenario === 'two' ? 2 : 1;
  writeFileSync(
    join(directory, 'owner.mjs'),
    [
      'export class GameServer {',
      ' calls=0;',
      ' checkpoint(options,objects,modules){',
      '  this.calls++;',
      "  if(options.expectedPid!==process.pid || objects.length!==1 || objects[0]!==this || modules.gameServer.GameServer.prototype!==Object.getPrototypeOf(this))throw Error('synthetic-secret-identity');",
      "  process.stdout.write(JSON.stringify({type:'guard_started'})+'\\n');",
      "  if(process.argv[2]==='throw')throw Error('synthetic-secret-refusal');",
      "  if(process.argv[2]==='hang')return new Promise(()=>{});",
      "  return {ok:true,completedCalls:1,privatePayload:'synthetic-secret-must-not-export'};",
      ' }',
      '}',
    ].join('\n')
  );
  writeFileSync(
    join(directory, 'target.mjs'),
    [
      "import {createInterface} from 'node:readline';",
      "import {GameServer} from './owner.mjs';",
      'const instances=Array.from({length:' + count + '},()=>new GameServer());',
      "const inspector=process.getBuiltinModule('node:inspector');",
      "const lines=createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');",
      "lines.on('line',line=>{const {type}=JSON.parse(line);",
      " if(type==='state')send({type:'state',pid:process.pid,calls:instances.reduce((n,x)=>n+x.calls,0),inspectorOpen:!!inspector.url()});",
      " if(type==='close'){inspector.close();send({type:'closed'});}",
      " if(type==='quit'){inspector.close();lines.close();process.stdin.pause();}",
      '});',
      "send({type:'ready',pid:process.pid,node:process.version,inspectorOpen:!!inspector.url()});",
    ].join('\n')
  );
  const allocation = createServer();
  await new Promise((resolve, reject) => {
    allocation.once('error', reject);
    allocation.listen(0, '127.0.0.1', resolve);
  });
  const port = allocation.address().port;
  await new Promise((resolve) => allocation.close(resolve));
  child = spawn(
    process.execPath,
    [
      '--inspect-port=127.0.0.1:' + port,
      '--max-old-space-size=64',
      join(directory, 'target.mjs'),
      mode,
    ],
    {
      cwd: directory,
      env: { PATH: dirname(process.execPath), TZ: 'UTC' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  hardStop = setTimeout(() => child.kill('SIGKILL'), 8000);
  const waiting = new Map(),
    queued = new Map();
  lines = createInterface({ input: child.stdout });
  let stderrBytes = 0;
  child.stderr.on('data', (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 16384) child.kill('SIGKILL');
  });
  lines.on('line', (line) => {
    assert.ok(line.length < 4096);
    const value = JSON.parse(line),
      waiter = waiting.get(value.type);
    if (waiter) {
      waiting.delete(value.type);
      waiter(value);
    } else queued.set(value.type, value);
  });
  exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      lines.close();
      resolve({ code, signal });
    })
  );
  const next = (type) => {
    if (queued.has(type)) {
      const value = queued.get(type);
      queued.delete(type);
      return Promise.resolve(value);
    }
    return bounded(new Promise((resolve) => waiting.set(type, resolve)));
  };
  const send = (type) => child.stdin.write(JSON.stringify({ type }) + '\n');
  const ready = await next('ready');
  assert.equal(ready.pid, child.pid);
  assert.equal(ready.inspectorOpen, false);
  const inner =
    'import(' +
    JSON.stringify(pathToFileURL(join(directory, 'owner.mjs')).href) +
    ').then(gameServer=>({gameServer}))';
  const moduleExpression =
    "process.getBuiltinModule('node:vm').runInThisContext(" +
    JSON.stringify(inner) +
    ",{importModuleDynamically:process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})";
  const guard = function (options, objects, modules) {
    return this.checkpoint(options, objects, modules);
  };
  const options = {
    pid: child.pid,
    port,
    releaseSha: '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5',
    instanceId: '1-12345678',
    moduleExpression,
    guard,
    workBudgetMs: 3000,
    cleanupBudgetMs: 2000,
  };
  let expectedCalls = 1,
    result;
  if (scenario === 'preexisting') {
    process.kill(child.pid, 'SIGUSR1');
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await delay(25);
      ready = await fetch('http://127.0.0.1:' + port + '/json/list').then(
        (r) => r.ok,
        () => false
      );
    }
    assert.equal(ready, true);
    result = await runLegacyEngineCheckpoint(options);
    assert.equal(result.reason, 'inspector already active');
    assert.equal(result.inspectorClosed, false);
    assert.equal(result.checkpointInvoked, false);
    assert.equal(result.cleanupConnections, 0);
    send('state');
    assert.deepEqual(await next('state'), {
      type: 'state',
      pid: child.pid,
      calls: 0,
      inspectorOpen: true,
    });
    send('close');
    await next('closed');
    expectedCalls = 0;
  } else if (scenario === 'connection') {
    let connections = 0;
    result = await runLegacyEngineCheckpoint({
      ...options,
      createWebSocket(endpoint) {
        connections++;
        return new WebSocket(
          connections === 1
            ? endpoint.replace(/\/[0-9a-f-]+$/, '/not-an-inspector-target')
            : endpoint
        );
      },
    });
    assert.equal(result.reason, 'inspector connection refused');
    assert.equal(result.cleanupConnections, 1);
    assert.equal(connections, 2);
    assert.equal(result.checkpointInvoked, false);
    expectedCalls = 0;
  } else if (scenario === 'disconnect') {
    const sockets = [];
    const response = runLegacyEngineCheckpoint({
      ...options,
      createWebSocket(endpoint) {
        const socket = new WebSocket(endpoint);
        sockets.push(socket);
        return socket;
      },
    });
    await next('guard_started');
    sockets[0].close();
    result = await response;
    assert.equal(result.reason, 'inspector disconnected; outcome unknown');
    assert.equal(result.cleanupConnections, 1);
    assert.equal(result.checkpointInvoked, true);
    assert.equal(sockets.length, 2);
  } else {
    result = await runLegacyEngineCheckpoint({
      ...options,
      ...(scenario === 'timeout' ? { workBudgetMs: 500 } : {}),
    });
    if (scenario === 'success')
      assert.deepEqual(result, {
        ok: true,
        completedCalls: 1,
        inspectorClosed: true,
        checkpointInvoked: true,
        cleanupConnections: 0,
        retryAllowed: false,
      });
    if (scenario === 'exception')
      assert.equal(result.reason, 'target checkpoint evaluation refused');
    if (scenario === 'timeout') assert.equal(result.reason, 'inspector operation outcome unknown');
    if (['zero', 'two'].includes(scenario)) {
      assert.equal(result.reason, 'target checkpoint evaluation refused');
      assert.equal(result.checkpointInvoked, false);
      expectedCalls = 0;
    }
  }
  assert.equal(result.ok, scenario === 'success');
  assert.equal(result.retryAllowed, false);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  if (scenario !== 'preexisting') assert.equal(result.inspectorClosed, true);
  send('state');
  assert.deepEqual(await next('state'), {
    type: 'state',
    pid: child.pid,
    calls: expectedCalls,
    inspectorOpen: false,
  });
  const refused = await bounded(
    new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        reject(Error('inspector still listening'));
      });
      socket.once('error', (error) => {
        socket.destroy();
        resolve(error.code);
      });
    })
  );
  assert.equal(refused, 'ECONNREFUSED');
  send('quit');
  child.stdin.end();
  assert.deepEqual(await bounded(exit, 1500), { code: 0, signal: null });
  console.log(
    JSON.stringify({
      ok: true,
      scenario,
      node: process.version,
      sameProcessAliveAfterCleanup: true,
      portClosed: true,
      normalExit: true,
    })
  );
} finally {
  clearTimeout(hardStop);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await bounded(exit, 1500);
  }
  lines?.close();
  rmSync(directory, { recursive: true, force: true });
}
