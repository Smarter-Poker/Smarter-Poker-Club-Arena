/**
 * Finite Linux process controls, called by the existing hosted server tests.
 * This receipt covers scheduling/IPC/cleanup with hydration disabled, not full
 * corpus, CPU-saturation resolution, policy qualification or publication.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, opendirSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { getPriority } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_THREADS = 32;
const remainingQualificationLimits = [
  'full identified solver-corpus hydration and thread shape are not exercised',
  'actual negative-parent-priority and parent-priority race controls are not exercised',
  'GNU nice positive-adjustment setpriority denial followed by exec is not fault-injected',
  'all real 60s READY, 30s heartbeat and 250ms cancellation boundaries are not exercised',
  '32-thread runtime capacity and network denial are not established',
  'production pinned-image installation and workload CPU impact are not established',
];
function readCapped(path, maximum) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(maximum + 1);
  let length = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      assert(length <= maximum, 'public input byte cap');
    }
  } finally { closeSync(fd); }
  return buffer.toString('utf8', 0, length);
}
const rawRequest = readCapped(process.argv[2] ?? '', 65_536);
const request = JSON.parse(rawRequest);
assert.match(request.executionId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
assert.equal(process.platform, 'linux');
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'existing hosted Node22 seam');
assert(isAbsolute(request.candidateRoot));
assert.match(request.sourceRevision, /^[0-9a-f]{40}$/);
assert(isAbsolute(request.outputDirectory));
const candidateRoot = realpathSync(request.candidateRoot);
const outputDirectory = realpathSync(request.outputDirectory);
assert.notEqual(outputDirectory, candidateRoot);
// Fail before importing application code if a protected configuration name was inherited.
// The hosted test supplies a finite public environment; hydration remains disabled.
for (const key of Object.keys(process.env)) {
  assert(!/(?:SUPABASE|SENTRY|(?:^|_)(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY)(?:_|$))/.test(key),
    `unexpected protected configuration name: ${key}`);
}
const publicFixtureEnvironment = {
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'public-noncredential-priority-fixture',
};
Object.assign(process.env, publicFixtureEnvironment, { NODE_ENV: 'test' });
const childFixture = fileURLToPath(new URL('./fixtures/horse-league-process-priority/child.mjs', import.meta.url));
const observations = {
  executionId: request.executionId, sourceRevision: request.sourceRevision, status: 'RUNNING_SCOPED_CONTROLS',
  scope: 'Linux inherited priority, public seeded parity, IPC and child termination; hydration disabled',
  remainingQualificationLimits, parent: { pid: process.pid, nice: getPriority(0) },
  cases: [], cleanup: [],
};
const owned = [];
const clients = [];
const timerHandles = new Set();
let Adapter;
let parityChannelHub;

async function hash(path) {
  const h = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    size += bytes.length;
    assert(size <= 140_000_000, 'public provider file cap');
    h.update(bytes);
  }
  return h.digest('hex');
}

function boundedWait(promise, milliseconds, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: deadline; terminal outcome remains unknown`)), milliseconds);
    timerHandles.add(timer);
  });
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer);
    timerHandles.delete(timer);
  });
}

function message(child, predicate, milliseconds = 60_000) {
  let onMessage;
  let onError;
  let onExit;
  const value = new Promise((resolve, reject) => {
    onMessage = (item) => { if (predicate(item)) resolve(item); };
    onError = reject;
    onExit = (code, signal) => reject(new Error(`child exited before expected message: ${code}/${signal}`));
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return boundedWait(value, milliseconds, 'child message').finally(() => {
    child.off('message', onMessage);
    child.off('error', onError);
    child.off('exit', onExit);
  });
}

function snapshot(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const root = `/proc/${pid}/task`;
  const ids = [];
  const directory = opendirSync(root, { bufferSize: 8 });
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      assert(ids.length < MAX_THREADS && entry.isDirectory(), 'native thread cap/type');
      ids.push(entry.name);
    }
  } finally { directory.closeSync(); }
  assert(ids.length > 0, 'native thread set empty');
  assert(ids.includes(String(pid)) && new Set(ids).size === ids.length, 'native leader/unique IDs missing');
  return ids.map((tid) => {
    assert.match(tid, /^[1-9]\d{0,9}$/);
    const raw = readCapped(`${root}/${tid}/stat`, 4096);
    assert(raw.startsWith(`${tid} (`), 'native stat identity mismatch');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    assert(fields.length >= 39 && /^-?(?:0|[1-9]\d?)$/.test(fields[16]));
    assert(/^[1-9]\d{0,19}$/.test(fields[19]));
    assert(/^(?:0|[1-9]\d{0,19})$/.test(fields[11]) && /^(?:0|[1-9]\d{0,19})$/.test(fields[12]));
    return {
      tid: Number(tid), nice: Number(fields[16]), startTicks: fields[19], policy: Number(fields[38]),
      userTicks: fields[11], systemTicks: fields[12],
    };
  }).sort((a, b) => a.tid - b.tid);
}

function cpuDelta(first, last, pid) {
  // Endpoint reads cannot account for final CPU of absent threads or work by
  // new identities before their first observation. Preserve both explicitly;
  // only identical TID/start-time pairs establish a comparable lower bound.
  const identity = (thread) => `${thread.tid}:${thread.startTicks}`;
  const before = new Map(first.map((thread) => [identity(thread), thread]));
  const after = new Map(last.map((thread) => [identity(thread), thread]));
  assert(first.length === before.size && last.length === after.size, 'duplicate thread identity');
  const leader = first.find((thread) => thread.tid === pid);
  assert(
    leader && after.has(identity(leader)),
    'CPU observation inconclusive: original process leader disappeared or its identity changed'
  );
  const threads = [];
  const absentOriginalThreads = [];
  let total = 0n;
  for (const [key, old] of before) {
    const current = after.get(key);
    if (!current) {
      absentOriginalThreads.push(old);
      continue;
    }
    const user = BigInt(current.userTicks) - BigInt(old.userTicks);
    const system = BigInt(current.systemTicks) - BigInt(old.systemTicks);
    assert(user >= 0n && system >= 0n, 'kernel thread CPU counters regressed');
    total += user + system;
    threads.push({
      tid: old.tid,
      startTicks: old.startTicks,
      userTicks: String(user),
      systemTicks: String(system),
    });
  }
  return {
    scope:
      'lower-bound CPU for identities present at both endpoint observations; not total process CPU',
    threads,
    totalComparableTicks: String(total),
    absentOriginalThreads,
    newThreads: last.filter((thread) => !before.has(identity(thread))),
  };
}

async function observeMatchupCPU(client, receipt, evidence) {
  // Receipt bounds are deliberately stated as receipt bounds. A terminal IPC
  // message can have been sent before the parent reads it; this is not an
  // instruction-level attribution or a claim that a generic thread is GC.
  evidence.meaning = 'Child CPU between first matching HEARTBEAT receipt and matching terminal receipt';
  evidence.messages = [];
  let jobId = null;
  let first = null;
  let resolveTerminal;
  let rejectTerminal;
  const terminal = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
  void terminal.catch(() => {});
  const onMessage = (item) => {
    if (!['HEARTBEAT', 'MATCHUP_RESULT', 'ERROR'].includes(item?.type)) return;
    try {
      assert(evidence.messages.length < 64, 'job evidence message cap');
      evidence.messages.push({ type: item.type, jobId: item.jobId, receivedAtMs: performance.now() });
      if (item.type === 'HEARTBEAT') {
        assert(Number.isSafeInteger(item.jobId) && item.jobId > 0);
        assert.equal(client.pending?.jobId, item.jobId, 'heartbeat does not belong to the dispatched job');
        if (jobId === null) {
          jobId = item.jobId;
          first = { beganAtMs: performance.now(), threads: snapshot(receipt.pid), endedAtMs: performance.now() };
          evidence.firstHeartbeatSnapshot = first;
        } else assert.equal(item.jobId, jobId, 'unrelated heartbeat entered CPU interval');
        return;
      }
      evidence.terminalSnapshot = { beganAtMs: performance.now(), threads: snapshot(receipt.pid), endedAtMs: performance.now() };
      assert(first, 'CPU observation inconclusive: terminal arrived without a matching heartbeat');
      assert.equal(item.jobId, jobId, 'terminal belongs to a different job');
      evidence.jobId = jobId;
      evidence.cpuDelta = cpuDelta(first.threads, evidence.terminalSnapshot.threads, receipt.pid);
      assert(first.threads.every((t) => t.nice === 19) && evidence.terminalSnapshot.threads.every((t) => t.nice === 19));
      assert(BigInt(evidence.cpuDelta.totalComparableTicks) > 0n, 'CPU observation inconclusive: no positive per-thread delta');
      assert.equal(item.type, 'MATCHUP_RESULT', 'job failed instead of completing');
      resolveTerminal();
    } catch (error) { rejectTerminal(error); }
  };
  const onError = (error) => rejectTerminal(error);
  const onExit = (code, signal) => rejectTerminal(new Error(`child exited during job observation: ${code}/${signal}`));
  receipt.child.on('message', onMessage);
  receipt.child.once('error', onError);
  receipt.child.once('exit', onExit);
  const run = client.runMatchup({ name: 'priority-native-parity', a: {}, b: { v12: false }, mind: 'sandbox' }, 4, 0x5eed);
  void run.catch(() => {});
  try {
    const [result] = await boundedWait(Promise.all([run, terminal]), 60_000, 'bounded matchup CPU observation');
    return result;
  } finally {
    receipt.child.off('message', onMessage);
    receipt.child.off('error', onError);
    receipt.child.off('exit', onExit);
  }
}

function own(child, adapter = new Adapter(child)) {
  const receipt = { child, adapter, pid: child.pid, exit: null, close: null };
  child.once('exit', (code, signal) => { receipt.exit = { code, signal }; });
  child.once('close', (code, signal) => { receipt.close = { code, signal }; });
  // Keep startup errors observed; an error itself is never recorded as terminal.
  child.on('error', () => {});
  owned.push(receipt);
  return receipt;
}

function launch(entry, args = [], nice = true, execPath = '/usr/bin/nice', inlineFixture = false) {
  assert(!inlineFixture || (entry === childFixture && nice), 'inline source is restricted to the fixed isolated fixture');
  // Only this dedicated fixture can use inline input. It avoids an async ESM
  // file read creating libuv workers before the intended first observation.
  // The production default factory and its argument filtering are unchanged.
  const fixtureInput = inlineFixture ? ['--input-type=module', '--eval', readCapped(childFixture, 32_768)] : process.execArgv;
  const child = fork(entry, args, {
    ...(nice ? { execPath, execArgv: ['-n', String(19 - getPriority(0)), '--', process.execPath, ...fixtureInput] } : { execArgv: process.execArgv }),
    env: {
      PATH: '/usr/bin:/bin', NODE_ENV: 'test',
      ...publicFixtureEnvironment,
      HORSE_LEAGUE_HYDRATE_SOLVER_STORES: '0', EQUITY_GOVERNOR: 'off',
    },
    serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return own(child);
}

async function finish(receipt) {
  await boundedWait(receipt.adapter.terminate(), 12_000, 'actual child terminal join');
  assert(receipt.exit || (receipt.pid === undefined && receipt.close), 'no actual terminal receipt');
  if (receipt.pid !== undefined) {
    try {
      const current = snapshot(receipt.pid);
      assert.fail(`owned child PID still present after exit (${current.length} threads); retain for native review`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function runCase(name, fn) {
  const value = { name, status: 'RUNNING', evidence: {} };
  observations.cases.push(value);
  // Keep partial source evidence even when an observation is inconclusive.
  try {
    value.evidence = await fn(value.evidence);
    value.status = value.evidence?.unsupported ? 'CONTROL_UNAVAILABLE' : 'CONTROL_PASSED';
  }
  catch (error) { value.status = 'CONTROL_FAILED'; value.error = String(error).slice(0, 2000); throw error; }
}

try {
  observations.runtime = {
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    executable: realpathSync('/proc/self/exe'), nodeSha256: await hash('/proc/self/exe'),
    launcher: realpathSync('/usr/bin/nice'), niceSha256: await hash('/usr/bin/nice'),
    nodeArguments: process.execArgv,
  };
  observations.parent.startThreads = snapshot(process.pid);
  observations.sourceFiles = [];
  assert.equal(await hash(fileURLToPath(import.meta.url)), request.fixtureFiles.qualifier);
  assert.equal(await hash(childFixture), request.fixtureFiles.child);
  observations.fixtureFiles = request.fixtureFiles;
  assert(Array.isArray(request.candidateFiles) && request.candidateFiles.length >= 5 && request.candidateFiles.length <= 128);
  const required = new Set([
    'benchmark/HorseLeagueComputeWorkerClient.ts', 'benchmark/HorseLeagueComputeProcess.ts',
    'benchmark/HorseLeagueComputeWorker.ts', 'benchmark/HorseLeagueComputeProtocol.ts',
    'benchmark/HorseLeagueProcessPriority.ts', 'hub/ChannelHub.ts',
  ]);
  const seen = new Set();
  for (const item of request.candidateFiles) {
    assert(typeof item.path === 'string' && !isAbsolute(item.path));
    const file = realpathSync(join(candidateRoot, item.path));
    const rel = relative(candidateRoot, file);
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
    assert(!seen.has(rel)); seen.add(rel); required.delete(rel);
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.equal(await hash(file), item.sha256);
    observations.sourceFiles.push({ path: rel, sha256: item.sha256 });
  }
  assert.equal(required.size, 0, 'candidate boundary pins missing');
  // The real in-process parity path imports this singleton through
  // HorseLeague -> supabase barrel -> seats -> financialPush. Its lobby
  // interval is referenced, so this finite supervisor must own its cleanup.
  ({ channelHub: parityChannelHub } = await import(pathToFileURL(join(candidateRoot, 'hub/ChannelHub.ts')).href));
  const runtime = await import(pathToFileURL(join(candidateRoot, 'benchmark/HorseLeagueComputeWorkerClient.ts')).href);
  Adapter = runtime.LowPriorityComputeProcess;
  assert.equal(typeof Adapter, 'function');
  const expectedStores = { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null };

  await runCase('original scalar READY negative control', async () => {
    assert(getPriority(0) < 19, 'ordinary parent required to reproduce mixed inherited priorities');
    // Exact original leader-only bootstrap operation, in an isolated fixture.
    // This proves the scheduling defect, not old application dependency equivalence.
    const receipt = launch(childFixture, ['leader-only'], false);
    const ready = await message(receipt.child, (m) => m?.type === 'READY' || m?.type === 'ERROR');
    assert.equal(ready.type, 'READY'); assert.equal(ready.executionNice, 19);
    const threads = snapshot(receipt.pid);
    assert(threads.some((t) => t.nice !== 19), 'preimage defect did not reproduce');
    await finish(receipt);
    return { pid: receipt.pid, readyNice: ready.executionNice, threads, terminal: receipt.exit };
  });

  await runCase('candidate default factory and PID-bound READY', async (evidence) => {
    const client = new runtime.HorseLeagueComputeWorkerClient({ hydrateSolverStores: false, expectedSolverStores: expectedStores });
    clients.push(client);
    void client.ready().catch(() => {});
    // Exact reviewed adapter private fields are inspected only by this fixture;
    // no new production escape hatch or replacement factory is used here.
    assert(client.worker instanceof Adapter);
    const receipt = own(client.worker.child, client.worker);
    const rawReady = message(receipt.child, (m) => m?.type === 'READY');
    void rawReady.catch(() => {});
    assert.deepEqual(await boundedWait(client.ready(), 65_000, 'default READY'), expectedStores);
    const ready = await rawReady;
    assert.equal(ready.executionPriority.pid, receipt.pid);
    const threads = snapshot(receipt.pid);
    Object.assign(evidence, { pid: receipt.pid, proof: ready.executionPriority, readyThreads: threads, jobObservation: {} });
    assert(threads.every((t) => t.nice === 19));
    const result = await observeMatchupCPU(client, receipt, evidence.jobObservation);
    assert.equal(result.hands, 8); assert.equal(result.illegalActions, 0);
    const { runMatchup } = await import(pathToFileURL(join(candidateRoot, 'benchmark/HorseLeague.ts')).href);
    const direct = await runMatchup({ name: 'priority-native-parity', a: {}, b: { v12: false }, mind: 'sandbox' }, 4, 0x5eed);
    const parityKeys = ['matchup', 'hands', 'bb100', 'stderr', 'illegalActions', 'truncatedStreets'];
    const pick = (value) => Object.fromEntries(parityKeys.map((key) => [key, value[key]]));
    assert.deepEqual(pick(result), pick(direct));
    evidence.seededParity = { seed: 0x5eed, pairs: 4, child: pick(result), direct: pick(direct) };
    await boundedWait(client.shutdown(), 12_000, 'default shutdown');
    await finish(receipt);
    evidence.terminal = receipt.exit;
    return evidence;
  });

  await runCase('direct candidate launch refuses before READY', async () => {
    assert(getPriority(0) < 19);
    const receipt = launch(join(candidateRoot, 'benchmark/HorseLeagueComputeProcess.ts'), [], false);
    const error = await message(receipt.child, (m) => m?.type === 'ERROR' || m?.type === 'READY');
    assert.equal(error.type, 'ERROR'); assert.match(error.message, /inherit|priority/);
    await finish(receipt);
    return { error: error.message, terminal: receipt.exit };
  });

  await runCase('direct Worker entry cannot substitute for bootstrap proof', async () => {
    const receipt = launch(join(candidateRoot, 'benchmark/HorseLeagueComputeWorker.ts'));
    const error = await message(receipt.child, (m) => m?.type === 'ERROR' || m?.type === 'READY');
    assert.equal(error.type, 'ERROR'); assert.match(error.message, /bootstrap proof is absent/);
    await finish(receipt);
    return { error: error.message, terminal: receipt.exit };
  });

  await runCase('independent unprivileged priority denial and fail-closed bootstrap', async () => {
    const processUrl = pathToFileURL(join(candidateRoot, 'benchmark/HorseLeagueComputeProcess.ts')).href;
    const receipt = launch(childFixture, ['priority-denied', processUrl], false);
    const attempt = await message(receipt.child, (m) => m?.fixture === 'priority-attempt');
    if (!attempt.denied) {
      await finish(receipt);
      const limitation = 'Independent priority-raise denial unavailable: this isolated child can raise priority or begins at the minimum';
      observations.remainingQualificationLimits.push(limitation);
      return { unsupported: true, limitation, attempt, terminal: receipt.exit };
    }
    assert(['EPERM', 'EACCES'].includes(attempt.code));
    assert.equal(attempt.afterNice, attempt.beforeNice);
    assert.notEqual(attempt.afterNice, 19, 'ordinary child required for refusal control');
    const refused = message(receipt.child, (m) => ['READY', 'ERROR'].includes(m?.type));
    receipt.child.send({ fixture: 'verify-denied-bootstrap' });
    const error = await refused;
    assert.equal(error.type, 'ERROR'); assert.match(error.message, /did not inherit nice 19/);
    await finish(receipt);
    return {
      attempt, error: error.message, terminal: receipt.exit,
      boundary: 'Independent denied priority raise followed by original candidate bootstrap; not GNU nice positive-adjustment fault injection',
    };
  });

  await runCase('advanced IPC and later libuv threads', async (evidence) => {
    const receipt = launch(childFixture, ['echo'], true, '/usr/bin/nice', true);
    const online = await message(receipt.child, (m) => m?.fixture === 'online');
    assert.equal(online.pid, receipt.pid); assert.equal(online.ppid, process.pid);
    assert.deepEqual(online.argv, [childFixture, 'echo']);
    const first = snapshot(receipt.pid);
    Object.assign(evidence, { pid: receipt.pid, first, fixtureInput: 'fixed reviewed inline source' });
    const payload = { integer: 9007199254740993n, map: new Map([['safe', 17]]), bytes: new Uint8Array([0, 128, 255]) };
    const echo = message(receipt.child, (m) => m?.fixture === 'echo-result');
    receipt.child.send({ fixture: 'echo', payload });
    assert.deepEqual((await echo).payload, payload);
    const libuv = message(receipt.child, (m) => m?.fixture === 'libuv-result');
    receipt.child.send({ fixture: 'libuv' });
    assert.deepEqual((await libuv).lengths, [16, 16, 16, 16]);
    const later = snapshot(receipt.pid);
    evidence.later = later;
    const beforeIds = new Set(first.map((thread) => `${thread.tid}:${thread.startTicks}`));
    evidence.newThreads = later.filter((thread) => !beforeIds.has(`${thread.tid}:${thread.startTicks}`));
    assert(evidence.newThreads.length > 0, 'libuv creation observation inconclusive: no new thread identity');
    assert(first.every((t) => t.nice === 19) && later.every((t) => t.nice === 19));
    await finish(receipt);
    evidence.terminal = receipt.exit;
    return evidence;
  });

  await runCase('fixed-allocation CPU and actual GC observation', async (evidence) => {
    const receipt = launch(childFixture, ['cpu-gc']);
    await message(receipt.child, (m) => m?.fixture === 'online');
    const operationId = request.executionId;
    const start = message(receipt.child, (m) => m?.fixture === 'cpu-gc-start' && m.operationId === operationId);
    receipt.child.send({ fixture: 'cpu-gc', operationId });
    evidence.start = await start;
    evidence.first = { beganAtMs: performance.now(), threads: snapshot(receipt.pid), endedAtMs: performance.now() };
    const completed = message(receipt.child, (m) =>
      ['cpu-gc-result', 'failure'].includes(m?.fixture) && m.operationId === operationId);
    // Actual work waits for this acknowledgment, after the first snapshot.
    receipt.child.send({ fixture: 'cpu-gc-observe', operationId });
    evidence.result = await completed;
    evidence.last = { beganAtMs: performance.now(), threads: snapshot(receipt.pid), endedAtMs: performance.now() };
    assert.equal(evidence.result.fixture, 'cpu-gc-result');
    assert.equal(evidence.result.batches, 128);
    assert.equal(evidence.result.elementsPerBatch, 32_768);
    assert.equal(evidence.result.maxRetainedBatches, 4);
    assert(Number.isSafeInteger(evidence.result.gcEvents) && evidence.result.gcEvents > 0 && evidence.result.gcEvents <= 256,
      'GC observation inconclusive: no bounded actual GC entry during work');
    assert(Number.isFinite(evidence.result.gcDurationMs) && evidence.result.gcDurationMs >= 0);
    evidence.cpuDelta = cpuDelta(evidence.first.threads, evidence.last.threads, receipt.pid);
    assert(BigInt(evidence.cpuDelta.totalComparableTicks) > 0n, 'CPU observation inconclusive: no positive per-thread delta');
    assert(evidence.first.threads.every((t) => t.nice === 19) && evidence.last.threads.every((t) => t.nice === 19));
    await finish(receipt);
    evidence.terminal = receipt.exit;
    return evidence;
  });

  await runCase('missing launcher spawn failure has a real close receipt', async () => {
    const missing = join(outputDirectory, 'intentionally-absent-launcher');
    assert.throws(() => lstatSync(missing), { code: 'ENOENT' });
    const receipt = launch(childFixture, ['echo'], true, missing);
    const client = new runtime.HorseLeagueComputeWorkerClient({ workerFactory: () => receipt.adapter, expectedSolverStores: expectedStores });
    clients.push(client);
    await assert.rejects(client.ready(), /ENOENT/);
    const joined = client.shutdown();
    assert.equal(client.shutdown(), joined);
    await boundedWait(joined, 12_000, 'failed-launch client join');
    await finish(receipt);
    assert.equal(receipt.pid, undefined); assert(receipt.close);
    return { pid: null, close: receipt.close };
  });

  await runCase('nonexecutable launcher refuses without fallback', async () => {
    assert.equal(lstatSync(childFixture).mode & 0o111, 0, 'fixture source must be nonexecutable');
    const receipt = launch(childFixture, ['echo'], true, childFixture);
    const client = new runtime.HorseLeagueComputeWorkerClient({ workerFactory: () => receipt.adapter, expectedSolverStores: expectedStores });
    clients.push(client);
    await assert.rejects(client.ready(), /EACCES/);
    await boundedWait(client.shutdown(), 12_000, 'nonexecutable-launch client join');
    await finish(receipt);
    assert.equal(receipt.pid, undefined); assert(receipt.close);
    return { pid: null, close: receipt.close };
  });

  for (const afterReady of [false, true]) {
    await runCase(`unexpected signal exit ${afterReady ? 'after' : 'before'} READY`, async () => {
      const receipt = launch(childFixture, ['no-ready']);
      await message(receipt.child, (m) => m?.fixture === 'online');
      const client = new runtime.HorseLeagueComputeWorkerClient({ workerFactory: () => receipt.adapter, expectedSolverStores: expectedStores });
      clients.push(client); void client.ready().catch(() => {});
      if (afterReady) { receipt.child.send({ fixture: 'ready' }); await client.ready(); }
      const exit = new Promise((resolve) => receipt.child.once('exit', resolve));
      receipt.child.kill('SIGKILL');
      await boundedWait(exit, 10_000, 'signal exit');
      if (!afterReady) await assert.rejects(client.ready(), /exited/);
      const first = client.shutdown(); const second = client.shutdown();
      assert.equal(first, second);
      await boundedWait(first, 1_000, 'already-observed signal exit join');
      await finish(receipt);
      assert.equal(receipt.exit.signal, 'SIGKILL');
      return { terminal: receipt.exit };
    });
  }

  await runCase('pre-READY waiters reject while repeated shutdown joins TERM-to-KILL', async () => {
    const receipt = launch(childFixture, ['resist-term']);
    await message(receipt.child, (m) => m?.fixture === 'online');
    const client = new runtime.HorseLeagueComputeWorkerClient({ workerFactory: () => receipt.adapter, expectedSolverStores: expectedStores });
    clients.push(client);
    const termObserved = message(receipt.child, (m) => m?.fixture === 'term-observed');
    const readyFailure = assert.rejects(client.ready(), /shut down/);
    const dispatchFailure = assert.rejects(client.runMatchup({ name: 'not-dispatched', a: {}, b: {} }, 1, 17), /shut down/);
    const began = performance.now();
    const first = client.shutdown(); const second = client.shutdown();
    assert.equal(first, second);
    await Promise.all([readyFailure, dispatchFailure, termObserved]);
    assert.equal(receipt.exit, null, 'waiter rejection was incorrectly used as exit evidence');
    await boundedWait(first, 12_000, 'TERM resistant child join');
    const elapsedMs = performance.now() - began;
    // Report real elapsed time without a false exact lower-bound assertion:
    // timer origins/rounding differ. Focused unit control pins the 5,000ms
    // argument; this case proves TERM was resisted and actual KILL exit joined.
    await finish(receipt);
    assert.equal(receipt.exit.signal, 'SIGKILL');
    return { elapsedMs, termObserved: true, terminal: receipt.exit };
  });

  assert.equal(getPriority(0), observations.parent.nice, 'parent priority changed');
  observations.status = 'SCOPED_CONTROLS_PASSED_LIMITS_REMAIN';
} catch (error) {
  observations.status = 'CONTROL_FAILED';
  observations.error = String(error).slice(0, 2000);
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    try { await boundedWait(client.shutdown(), 12_000, 'final client cleanup'); }
    catch (error) { observations.cleanup.push({ kind: 'client', confirmed: false, error: String(error).slice(0, 1000) }); }
  }
  for (const receipt of owned) {
    try {
      await finish(receipt);
      observations.cleanup.push({ pid: receipt.pid ?? null, confirmed: true, exit: receipt.exit, close: receipt.close });
    } catch (error) {
      observations.cleanup.push({ pid: receipt.pid ?? null, confirmed: false, error: String(error).slice(0, 1000) });
    }
  }
  if (observations.cleanup.some((item) => !item.confirmed)) {
    observations.status = 'FAILED_TERMINAL_UNCONFIRMED'; process.exitCode = 1;
  }
  if (parityChannelHub) {
    try {
      parityChannelHub.close();
      observations.supervisorCleanup = { parityChannelHubClosed: true };
    } catch (error) {
      observations.supervisorCleanup = { parityChannelHubClosed: false, error: String(error).slice(0, 1000) };
      observations.status = 'FAILED_SUPERVISOR_CLEANUP'; process.exitCode = 1;
    }
  }
  observations.parent.finalNice = getPriority(0);
  if (observations.parent.finalNice !== observations.parent.nice) {
    observations.status = 'FAILED_PARENT_PRIORITY_CHANGED'; process.exitCode = 1;
  }
  observations.runtimeAfter = {
    nodeSha256: await hash('/proc/self/exe'), niceSha256: await hash('/usr/bin/nice'),
  };
  if (observations.runtime && (observations.runtimeAfter.nodeSha256 !== observations.runtime.nodeSha256 ||
      observations.runtimeAfter.niceSha256 !== observations.runtime.niceSha256)) {
    observations.status = 'FAILED_RUNTIME_IDENTITY_CHANGED'; process.exitCode = 1;
  }
  for (const timer of timerHandles) clearTimeout(timer);
  assert(Buffer.byteLength(JSON.stringify(observations)) < 262_144, 'result byte cap');
  writeFileSync(join(outputDirectory, 'horse-league-process-priority-results.json'), JSON.stringify(observations, null, 2) + '\n', { flag: 'wx' });
  // Never force process.exit while an owned child is uncertain. The finite
  // hosted test owns the isolated process group and fails if cleanup is uncertain.
}
