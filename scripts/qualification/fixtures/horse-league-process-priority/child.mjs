// Fixture-only child. This file is never a production Horse League entry point.
import { pbkdf2 } from 'node:crypto';
import { getPriority, setPriority } from 'node:os';
import { PerformanceObserver, performance } from 'node:perf_hooks';

const mode = process.argv[2];
if (!['echo', 'resist-term', 'no-ready', 'cpu-gc', 'leader-only', 'priority-denied'].includes(mode) || typeof process.send !== 'function') {
  throw new Error('invalid isolated priority fixture mode/IPC');
}
if (mode === 'resist-term') {
  process.on('SIGTERM', () => process.send?.({ fixture: 'term-observed' }));
}
let cpuOperation = null;
let cpuPhase = 'idle';

async function cpuAndGc(operationId) {
  const beganAtMs = performance.now();
  let gcEvents = 0;
  let gcDurationMs = 0;
  let gcOverflow = false;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== 'gc' || entry.startTime < beganAtMs) continue;
      if (gcEvents >= 256) { gcOverflow = true; continue; }
      gcEvents += 1;
      gcDurationMs += entry.duration;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  const retained = new Array(4);
  let checksum = 0;
  try {
    // Fixed 128 x 32,768 numeric elements; four completed arrays remain
    // referenced, plus the array currently being filled. Actual V8 allocation
    // bytes, overhead and resident memory still require native measurement.
    // No forced GC, heap walk, profiler attachment or application-policy change.
    for (let batch = 0; batch < 128; batch++) {
      const values = new Array(32_768);
      for (let index = 0; index < values.length; index++) {
        values[index] = (index + batch) ^ 0x5eed;
      }
      retained[batch % retained.length] = values;
      checksum = (checksum + values[(batch * 17) % values.length]) >>> 0;
      if (batch % 8 === 7) await new Promise(setImmediate);
    }
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    if (gcOverflow) throw new Error('bounded GC entry cap exceeded');
    process.send({
      fixture: 'cpu-gc-result', operationId, beganAtMs, endedAtMs: performance.now(),
      batches: 128, elementsPerBatch: 32_768, maxRetainedBatches: 4,
      gcEvents, gcDurationMs, checksum,
    });
  } finally {
    observer.disconnect();
    retained.fill(null);
    cpuPhase = 'complete';
  }
}
process.on('message', (message) => {
  if (message?.fixture === 'verify-denied-bootstrap' && mode === 'priority-denied') {
    const candidateUrl = process.argv[3];
    if (typeof candidateUrl !== 'string' || !candidateUrl.startsWith('file:') ||
        !candidateUrl.endsWith('/HorseLeagueComputeProcess.ts')) throw new Error('invalid fixed candidate process URL');
    void import(candidateUrl).catch((error) => process.send?.({ type: 'ERROR', jobId: null, message: String(error) }));
  } else if (message?.fixture === 'echo') {
    process.send?.({ fixture: 'echo-result', payload: message.payload });
  } else if (message?.fixture === 'libuv') {
    Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      pbkdf2('public-fixture', 'public-salt', 10_000, 16, 'sha256', (error, value) => {
        if (error) reject(error); else resolve(value.length);
      });
    }))).then(
      (lengths) => process.send?.({ fixture: 'libuv-result', lengths }),
      (error) => process.send?.({ fixture: 'failure', message: String(error) })
    );
  } else if (message?.fixture === 'ready') {
    process.send?.({
      type: 'READY',
      solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
    });
  } else if (message?.fixture === 'disconnect') {
    process.disconnect();
  } else if (message?.fixture === 'exit') {
    process.exit(0);
  } else if (message?.fixture === 'cpu-gc' && mode === 'cpu-gc' && cpuPhase === 'idle') {
    if (typeof message.operationId !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(message.operationId)) {
      throw new Error('invalid bounded CPU fixture operation');
    }
    cpuOperation = message.operationId;
    cpuPhase = 'awaiting-observation';
    process.send({ fixture: 'cpu-gc-start', operationId: cpuOperation });
  } else if (message?.fixture === 'cpu-gc-observe' && cpuPhase === 'awaiting-observation' &&
             message.operationId === cpuOperation) {
    cpuPhase = 'running';
    void cpuAndGc(cpuOperation).catch((error) => process.send?.({
      fixture: 'failure', operationId: cpuOperation, message: String(error).slice(0, 1000),
    }));
  }
});
// Keep a disconnected fixture alive so its owner must prove terminal cleanup.
setInterval(() => {}, 1_000);
process.send({ fixture: 'online', pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1) });

if (mode === 'leader-only') {
  // Original defect: Node helpers exist before this leader-only adjustment.
  setPriority(0, 19);
  process.send({ type: 'READY', executionNice: getPriority(0) });
}
if (mode === 'priority-denied') {
  const beforeNice = getPriority(0);
  let denied = false;
  let code = null;
  if (beforeNice > -20) {
    try { setPriority(0, beforeNice - 1); }
    catch (error) {
      code = error?.info?.code ?? error?.code ?? 'UNKNOWN';
      denied = ['EPERM', 'EACCES'].includes(code);
      if (!denied) throw error;
    }
  }
  process.send({ fixture: 'priority-attempt', denied, code, beforeNice, afterNice: getPriority(0) });
}
