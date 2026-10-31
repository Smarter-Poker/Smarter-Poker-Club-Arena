/** A single bounded CPU sample. No breakpoints, heap capture, source, env or game writes. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function summarize(profile) {
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !profile.samples.length
      || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length) {
    throw new Error('profile_samples_missing');
  }
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const totals = new Map();
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = nodes.get(profile.samples[i]);
    const us = profile.timeDeltas[i];
    if (!n) throw new Error('profile_sample_invalid_node');
    if (!Number.isFinite(us)) throw new Error('profile_sample_invalid_delta');
    if (us < 0) throw new Error('profile_sample_invalid_negative_delta');
    const f = n.callFrame;
    // Only code coordinates leave the process. No source text or runtime values.
    const url = f.url || '';
    const file = url.startsWith('file:///app/') ? url.slice('file://'.length)
      : url.startsWith('/app/') || url.startsWith('node:') ? url : '(runtime)';
    const key = JSON.stringify([f.functionName || '(anonymous)', file, f.lineNumber + 1]);
    totals.set(key, (totals.get(key) || 0) + us);
    totalUs += us;
  }
  if (!(totalUs > 0)) throw new Error('profile_duration_missing');
  return { samples: profile.samples.length, sampledUs: totalUs,
    topSelf: [...totals].sort((a,b) => b[1]-a[1]).slice(0,40).map(([key,us]) => {
      const [functionName,file,line] = JSON.parse(key);
      return { functionName,file,line,selfUs:us,percent:Math.round(us/totalUs*10000)/100 };
    }) };
}

async function inspectorSession(endpoint, expectedPid, operation) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !Number.isInteger(expectedPid)
      || expectedPid < 1) {
    throw new Error('profile_target_refused');
  }
  const socket = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  let owned = false;
  let stopped = false;
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, {once:true}));
  socket.addEventListener('message', event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); msg.error ? waiter.reject(new Error('inspector_command_refused')) : waiter.resolve(msg.result); }
  });
  const failPending = () => { for (const p of pending.values()) p.reject(new Error('inspector_disconnected')); pending.clear(); };
  socket.addEventListener('error', failPending);
  socket.addEventListener('close', failPending);
  const send = (method, params = {}) => new Promise((resolve,reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('inspector_command_timeout')); }, 5000);
    pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
    socket.send(JSON.stringify({id,method,params}));
  });
  try {
    await Promise.race([
      new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(new Error('inspector_connect_failed')),{once:true}); }),
      delay(5000).then(()=>{throw new Error('inspector_connect_timeout');})
    ]);
    const identity = await send('Runtime.evaluate',{expression:'process.pid',returnByValue:true});
    if (identity.result?.value !== expectedPid) throw new Error('profile_pid_mismatch');
    owned = true;
    return await operation(send, () => { stopped = true; });
  } finally {
    // Never close somebody else's inspector on a mismatched target.
    if (owned && socket.readyState === WebSocket.OPEN) {
      if (!stopped) { try { await send('Profiler.stop'); } catch {} }
      await send('Runtime.evaluate',{expression:"setImmediate(() => process.getBuiltinModule('node:inspector').close()); true",returnByValue:true});
      socket.close();
      await Promise.race([closed,delay(5000).then(()=>{throw new Error('inspector_cleanup_timeout');})]);
    }
    socket.close();
  }
}

export async function profileTarget(endpoint, expectedPid, durationMs = 30000) {
  if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 30000) throw new Error('profile_target_refused');
  return inspectorSession(endpoint, expectedPid, async (send, markStopped) => {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval',{interval:1000});
    await send('Profiler.start');
    await delay(durationMs);
    const {profile} = await send('Profiler.stop');
    markStopped();
    return summarize(profile);
  });
}

// The caller holds the release lock and has verified the target process before
// entering. Recovery is finite and closes only a PID-identified inspector after
// this invocation opened it; an inspector found before opening is never owned.
export async function collectOwnedInspector(expectedPid, { discoverTarget, openTarget, collect = profileTarget }) {
  if (await discoverTarget()) throw new Error('inspector_already_active');
  openTarget();
  let endpoint;
  let completed = false;
  let primaryError;
  try {
    for (let i=0;i<20 && !endpoint;i++) { await delay(100); endpoint=await discoverTarget(); }
    if (!endpoint) throw new Error('inspector_open_unknown_no_retry');
    const sample = await collect(endpoint, expectedPid);
    completed = true;
    return sample;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!completed) {
      try {
        // Discovery/connect failure may happen after SIGUSR1 has opened the port.
        // Reuse its exact endpoint when known; otherwise make a bounded readback.
        let ownedEndpoint;
        let discoveryError;
        for (let i=0;i<3;i++) {
          try { ownedEndpoint=await discoverTarget(); discoveryError=null; break; }
          catch (error) { discoveryError=error; await delay(100); }
        }
        if (discoveryError) throw new Error('inspector_cleanup_not_confirmed');
        if (ownedEndpoint) {
          if (endpoint && ownedEndpoint !== endpoint) throw new Error('inspector_cleanup_not_confirmed');
          await inspectorSession(ownedEndpoint, expectedPid, async (_send, markStopped) => { markStopped(); });
          let stillOpen = true;
          for (let i=0;i<20 && stillOpen;i++) {
            try { stillOpen=Boolean(await discoverTarget()); } catch { stillOpen=true; }
            if (stillOpen) await delay(100);
          }
          if (stillOpen) throw new Error('inspector_cleanup_not_confirmed');
        }
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        primaryError.cleanupConfirmed = false;
      }
    }
  }
}

async function discover() {
  try {
    const r = await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(1000)});
    if (!r.ok) throw new Error('inspector_discovery_refused');
    const targets = await r.json();
    if (!Array.isArray(targets) || targets.length !== 1) throw new Error('inspector_target_count');
    return targets[0].webSocketDebuggerUrl;
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED') return null;
    throw e;
  }
}

async function health(expected) {
  const r = await fetch('http://127.0.0.1:8080/health',{signal:AbortSignal.timeout(5000)});
  if (!r.ok) throw new Error('health_unavailable');
  const h = await r.json();
  if (!h.version || h.releaseSha !== expected || !expected.startsWith(h.version) || h.status !== 'ok' || !h.instanceId
      || h.maintenance?.active !== false || h.maintenance?.phase !== 'idle') throw new Error('engine_identity_refused');
  return {version:h.version,instanceId:h.instanceId,uptime:h.uptime,mainEventLoopGovernor:h.mainEventLoopGovernor};
}

export async function main(expected) {
  if (!/^[a-f0-9]{40}$/.test(expected || '')) throw new Error('expected_sha_refused');
  const cmd = readFileSync('/proc/1/cmdline','utf8').split('\0').filter(Boolean);
  if (!cmd[0]?.endsWith('node') || cmd[1] !== 'dist/index.js' || cmd.length !== 2) throw new Error('engine_process_refused');
  const before = await health(expected);
  const sample = await collectOwnedInspector(1, {
    discoverTarget: discover,
    openTarget: () => process.kill(1,'SIGUSR1'),
  });
  let stillOpen = true;
  for (let i=0;i<20 && stillOpen;i++) { stillOpen=Boolean(await discover()); if (stillOpen) await delay(100); }
  if (stillOpen) throw new Error('inspector_cleanup_not_confirmed');
  const after = await health(expected);
  if (after.instanceId !== before.instanceId || after.uptime < before.uptime) throw new Error('engine_changed_during_profile');
  return {schemaVersion:1,expectedSha:expected,before,after,inspectorClosed:true,...sample};
}

// Only fixed refusal codes may leave the CLI; exception payloads may contain URLs.
const refusalCodes = new Set([
  'expected_sha_refused', 'engine_process_refused', 'health_unavailable',
  'engine_identity_refused', 'inspector_already_active', 'inspector_open_unknown_no_retry',
  'profile_target_refused', 'profile_pid_mismatch', 'inspector_connect_failed',
  'inspector_connect_timeout', 'inspector_disconnected', 'inspector_command_refused',
  'inspector_command_timeout', 'inspector_cleanup_timeout', 'inspector_cleanup_not_confirmed',
  'inspector_discovery_refused', 'inspector_target_count', 'engine_changed_during_profile',
  'profile_samples_missing', 'profile_sample_invalid', 'profile_duration_missing',
  'profile_sample_invalid_node', 'profile_sample_invalid_delta', 'profile_sample_invalid_negative_delta',
]);
export function failureReason(error) {
  return refusalCodes.has(error?.message) ? error.message : 'unclassified_failure';
}

if ((process.argv[1] === '-' && /\/\[eval\d*\]$/.test(import.meta.url)) || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  main(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch((error)=>{
    // Fail closed without leaking URLs, source, environment, values or error payloads.
    console.error('CPU profile failed; inspect owning run and inspector state before any retry. reason=' + failureReason(error) + (error?.cleanupConfirmed === false ? ' cleanup=unknown' : ''));process.exitCode=1;
  });
}
