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
// A real timer may wake before its requested wall-clock deadline. Exercise
// that boundary deterministically while retaining the actual inspector/target.
const originalSetTimeout = globalThis.setTimeout;
let earlyRequestTimerCallbacks = 0;
if (scenario === 'early_timeout') {
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (typeof callback === 'function' && callback.toString().includes('request_timeout')) {
      return originalSetTimeout(
        () => {
          earlyRequestTimerCallbacks++;
          callback(...args);
        },
        Math.max(1, ms - 10)
      );
    }
    return originalSetTimeout(callback, ms, ...args);
  };
}
// The runtimes this fixture is allowed to prove itself on. CI stays pinned to
// 20 and 22; 24 is the configured local precheck runtime and its native
// census scenario is exercised below. 26 is here because the Mac that runs the local prechecks is on it,
// and the GATE - not the behaviour - was what failed there. All twelve
// scenarios were run on v26.3.0 before this line was widened and every one
// exited 0 with sameProcessAliveAfterCleanup, portClosed and normalExit true.
// Nothing below this line is relaxed.
assert.match(process.version, /^v(?:20|22|24|26)\./);
assert.equal(typeof WebSocket, 'function');
assert.equal(typeof process.getBuiltinModule, 'function');
assert.equal(
  typeof process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  'symbol'
);
const directory = mkdtempSync(join(tmpdir(), 'checkpoint-transport-'));
let child, lines, exit, hardStop;
let stdoutEnded = false,
  targetExit,
  stderrBytes = 0,
  syntheticStderr = Buffer.alloc(0);
const startedAt = Date.now(),
  lifecycle = [];
const mark = (stage) => lifecycle.push({ stage, elapsedMs: Date.now() - startedAt });
const bounded = (promise, ms = 2500, stage = 'fixture') => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('fixture deadline: ' + stage)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
try {
  const mode = scenario.startsWith('census_counts')
    ? 'census_refusal'
    : ['timeout', 'early_timeout', 'disconnect'].includes(scenario)
      ? 'hang'
      : scenario === 'exception'
        ? 'throw'
        : scenario === 'protocol_error'
          ? 'protocol_error'
          : scenario.startsWith('refusal')
            ? 'refusal'
            : scenario === 'malformed_refusal'
              ? 'malformed_refusal'
              : 'success';
  const count = scenario === 'zero' ? 0 : scenario === 'two' ? 2 : 1;
  writeFileSync(
    join(directory, 'owner.mjs'),
    [
      'export class GameServer {',
      ' calls=0;',
      ' checkpoint(options,objects,modules,engines,managers,workers,hosts){',
      '  this.calls++;',
      "  if(['engine_census','shared_deadline','shared_deadline_exhausted','census_counts','census_counts_unknown'].includes(process.argv[3]) && (!Array.isArray(hosts)||hosts.length!==2||!hosts.every(h=>Object.getPrototypeOf(h)===modules.lightningHost.LightningHandHost.prototype)))throw Error('lightning host census refused');",
      "  if(['engine_census','shared_deadline','shared_deadline_exhausted','census_counts','census_counts_unknown'].includes(process.argv[3]) && (!Array.isArray(workers)||workers.length!==2||!workers.every(w=>Object.getPrototypeOf(w)===modules.lightningWorker.LightningClusterWorker.prototype)||new Set(workers.map(w=>w.kind)).size!==2))throw Error('lightning census refused');",
      "  if(['engine_census','shared_deadline','shared_deadline_exhausted','census_counts','census_counts_unknown'].includes(process.argv[3]) && (!Array.isArray(engines)||engines.length!==2||!engines.every(e=>Object.getPrototypeOf(e)===modules.engine.ServerTableEngine.prototype)||new Set(engines.map(e=>e.kind)).size!==2))throw Error('engine census refused');",
      "  if(['engine_census','shared_deadline','shared_deadline_exhausted','census_counts','census_counts_unknown'].includes(process.argv[3]) && (!Array.isArray(managers)||managers.length!==2||!managers.every(m=>Object.getPrototypeOf(m)===modules.manager.TournamentManager.prototype)||new Set(managers.map(m=>m.kind)).size!==2))throw Error('manager census refused');",
      "  if(options.expectedPid!==process.pid || objects.length!==1 || objects[0]!==this || modules.gameServer.GameServer.prototype!==Object.getPrototypeOf(this))throw Error('synthetic-secret-identity');",
      "  process.stdout.write(JSON.stringify({type:'guard_started'})+'\\n');",
      "  if(process.argv[2]==='throw')throw Error('synthetic-secret-refusal');",
      // A value the inspector cannot return by value (a BigInt): the CDP
      // answer is an error object, not a result, and the client must say so.
      "  if(process.argv[2]==='protocol_error')return {ok:true,completedCalls:1,unreturnable:1n};",
      "  if(process.argv[2]==='hang'){globalThis.__legacyEngineCheckpointProgress={schema:'legacy-engine-checkpoint-progress/v1',elapsedMs:123,stage:'preflight',note:'joinPreviousWork',detail:'rpc=fn_f06_prepare_mixed_manager_custody,phase=commit',attemptedTables:0,completedCalls:0,verifiedTables:0,reason:null,privatePayload:'synthetic-secret-must-not-export'};return new Promise(()=>{});}",
      "  if(['refusal','census_refusal'].includes(process.argv[2]))return {schema:'legacy-engine-checkpoint/v1',ok:false,reason:process.argv[2]==='census_refusal'?'retained_lightning_host_census_unproven':'mixed_bank_not_restorable',stage:'preflight',attemptedTables:0,completedCalls:0,verifiedTables:0,bankCount:0,uninitializedSeats:0,remainingMs:null,readyForRestart:false,checkpointOutcome:'not_started',paidAccountingQualification:'native_pending_registry_unqualified',restartAuthorized:false,privatePayload:'synthetic-secret-must-not-export',holeCards:['As','Kd'],credentials:'synthetic-secret-credential'};",
      "  if(process.argv[2]==='malformed_refusal')return {schema:'synthetic-secret-schema',ok:false,reason:'synthetic-secret-refusal',stage:'synthetic-secret-stage',attemptedTables:'synthetic-secret-count',completedCalls:-1,verifiedTables:0.5,bankCount:Infinity,uninitializedSeats:true,remainingMs:-1,readyForRestart:'synthetic-secret-ready',checkpointOutcome:'synthetic-secret-outcome',paidAccountingQualification:'synthetic-secret-accounting',restartAuthorized:true};",
      "  return {ok:true,completedCalls:1,privatePayload:'synthetic-secret-must-not-export'};",
      ' }',
      '}',
      'export class ServerTableEngine { constructor(kind){this.kind=kind;} }',
      'export class TournamentManager { constructor(kind){this.kind=kind;} }',
      'export class LightningClusterWorker { constructor(kind){this.kind=kind;} }',
      'export class LightningHandHost { constructor(kind){this.kind=kind;} }',
    ].join('\n')
  );
  writeFileSync(
    join(directory, 'target.mjs'),
    [
      "import {createInterface} from 'node:readline';",
      "import {GameServer,ServerTableEngine,TournamentManager,LightningClusterWorker,LightningHandHost} from './owner.mjs';",
      'const instances=Array.from({length:' + count + '},()=>new GameServer());',
      "const engineInstances=[new ServerTableEngine('registered'),new ServerTableEngine('detached')];",
      "const managerInstances=[new TournamentManager('registered'),new TournamentManager('detached')];",
      "const lightningWorkerInstances=process.argv[3]==='census_counts_zero'?[]:[new LightningClusterWorker('registered'),new LightningClusterWorker('detached')];",
      "const lightningHostInstances=process.argv[3]==='census_counts_zero'?[]:[new LightningHandHost('registered'),new LightningHandHost('detached')];",
      "const inspector=process.getBuiltinModule('node:inspector');",
      "const lines=createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');",
      "lines.on('line',line=>{const {type}=JSON.parse(line);",
      " if(type==='state')send({type:'state',pid:process.pid,calls:instances.reduce((n,x)=>n+x.calls,0),inspectorOpen:!!inspector.url(),...(['engine_census','shared_deadline','shared_deadline_exhausted','census_counts','census_counts_unknown'].includes(process.argv[3])?{engineCount:engineInstances.length,managerCount:managerInstances.length,lightningWorkerCount:lightningWorkerInstances.length,lightningHostCount:lightningHostInstances.length}:{})});",
      " if(type==='close'){inspector.close();send({type:'closed'});}",
      " if(type==='quit'){inspector.close();lines.close();process.stdin.pause();}",
      '});',
      "globalThis.gc();send({type:'ready',pid:process.pid,node:process.version,inspectorOpen:!!inspector.url(),...(['engine_census','shared_deadline','shared_deadline_exhausted','census_counts','census_counts_unknown'].includes(process.argv[3])?{engineCount:engineInstances.length,managerCount:managerInstances.length,lightningWorkerCount:lightningWorkerInstances.length,lightningHostCount:lightningHostInstances.length}:{})});",
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
      '--expose-gc',
      scenario === 'memory_refusal' ? '--max-old-space-size=32' : '--max-old-space-size=64',
      ...(scenario === 'memory_refusal' ? ['--max-semi-space-size=1'] : []),
      join(directory, 'target.mjs'),
      mode,
      scenario,
    ],
    {
      cwd: directory,
      env: { PATH: dirname(process.execPath), TZ: 'UTC' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  hardStop = setTimeout(() => child.kill('SIGKILL'), scenario === 'shared_deadline' ? 35000 : 8000);
  const waiting = new Map(),
    queued = new Map();
  let channelFailure;
  const failChannel = (reason) => {
    channelFailure ??= Error(reason);
    for (const waiter of waiting.values()) waiter.reject(channelFailure);
    waiting.clear();
  };
  child.on('error', () => failChannel('fixture child process error'));
  child.stdin.on('error', () => failChannel('fixture stdin error'));
  child.stdout.on('error', () => failChannel('fixture stdout error'));
  child.stdout.on('end', () => {
    stdoutEnded = true;
    failChannel('fixture stdout ended');
  });
  child.stderr.on('error', () => failChannel('fixture stderr error'));
  lines = createInterface({ input: child.stdout });
  lines.on('error', () => failChannel('fixture response reader error'));
  child.stderr.on('data', (bytes) => {
    stderrBytes += bytes.length;
    // This child loads only the generated synthetic fixture, never application
    // data or credentials. Preserve a bounded tail for native termination proof.
    syntheticStderr = Buffer.concat([syntheticStderr, bytes.subarray(-8192)]).subarray(-8192);
    if (bytes.includes('Debugger attached.')) mark('debugger_attached');
    if (bytes.includes('Debugger ending')) mark('debugger_ending');
    if (bytes.includes('Waiting for the debugger to disconnect'))
      mark('waiting_for_debugger_disconnect');
    if (stderrBytes > 16384) child.kill('SIGKILL');
  });
  lines.on('line', (line) => {
    try {
      assert.ok(line.length < 4096);
      const value = JSON.parse(line),
        waiter = waiting.get(value.type);
      assert.ok(['ready', 'state', 'closed', 'guard_started'].includes(value.type));
      mark('received_' + value.type);
      if (waiter) {
        waiting.delete(value.type);
        waiter.resolve(value);
      } else queued.set(value.type, value);
    } catch {
      failChannel('fixture response malformed');
    }
  });
  exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      targetExit = { code, signal };
      mark('target_exit');
      failChannel('fixture target exited');
      lines.close();
      resolve({ code, signal });
    })
  );
  const next = (type) => {
    if (channelFailure) return Promise.reject(channelFailure);
    if (queued.has(type)) {
      const value = queued.get(type);
      queued.delete(type);
      return Promise.resolve(value);
    }
    return bounded(
      new Promise((resolve, reject) => waiting.set(type, { resolve, reject })),
      2500,
      'await_' + type
    ).finally(() => waiting.delete(type));
  };
  const send = (type) => {
    if (channelFailure) throw channelFailure;
    mark('send_' + type);
    return child.stdin.write(JSON.stringify({ type }) + '\n', (error) => {
      if (error) failChannel('fixture stdin write failed');
    });
  };
  const ready = await next('ready');
  assert.equal(ready.pid, child.pid);
  assert.equal(ready.inspectorOpen, false);
  const inner =
    'import(' +
    JSON.stringify(pathToFileURL(join(directory, 'owner.mjs')).href) +
    ').then(gameServer=>({gameServer,engine:gameServer,manager:gameServer,lightningWorker:gameServer,lightningHost:gameServer}))';
  const moduleExpression =
    "process.getBuiltinModule('node:vm').runInThisContext(" +
    JSON.stringify(inner) +
    ",{importModuleDynamically:process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})";
  const guard = function (options, objects, modules, engines, managers, workers, hosts) {
    return this.checkpoint(options, objects, modules, engines, managers, workers, hosts);
  };
  const options = {
    pid: child.pid,
    port,
    releaseSha: '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5',
    instanceId: '1-12345678',
    moduleExpression,
    guard,
    discoverEngines: [
      'engine_census',
      'shared_deadline',
      'shared_deadline_exhausted',
      'memory_refusal',
      'census_counts',
      'census_counts_unknown',
      'census_counts_zero',
    ].includes(scenario),
    workBudgetMs: 3000,
    cleanupBudgetMs: 2000,
  };
  let clientCloseCalls = 0,
    clientCloseWhileOpen = 0,
    withheldCloseNotifications = 0,
    nativeCensusRequests = 0;
  const nativeOrder = [];
  const sharedDeadline = Date.now() + 30000;
  const observedWebSocket = (endpoint) => {
    const socket = new WebSocket(endpoint);
    if (
      [
        'engine_census',
        'shared_deadline',
        'shared_deadline_exhausted',
        'memory_refusal',
        'census_counts',
        'census_counts_unknown',
        'census_counts_zero',
      ].includes(scenario)
    ) {
      let firstCensusId = null;
      const groupReplyIndices = new Map();
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const message = JSON.parse(raw);
        if (message.method === 'Runtime.callFunctionOn') {
          const group = /^function\(\) \{ return this\[([0-4])\]; \}$/.exec(
            message.params.functionDeclaration
          );
          if (group) groupReplyIndices.set(message.id, Number(group[1]));
        }
        if (message.method === 'Runtime.queryObjects') {
          nativeCensusRequests++;
          nativeOrder.push('census');
          if (firstCensusId === null) firstCensusId = message.id;
        }
        if (
          message.method === 'Runtime.releaseObjectGroup' &&
          message.params.objectGroup === 'legacy-broad-census'
        )
          nativeOrder.push('broadReleased');
        if (
          message.method === 'Runtime.callFunctionOn' &&
          message.params.functionDeclaration === guard.toString()
        )
          nativeOrder.push('guard');
        return send(raw);
      };
      const add = socket.addEventListener.bind(socket);
      socket.addEventListener = (type, listener, options) =>
        add(
          type,
          type === 'message'
            ? (event) => {
                if (scenario === 'census_counts_unknown') {
                  const message = JSON.parse(event.data);
                  const index = groupReplyIndices.get(message.id);
                  if (index !== undefined) {
                    // Keep the actual native handle and array. Only metadata
                    // is malformed: it must never fabricate physical absence.
                    const descriptor = message.result.result;
                    if (index === 0) descriptor.type = 'number';
                    if (index === 1) descriptor.description = 'Array(0002)';
                    if (index === 2) descriptor.description = 'Array(2001)';
                    if (index === 3) descriptor.className = 'synthetic-secret-census-class';
                    if (index === 4) {
                      descriptor.subtype = 'object';
                      descriptor.description = 'synthetic-secret-census-description';
                    }
                    return listener({ data: JSON.stringify(message) });
                  }
                }
                if (
                  ['shared_deadline', 'shared_deadline_exhausted'].includes(scenario) &&
                  JSON.parse(event.data).id === firstCensusId
                )
                  setTimeout(() => listener(event), scenario === 'shared_deadline' ? 21000 : 700);
                else listener(event);
              }
            : listener,
          options
        );
    }
    const close = socket.close.bind(socket);
    socket.close = (...args) => {
      clientCloseCalls++;
      if (socket.readyState === WebSocket.OPEN) clientCloseWhileOpen++;
      return close(...args);
    };
    if (['cleanup_close_timeout', 'refusal_cleanup_timeout'].includes(scenario)) {
      const addEventListener = socket.addEventListener.bind(socket);
      socket.addEventListener = (type, listener, options) =>
        addEventListener(
          type,
          type === 'close'
            ? () => {
                withheldCloseNotifications++;
              }
            : listener,
          options
        );
    }
    return socket;
  };
  let expectedCalls = 1,
    result;
  if (['deadline_expired', 'deadline_future'].includes(scenario)) {
    await assert.rejects(
      runLegacyEngineCheckpoint({
        ...options,
        checkpointDeadlineMs: scenario === 'deadline_expired' ? Date.now() - 1 : Date.now() + 41000,
      }),
      /legacy checkpoint invocation identity refused/
    );
    assert.equal(stderrBytes, 0, 'invalid deadlines refuse before opening the inspector');
    result = {
      ok: false,
      retryAllowed: false,
      checkpointInvoked: false,
      inspectorClosed: true,
      cleanupConnections: 0,
    };
    expectedCalls = 0;
  } else if (scenario === 'preexisting') {
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
      ...(['timeout', 'early_timeout'].includes(scenario) ? { workBudgetMs: 500 } : {}),
      ...(scenario === 'shared_deadline'
        ? { workBudgetMs: 20000, checkpointDeadlineMs: sharedDeadline }
        : {}),
      ...(scenario === 'shared_deadline_exhausted'
        ? { workBudgetMs: 20000, cleanupBudgetMs: 200, checkpointDeadlineMs: Date.now() + 800 }
        : {}),
      ...([
        'success',
        'engine_census',
        'shared_deadline',
        'shared_deadline_exhausted',
        'memory_refusal',
        'census_counts',
        'census_counts_unknown',
        'census_counts_zero',
        'cleanup_close_timeout',
        'refusal_cleanup_timeout',
      ].includes(scenario)
        ? { createWebSocket: observedWebSocket }
        : {}),
      ...(['cleanup_close_timeout', 'refusal_cleanup_timeout'].includes(scenario)
        ? { cleanupBudgetMs: 200 }
        : {}),
    });
    if (scenario.startsWith('census_counts')) {
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'retained_lightning_host_census_unproven');
      assert.equal(result.retryAllowed, false);
      assert.equal(result.checkpointInvoked, true);
      assert.equal(result.inspectorClosed, true);
      assert.equal(result.checkpoint.attemptedTables, 0);
      assert.equal(result.checkpoint.completedCalls, 0);
      assert.deepEqual(result.nativeCensusCounts, {
        schema: 'legacy-native-census-counts/v1',
        gameServers: scenario === 'census_counts_unknown' ? null : 1,
        tableEngines: scenario === 'census_counts_unknown' ? null : 2,
        tournamentManagers: scenario === 'census_counts_unknown' ? null : 2,
        lightningWorkers:
          scenario === 'census_counts_unknown' ? null : scenario === 'census_counts_zero' ? 0 : 2,
        lightningHosts:
          scenario === 'census_counts_unknown' ? null : scenario === 'census_counts_zero' ? 0 : 2,
      });
      assert.equal(nativeCensusRequests, 1);
      assert.deepEqual(nativeOrder, ['census', 'broadReleased', 'guard', 'broadReleased']);
      assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
      assert.ok(JSON.stringify(result.nativeCensusCounts).length < 220);
    }
    if (scenario === 'engine_census') assert.equal(result.nativeCensusCounts, undefined);
    if (scenario === 'success')
      assert.deepEqual(result, {
        ok: true,
        completedCalls: 1,
        inspectorClosed: true,
        checkpointInvoked: true,
        cleanupConnections: 0,
        retryAllowed: false,
      });
    if (scenario === 'memory_refusal') {
      assert.equal(result.reason, 'native census memory headroom refused');
      assert.equal(result.checkpointInvoked, false);
      assert.equal(nativeCensusRequests, 0);
      assert.equal(result.censusMemory.ok, false);
      assert.ok(result.censusMemory.availableHeapBytes < result.censusMemory.requiredHeapBytes);
      expectedCalls = 0;
    }
    if (scenario === 'shared_deadline_exhausted') {
      assert.equal(result.reason, 'inspector operation outcome unknown');
      assert.equal(result.checkpointInvoked, false);
      assert.equal(nativeCensusRequests, 1);
      assert.match(result.transportDetail, /^op=queryObjects,cause=request_timeout/);
      expectedCalls = 0;
    }
    if (scenario === 'exception')
      assert.equal(result.reason, 'target checkpoint evaluation refused');
    if (scenario === 'protocol_error') {
      // A PROTOCOL REFUSAL SAYS WHICH ONE (2026-10-30, run 41071578166): the
      // reason does not move, and the detail names the operation, the CDP
      // method and the inspector's own error.
      assert.equal(result.reason, 'inspector protocol refused');
      assert.equal(result.checkpointInvoked, true);
      assert.equal(result.retryAllowed, false);
      assert.match(
        result.transportDetail,
        /^op=guardCall,cause=cdp_error,method=Runtime.callFunctionOn,code=-?\d+,message=/
      );
      assert.ok(!JSON.stringify(result).includes('unreturnable'));
    }
    if (['timeout', 'early_timeout'].includes(scenario)) {
      assert.equal(result.reason, 'inspector operation outcome unknown');
      // An unknown outcome says how far the guard got (2026-09-24): the
      // record it left on the target's global object, held to its shape, and
      // nothing else that was on it.
      assert.deepEqual(result.progress, {
        elapsedMs: 123,
        attemptedTables: 0,
        completedCalls: 0,
        verifiedTables: 0,
        stage: 'preflight',
        note: 'joinPreviousWork',
        detail: 'rpc=fn_f06_prepare_mixed_manager_custody,phase=commit',
      });
      // AN UNKNOWN OUTCOME NAMES ITS OPERATION AND ITS DEADLINE (2026-09-25).
      // Run 36144233010 reported this reason and nothing else, so it could not
      // say whether the budget had already been spent before the call was
      // issued or whether the call was issued and outran the slice it was
      // given. Here it is the second, and it says so - naming the operation,
      // the CDP method, the milliseconds the operation was allowed and the
      // milliseconds it actually waited. The refusal itself does not move:
      // `reason` is byte-identical and `retryAllowed` is still false.
      assert.match(
        result.transportDetail,
        /^op=guardCall,cause=request_timeout,method=Runtime\.callFunctionOn,allowanceMs=\d+,waitedMs=\d+,budgetMs=500,spentMs=\d+,invoked=yes$/
      );
      const allowanceMs = Number(/allowanceMs=(\d+)/.exec(result.transportDetail)[1]);
      const waitedMs = Number(/waitedMs=(\d+)/.exec(result.transportDetail)[1]);
      // The operation was given what was LEFT of the 500ms work budget, not
      // the whole of it, and it waited that out. This is the number that says
      // whether the fix is a bigger budget or a cheaper operation, and until
      // today it was never written down.
      assert.ok(allowanceMs > 0 && allowanceMs < 500, 'allowance is the remaining slice');
      assert.ok(
        waitedMs >= allowanceMs,
        `the operation waited out its whole slice: waited=${waitedMs}, allowance=${allowanceMs}`
      );
      if (scenario === 'early_timeout')
        assert.ok(earlyRequestTimerCallbacks > 1, 'early wake rechecks the same deadline');
      assert.equal(result.retryAllowed, false);
      assert.equal(result.checkpointInvoked, true);
      assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    }
    if (['success', 'cleanup_close_timeout', 'refusal_cleanup_timeout'].includes(scenario)) {
      assert.equal(clientCloseWhileOpen, 0, 'client must not race the native inspector close');
      assert.equal(clientCloseCalls, 0, 'scheduled native shutdown owns the close handshake');
    }
    if (['cleanup_close_timeout', 'refusal_cleanup_timeout'].includes(scenario)) {
      assert.equal(result.reason, 'inspector cleanup not verified');
      assert.equal(result.inspectorClosed, false);
      assert.equal(result.checkpointInvoked, true);
      assert.equal(result.cleanupConnections, 0);
      assert.ok(
        withheldCloseNotifications > 0,
        'real close notification was deliberately withheld'
      );
    }
    if (scenario.startsWith('refusal')) {
      assert.equal(
        result.reason,
        scenario === 'refusal' ? 'mixed_bank_not_restorable' : 'inspector cleanup not verified'
      );
      assert.deepEqual(result.checkpoint, {
        schema: 'legacy-engine-checkpoint/v1',
        ok: false,
        reason: 'mixed_bank_not_restorable',
        stage: 'preflight',
        attemptedTables: 0,
        completedCalls: 0,
        verifiedTables: 0,
        bankCount: 0,
        uninitializedSeats: 0,
        readyForRestart: false,
        checkpointOutcome: 'not_started',
        paidAccountingQualification: 'native_pending_registry_unqualified',
        restartAuthorized: false,
      });
    }
    if (scenario === 'malformed_refusal') {
      assert.equal(result.reason, 'native checkpoint did not qualify');
      assert.deepEqual(result.checkpoint, { ok: false });
    }
    if (['zero', 'two'].includes(scenario)) {
      assert.equal(result.reason, 'target checkpoint evaluation refused');
      assert.equal(result.checkpointInvoked, false);
      expectedCalls = 0;
    }
  }
  assert.equal(
    result.ok,
    ['success', 'engine_census', 'shared_deadline'].includes(scenario),
    JSON.stringify(result)
  );
  if (scenario === 'engine_census') {
    assert.equal(nativeCensusRequests, 1, 'all five exact classes share one full-heap native scan');
    assert.deepEqual(nativeOrder.slice(0, 3), ['census', 'broadReleased', 'guard']);
  }
  if (scenario === 'shared_deadline') {
    assert.equal(nativeCensusRequests, 1);
    assert.ok(
      Date.now() <= sharedDeadline,
      'native work and cleanup stayed inside the original absolute deadline'
    );
  }
  mark('driver_returned');
  assert.equal(result.retryAllowed, false);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  if (!['preexisting', 'cleanup_close_timeout', 'refusal_cleanup_timeout'].includes(scenario))
    assert.equal(result.inspectorClosed, true);
  send('state');
  assert.deepEqual(await next('state'), {
    type: 'state',
    pid: child.pid,
    calls: expectedCalls,
    inspectorOpen: false,
    ...([
      'engine_census',
      'shared_deadline',
      'shared_deadline_exhausted',
      'census_counts',
      'census_counts_unknown',
    ].includes(scenario)
      ? { engineCount: 2, managerCount: 2, lightningWorkerCount: 2, lightningHostCount: 2 }
      : {}),
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
    }),
    2500,
    'port_refusal'
  );
  assert.equal(refused, 'ECONNREFUSED');
  send('quit');
  child.stdin.end();
  assert.deepEqual(await bounded(exit, 1500, 'normal_exit'), { code: 0, signal: null });
  console.log(
    JSON.stringify({
      ok: true,
      scenario,
      node: process.version,
      sameProcessAliveAfterCleanup: true,
      portClosed: true,
      normalExit: true,
      ...(scenario.includes('refusal') ? { checkpointResult: result } : {}),
    })
  );
} catch (error) {
  // Pipe EOF can precede the exit event. Observe that original outcome before
  // finally's forced cleanup could replace it with a fixture-originated signal.
  if (stdoutEnded && exit && !targetExit)
    await bounded(exit, 1500, 'failure_exit_observation').catch(() => {});
  console.error(
    JSON.stringify({
      scenario,
      lifecycle,
      childExited: child?.exitCode !== null,
      childSignalled: child?.signalCode !== null,
      targetExit: targetExit ?? null,
      targetStderrBytes: stderrBytes,
      targetStderrTail: syntheticStderr.toString('utf8'),
    })
  );
  throw error;
} finally {
  globalThis.setTimeout = originalSetTimeout;
  clearTimeout(hardStop);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await bounded(exit, 1500, 'cleanup_exit');
  }
  lines?.close();
  rmSync(directory, { recursive: true, force: true });
}
