// Isolated qualification only: no production host, credentials or game API.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const fixtureImage =
  'node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const fixtureSource = 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
const fixtureNativeVersion = 'v22.23.2';
const fixtureStarted = Date.now();
const fixtureDeadline = fixtureStarted + 210000;
// Ten seconds of the overall bound remain exclusively for owned cleanup.
const fixtureWorkDeadline = fixtureDeadline - 10000;
const fixtureExec = promisify(execFile);
const fixtureWitness = randomUUID();
const fixtureName = 'main-inspector-qualification-' + fixtureWitness;
const fixtureLabel = 'smarter-poker.test.main-inspector';
let fixtureDirectory;
let fixtureContainerAttempted = false;
let fixtureContainerId;
let fixtureFailure;
let fixtureVerdict;

async function fixtureDocker(args, timeout = 10000, cleanup = false) {
  const remaining = Math.min(
    timeout,
    (cleanup ? fixtureDeadline : fixtureWorkDeadline) - Date.now()
  );
  if (remaining <= 0) throw new Error('container_qualification_deadline');
  const { stdout } = await fixtureExec('docker', args, {
    timeout: remaining,
    killSignal: 'SIGKILL',
    maxBuffer: 1048576,
  });
  return stdout.trim();
}
function fixtureTuple(value) {
  assert.equal(value.State.Running, true);
  assert.equal(value.Config.Labels[fixtureLabel], fixtureWitness);
  return {
    id: value.Id,
    image: value.Image,
    startedAt: value.State.StartedAt,
    hostPid: value.State.Pid,
  };
}
async function fixtureInspect() {
  const value = JSON.parse(await fixtureDocker(['inspect', '--format', '{{json .}}', fixtureName]));
  fixtureTuple(value);
  return value;
}
async function fixtureHealth(container, path = '/health', waitMs = 1500) {
  assert.ok(['/health', '/fixture-reopen', '/fixture-delay-close'].includes(path));
  const expression = `const http=require('node:http');const r=http.get('http://127.0.0.1:8080${path}',res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{if(res.statusCode!==200)process.exit(2);console.log(b);});});r.on('error',()=>process.exit(3));r.setTimeout(${waitMs},()=>{r.destroy();process.exit(4);});`;
  return JSON.parse(
    await fixtureDocker(
      [
        'exec',
        container,
        'env',
        '-u',
        'NODE_OPTIONS',
        '-u',
        'NODE_PATH',
        'node',
        '--no-inspect',
        '-e',
        expression,
      ],
      waitMs + 1500
    )
  );
}
async function fixtureNativeEntry(container, identity, scenario = 'success', hostWrapper = false) {
  assert.ok(['success', 'deferred-close-timeout'].includes(scenario));
  const maintainedSource = [
    'retire-owned-main-inspector.mjs',
    'main-inspector-socket-qualification.mjs',
    'main-inspector-retirement-entry.mjs',
  ]
    .map((name) =>
      fs.readFileSync(new URL('../../server/scripts/' + name, import.meta.url), 'utf8')
    )
    .join('\n');
  const busyNonce = randomUUID();
  const busyMarker = '/fixture-state/busy-' + busyNonce + '.json';
  const busyObservation = '/fixture-state/observed-' + busyNonce + '.json';
  // The fault belongs after actual kernel close qualification. Starting busy
  // JavaScript before attachment can correctly refuse at attach and never
  // exercise the native-close interruption this case is intended to qualify.
  // Observe the real fixed-command send only in the UNKNOWN fixture: request
  // the target's ordinary busy loop, then forward the exact native bytes once.
  // No Inspector reply, ACK, close implementation or deadline is substituted.
  const closeBoundaryLoad =
    scenario === 'deferred-close-timeout'
      ? `
const fixtureDelayHttp = await import('node:http');
const fixtureDelayFs = await import('node:fs');
const fixtureBusyNonce = ${JSON.stringify(busyNonce)};
const fixtureBusyWitness = ${JSON.stringify(fixtureWitness)};
const fixtureBusyMarker = ${JSON.stringify(busyMarker)};
const fixtureBusyObservation = ${JSON.stringify(busyObservation)};
let fixtureBusyReadDeadline;
function fixtureReadBusy() {
 let fd;
 try {
  fd = fixtureDelayFs.openSync(fixtureBusyMarker, fixtureDelayFs.constants.O_RDONLY | fixtureDelayFs.constants.O_NOFOLLOW);
  const stat = fixtureDelayFs.fstatSync(fd);
  if(!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error('fixture_busy_marker_bound');
  const marker = JSON.parse(fixtureDelayFs.readFileSync(fd, 'utf8'));
  if(marker.nonce !== fixtureBusyNonce || marker.witness !== fixtureBusyWitness || marker.pid !== 1 || marker.version !== ${JSON.stringify(fixtureNativeVersion)} || marker.gameActions !== 0 ||
   !Number.isSafeInteger(marker.startedAt) || !Number.isSafeInteger(marker.busyUntil) || marker.busyUntil-marker.startedAt !== 25000 ||
   marker.startedAt > Date.now() || marker.busyUntil <= Date.now()+20000) throw new Error('fixture_busy_marker_unproved');
  return marker;
 } catch(error) {
  if(error.code === 'ENOENT') return null;
  throw error;
 } finally { if(fd !== undefined) fixtureDelayFs.closeSync(fd); }
}

const fixtureActualSend = WebSocket.prototype.send;
let fixtureDelayTriggered = false;
WebSocket.prototype.send = function(bytes) {
 const command = JSON.parse(bytes);
 if(command.method !== 'Runtime.evaluate' || command.params?.expression !== OWNED_MAIN_INSPECTOR_CLOSE_EXPRESSION)
  return fixtureActualSend.call(this, bytes);
 if(fixtureDelayTriggered) throw new Error('fixture_native_close_replayed');
 fixtureDelayTriggered = true;
 fixtureBusyReadDeadline = Date.now() + 1500;
 const socket = this;
 const request = fixtureDelayHttp.get('http://127.0.0.1:8080/fixture-delay-close?nonce=' + fixtureBusyNonce, response => {
  let body = '';
  response.on('data', chunk => { body += chunk; if(body.length > 4096) request.destroy(); });
  response.on('end', () => {
   const observed = JSON.parse(body);
   if(response.statusCode !== 200 || observed.pid !== 1 || observed.gameActions !== 0 || observed.witness !== fixtureBusyWitness || observed.nonce !== fixtureBusyNonce)
    throw new Error('fixture_close_boundary_load_unproved');
   function forwardWhenBusyEntered() {
    try {
     if(Date.now() >= fixtureBusyReadDeadline) throw new Error('fixture_busy_entry_deadline');
     const marker = fixtureReadBusy();
     if(!marker) { setImmediate(forwardWhenBusyEntered); return; }
     const observedAt = Date.now();
     fixtureDelayFs.writeFileSync(fixtureBusyObservation, JSON.stringify({...marker, observedAt, beforeFixedClose:true}), {flag:'wx',mode:0o644});
     fixtureActualSend.call(socket, bytes);
    } catch { process.exit(90); }
   }
   forwardWhenBusyEntered();
  });
 });
 request.setTimeout(1500, () => request.destroy(new Error('fixture_close_boundary_load_timeout')));
 request.on('error', () => { console.error('fixture_close_boundary_load_failed'); process.exit(90); });
};
`
      : '';
  // Observe actual HTTP/socket operations without substituting their results.
  // The claimed listener must be requalified without creating another
  // discovery client between the real root ACK and the real native close.
  const discoveryObservation = `
const fixtureHttpNative = process.getBuiltinModule('node:http');
const fixtureHttpGet = fixtureHttpNative.get;
let fixtureClaimAckSeen = false, fixtureCloseSent = false;
let fixtureInitialDiscovery = 0, fixturePostAckDiscovery = 0;
process.stdin.prependListener('data', () => { fixtureClaimAckSeen = true; });
fixtureHttpNative.get = function(...args) {
 const options = args[0];
 if(options?.host === '127.0.0.1' && options.port === 9229 && options.path === '/json/list' && !fixtureCloseSent) {
  if(fixtureClaimAckSeen) fixturePostAckDiscovery++;
  else fixtureInitialDiscovery++;
 }
 return fixtureHttpGet.apply(this, args);
};
process.getBuiltinModule('node:module').syncBuiltinESMExports();
const fixtureObservedSend = WebSocket.prototype.send;
WebSocket.prototype.send = function(bytes) {
 const command = JSON.parse(bytes);
 if(command.method === 'Runtime.evaluate' && command.params?.expression === OWNED_MAIN_INSPECTOR_CLOSE_EXPRESSION)
  fixtureCloseSent = true;
 return fixtureObservedSend.call(this, bytes);
};
process.once('exit', () => process.getBuiltinModule('node:fs').writeSync(2, 'fixture-discovery:' + JSON.stringify({
 initial: fixtureInitialDiscovery, afterAckBeforeClose: fixturePostAckDiscovery,
}) + '\\n'));
`;
  function busyEntryProof() {
    if (scenario === 'success') return undefined;
    const read = (name) => {
      const fd = fs.openSync(
        join(fixtureDirectory, 'state', name),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
      try {
        const stat = fs.fstatSync(fd);
        assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 4096);
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally {
        fs.closeSync(fd);
      }
    };
    const marker = read('busy-' + busyNonce + '.json');
    const observation = read('observed-' + busyNonce + '.json');
    assert.deepEqual(marker, {
      nonce: busyNonce,
      witness: fixtureWitness,
      pid: 1,
      version: fixtureNativeVersion,
      gameActions: 0,
      startedAt: marker.startedAt,
      busyUntil: marker.startedAt + 25000,
    });
    assert.ok(Number.isSafeInteger(marker.startedAt));
    assert.deepEqual(observation, {
      ...marker,
      observedAt: observation.observedAt,
      beforeFixedClose: true,
    });
    assert.ok(Number.isSafeInteger(observation.observedAt));
    assert.ok(observation.observedAt >= marker.startedAt);
    assert.ok(marker.busyUntil - observation.observedAt > 20000);
    return {
      targetBusyEntered: true,
      nonceBound: true,
      witnessBound: true,
      pid: 1,
      gameActions: 0,
      beforeFixedClose: true,
      remainingMs: marker.busyUntil - observation.observedAt,
    };
  }
  const source = discoveryObservation + closeBoundaryLoad + maintainedSource;
  if (hostWrapper) {
    const hostRoot = join(fixtureDirectory, 'host-wrapper-' + scenario);
    const control = join(hostRoot, 'control');
    fs.mkdirSync(control, { recursive: true });
    for (const name of [
      'retire-owned-main-inspector.mjs',
      'main-inspector-socket-qualification.mjs',
      'main-inspector-retirement-entry.mjs',
    ]) {
      const maintained = fs.readFileSync(
        new URL('../../server/scripts/' + name, import.meta.url),
        'utf8'
      );
      fs.writeFileSync(
        join(control, name),
        (name === 'main-inspector-retirement-entry.mjs' ? closeBoundaryLoad : '') + maintained
      );
    }
    const inspected = await fixtureInspect();
    assert.deepEqual(fixtureTuple(inspected), identity);
    const { stdout } = await fixtureExec(
      'python3',
      [
        '-B',
        new URL('./main-inspector-retirement-host-native.py', import.meta.url).pathname,
        hostRoot,
        container,
        inspected.Image,
        scenario,
      ],
      { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 65536 }
    );
    const proof = JSON.parse(stdout.trim());
    assert.equal(proof.extraOuterGraceMs, 0);
    assert.equal(proof.hostDeadlineMs, 20000);
    assert.ok(proof.elapsedMs < 19700);
    return { ...proof, busyEntry: busyEntryProof() };
  }
  assert.ok(
    fixtureWorkDeadline - Date.now() >= 21000,
    'full native20s plus CLI exit observation must fit the original fixture work bound'
  );
  const entryDeadline = Date.now() + 20000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        container,
        'env',
        '-u',
        'NODE_OPTIONS',
        '-u',
        'NODE_PATH',
        'node',
        '--no-inspect',
        '--input-type=module',
        '-e',
        source,
        String(entryDeadline),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let output = '',
      stderr = '',
      proposalLine,
      claimDigest,
      protocolFailure;
    const timer = setTimeout(
      () => {
        protocolFailure ??= new Error('native_entry_absolute_deadline');
        child.kill('SIGKILL');
      },
      // The real publication/exit reserve fits INSIDE the native20s.
      Math.max(1, entryDeadline - Date.now())
    );
    child.stdin.on('error', () => {
      protocolFailure ??= new Error('native_entry_ack_transport_unknown');
      child.kill('SIGKILL');
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 32768) {
        protocolFailure ??= new Error('native_entry_stderr_bound');
        child.kill('SIGKILL');
      }
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 32768) {
        protocolFailure ??= new Error('native_entry_output_bound');
        child.kill('SIGKILL');
        return;
      }
      if (proposalLine !== undefined || !output.includes('\n')) return;
      try {
        proposalLine = output.slice(0, output.indexOf('\n'));
        const proposal = JSON.parse(proposalLine);
        assert.equal(
          proposal.schema,
          'main-inspector-retirement/v1',
          'unexpected MAIN Inspector proposal: ' + JSON.stringify(proposal).slice(0, 4096)
        );
        assert.match(proposal.endpoint, /^ws:\/\/127\.0\.0\.1:9229\/[a-f0-9-]{36}$/i);
        assert.equal(proposal.binding.pid, 1);
        assert.equal(proposal.binding.schema, 'main-inspector-socket-binding/v1');
        assert.equal(proposal.binding.listener.local, '0100007F:240D');
        claimDigest = createHash('sha256').update(proposalLine).digest('hex');
        const claim = JSON.stringify({
          schema: 'isolated-main-inspector-claim/v1',
          identity,
          sourceSha: fixtureSource,
          sourceDigest: createHash('sha256').update(source).digest('hex'),
          deadlineMs: entryDeadline,
          proposal,
          proposalDigest: claimDigest,
          retryAllowed: false,
        });
        const claimPath = join(fixtureDirectory, `retirement-claim-${scenario}.json`);
        const fd = fs.openSync(
          claimPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600
        );
        try {
          fs.writeFileSync(fd, claim + '\n');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const directory = fs.openSync(
          fixtureDirectory,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
        );
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
        assert.equal(fs.readFileSync(claimPath, 'utf8'), claim + '\n');
        // Exact proposal is durably claimed before this sole attachment ACK.
        child.stdin.end(claimDigest + '\n');
      } catch (error) {
        protocolFailure = error;
        child.kill('SIGKILL');
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (protocolFailure) return reject(protocolFailure);
      try {
        assert.equal(signal, null, 'native entry must exit normally');
        assert.equal(
          code,
          scenario === 'success' ? 0 : 1,
          'native entry exit mismatch: ' + output + stderr
        );
        const lines = output.trim().split('\n');
        assert.equal(lines.length, 2);
        assert.equal(lines[0], proposalLine);
        assert.match(claimDigest, /^[a-f0-9]{64}$/);
        const discovery = stderr.match(/^fixture-discovery:(.+)$/m);
        assert.ok(discovery, 'actual discovery operation counts must be observed');
        assert.deepEqual(JSON.parse(discovery[1]), { initial: 1, afterAckBeforeClose: 0 });
        const outcome = JSON.parse(lines[1]);
        assert.equal(outcome.ok, scenario === 'success');
        assert.equal(
          outcome.stage,
          scenario === 'success' ? 'complete' : 'native_close',
          JSON.stringify(outcome)
        );
        assert.equal(outcome.closeRequested, true);
        assert.equal(outcome.closeAcknowledged, true);
        assert.equal(outcome.connectionClosed, scenario === 'success');
        if (scenario === 'success') assert.equal(outcome.listenerAbsent, true);
        else {
          assert.equal(outcome.reason, 'deadline_exhausted');
          assert.notEqual(outcome.listenerAbsent, true);
        }
        assert.equal(outcome.retryAllowed, false);
        resolve({ outcome, proposalDigest: claimDigest, busyEntry: busyEntryProof() });
      } catch (error) {
        reject(error);
      }
    });
  });
}

if (process.platform !== 'linux') {
  console.log(
    JSON.stringify({ ok: false, skipped: true, reason: 'exact_pinned_linux_container_required' })
  );
} else {
  try {
    await fixtureDocker(['version', '--format', '{{.Server.Os}}'], 5000).then((value) =>
      assert.equal(value, 'linux')
    );
    // Exactly one bounded public image pull, never a registry credential read.
    await fixtureDocker(['pull', fixtureImage], 120000);
    fixtureDirectory = fs.mkdtempSync(join(tmpdir(), 'main-inspector-container-'));
    fs.mkdirSync(join(fixtureDirectory, 'dist'));
    fs.mkdirSync(join(fixtureDirectory, 'state'));
    fs.writeFileSync(
      join(fixtureDirectory, 'dist/index.js'),
      `
'use strict';
require('node:inspector').open(9229,'127.0.0.1',false);
const witness=${JSON.stringify(fixtureWitness)};
require('node:http').createServer((request,response)=>{
 response.setHeader('Content-Type','application/json');
 const health={pid:process.pid,version:process.version,witness,gameActions:0};
 if(request.url==='/fixture-reopen') {
  require('node:inspector').open(9229,'127.0.0.1',false);
  response.end(JSON.stringify(health));
 } else if(request.url==='/host-health') {
  response.end(JSON.stringify({releaseSha:${JSON.stringify(fixtureSource)},running:true,
   status:'ok',liveness:'ok',uptime:process.uptime(),instanceId:'1-1234abcd',
   maintenance:{active:false,phase:'idle'}}));
 } else if(request.url.startsWith('/fixture-delay-close?nonce=')) {
  const nonce=request.url.slice('/fixture-delay-close?nonce='.length);
  if(!/^[a-f0-9-]{36}$/.test(nonce)) {response.statusCode=400;response.end('{}');return;}
  response.once('finish',()=>setImmediate(()=>{
   const startedAt=Date.now(), busyUntil=startedAt+25000;
   const fs=require('node:fs'), marker='/fixture-state/busy-'+nonce+'.json';
   fs.writeFileSync(marker+'.tmp',JSON.stringify({...health,nonce,startedAt,busyUntil}),{flag:'wx',mode:0o644});
   fs.renameSync(marker+'.tmp',marker);
   // Marker publication and the busy loop belong to this SAME synchronous
   // callback. An Inspector interrupt can queue the original fixed close,
   // but its setImmediate cannot execute until this callback returns.
   while(Date.now()<busyUntil) Math.sqrt(Date.now());
  }));
  response.end(JSON.stringify({...health,nonce}));
 } else response.end(JSON.stringify(health));
}).listen(8080,'127.0.0.1');
`
    );
    fixtureContainerAttempted = true;
    const container = await fixtureDocker(
      [
        'run',
        '--rm',
        '-d',
        '--name',
        fixtureName,
        '--label',
        fixtureLabel + '=' + fixtureWitness,
        '--network',
        'none',
        '--mount',
        'type=bind,source=' + fixtureDirectory + ',target=/app,readonly',
        '--mount',
        'type=bind,source=' + join(fixtureDirectory, 'state') + ',target=/fixture-state',
        '-w',
        '/app',
        '-e',
        'GIT_COMMIT_SHA=' + fixtureSource,
        fixtureImage,
        'node',
        'dist/index.js',
      ],
      10000
    );
    assert.match(container, /^[a-f0-9]{64}$/);
    fixtureContainerId = container;
    const before = await fixtureInspect();
    assert.equal(before.Id, container);
    assert.deepEqual(before.Config.Cmd, ['node', 'dist/index.js']);
    const actualVersion = await fixtureDocker(
      ['exec', container, 'node', '--no-inspect', '--version'],
      3000
    );
    assert.equal(actualVersion, fixtureNativeVersion);
    // Observe only this isolated fixture; never repair or restart it.
    const readyDeadline = Math.min(fixtureDeadline, Date.now() + 5000);
    let healthBefore;
    while (Date.now() < readyDeadline) {
      try {
        healthBefore = await fixtureHealth(container);
        break;
      } catch (error) {
        if (Date.now() >= readyDeadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(healthBefore, 'isolated fixture readiness deadline');
    assert.deepEqual(healthBefore, {
      pid: 1,
      version: fixtureNativeVersion,
      witness: fixtureWitness,
      gameActions: 0,
    });
    const entry = await fixtureNativeEntry(container, fixtureTuple(before));
    const after = await fixtureInspect();
    assert.deepEqual(fixtureTuple(after), fixtureTuple(before));
    assert.deepEqual(await fixtureHealth(container), healthBefore);
    const absence = await fixtureDocker(
      [
        'exec',
        container,
        'node',
        '--no-inspect',
        '-e',
        `const s=require('node:net').createConnection({host:'127.0.0.1',port:9229});s.once('connect',()=>{s.destroy();process.exit(2)});s.once('error',e=>{if(e.code!=='ECONNREFUSED')process.exit(3);console.log('listener-absent')});s.setTimeout(1000,()=>{s.destroy();process.exit(4)});`,
      ],
      2000
    );
    assert.equal(absence, 'listener-absent');
    assert.deepEqual(await fixtureHealth(container, '/fixture-reopen'), healthBefore);
    const hostEntry = await fixtureNativeEntry(container, fixtureTuple(before), 'success', true);
    assert.equal(hostEntry.code, 0);
    assert.equal(hostEntry.intentDurable, true);
    assert.equal(hostEntry.receiptPresent, true);
    assert.deepEqual(fixtureTuple(await fixtureInspect()), fixtureTuple(before));
    assert.deepEqual(await fixtureHealth(container, '/fixture-reopen'), healthBefore);
    const timeoutEntry = await fixtureNativeEntry(
      container,
      fixtureTuple(before),
      'deferred-close-timeout'
    );
    // One bounded read waits for the controlled loop to finish. There is no
    // replay, Inspector reconnect, alternate close expression or signal.
    assert.deepEqual(await fixtureHealth(container, '/health', 10000), healthBefore);
    assert.deepEqual(fixtureTuple(await fixtureInspect()), fixtureTuple(before));
    const timeoutAbsence = await fixtureDocker(
      [
        'exec',
        container,
        'node',
        '--no-inspect',
        '-e',
        `const s=require('node:net').createConnection({host:'127.0.0.1',port:9229});s.once('connect',()=>{s.destroy();process.exit(2)});s.once('error',e=>{if(e.code!=='ECONNREFUSED')process.exit(3);console.log('listener-absent')});s.setTimeout(1000,()=>{s.destroy();process.exit(4)});`,
      ],
      2000
    );
    assert.equal(timeoutAbsence, 'listener-absent');
    assert.deepEqual(await fixtureHealth(container, '/fixture-reopen'), healthBefore);
    const hostTimeoutEntry = await fixtureNativeEntry(
      container,
      fixtureTuple(before),
      'deferred-close-timeout',
      true
    );
    assert.equal(hostTimeoutEntry.code, 1);
    assert.equal(hostTimeoutEntry.intentDurable, true);
    assert.equal(hostTimeoutEntry.receiptPresent, false);
    assert.deepEqual(await fixtureHealth(container, '/health', 10000), healthBefore);
    assert.deepEqual(fixtureTuple(await fixtureInspect()), fixtureTuple(before));
    fixtureVerdict = {
      ok: true,
      skipped: false,
      image: fixtureImage,
      nativeVersion: actualVersion,
      sameContainerAndProcess: true,
      witnessUnchanged: true,
      gameActions: 0,
      ...entry,
      timeoutEntry,
      hostTimeoutEntry,
      hostEntry,
      rawExitSameProcessAlive: true,
      elapsedMs: Date.now() - fixtureStarted,
    };
  } catch (error) {
    fixtureFailure = error;
  } finally {
    if (fixtureContainerAttempted) {
      // Cleanup owns a separate ten-second budget, even after main timeout.
      const cleanupDeadline = Date.now() + 10000;
      const cleanupDocker = async (args) => {
        const timeout = cleanupDeadline - Date.now();
        if (timeout <= 0) throw new Error('owned_container_cleanup_deadline');
        const { stdout } = await fixtureExec('docker', args, {
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: 1048576,
        });
        return stdout.trim();
      };
      try {
        const ids = await cleanupDocker([
          'ps',
          '-aq',
          '--no-trunc',
          '--filter',
          'name=^/' + fixtureName + '$',
        ]);
        if (ids) {
          assert.match(ids, /^[a-f0-9]{64}$/);
          const existing = JSON.parse(
            await cleanupDocker(['inspect', '--format', '{{json .}}', ids])
          );
          assert.equal(existing.Id, ids);
          if (fixtureContainerId) assert.equal(existing.Id, fixtureContainerId);
          assert.equal(existing.Name, '/' + fixtureName);
          assert.equal(existing.Config.Labels[fixtureLabel], fixtureWitness);
          await cleanupDocker(['rm', '-f', existing.Id]);
        }
        const remaining = await cleanupDocker([
          'ps',
          '-aq',
          '--no-trunc',
          '--filter',
          'name=^/' + fixtureName + '$',
        ]);
        assert.equal(remaining, '', 'owned container must be absent after cleanup');
      } catch (error) {
        fixtureFailure ??= new Error('owned_container_cleanup_unproved', { cause: error });
      }
    }
    if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
  if (fixtureFailure) {
    console.error(fixtureFailure.stack ?? String(fixtureFailure));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ ...fixtureVerdict, cleanupRemoved: true }));
}
