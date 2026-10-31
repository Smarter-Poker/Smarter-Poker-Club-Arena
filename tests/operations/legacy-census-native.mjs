// Isolated real V8 qualification. Never imports application code or contacts a host.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import vm from 'node:vm';
import { bindLegacyCensusModules, collectMarkedLegacyCensus, projectLegacyCensus } from '../../server/scripts/legacy-engine-checkpoint.mjs';
const require = createRequire(import.meta.url);
assert.equal(process.version, 'v22.23.2');
assert.equal(process.versions.v8, '12.4.254.21-node.56');
const addon = require(process.argv[2]);
const scenario = process.argv[3] ?? 'bounded';
const MiB = 1024 * 1024;
const memory = () => ({ used: getHeapStatistics().used_heap_size,
  available: getHeapStatistics().total_available_size, process: process.availableMemory() });
class Shared {}
const types = [class A {}, class B extends Shared {}, class C extends Shared {}, class D {}, class E {}];
const owned = types.map(C => new C());
// Detached from the registry, retained by a real strong callback closure.
const detached = (() => { const instance = new types[2](); return () => instance; })();
const marker = {};
const tops = [types[0].prototype, Shared.prototype, types[3].prototype, types[4].prototype];
let traps = 0;
const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw Error('proxy trap'); } });
const throughProxy = Object.create(proxy);
const foreign = vm.runInNewContext('Object.create(prototype)', {prototype:types[0].prototype});
globalThis.fixtureRoots = { owned, detached, proxy, throughProxy, types, foreign };
const ballast = [];
if (scenario === 'near-limit') {
  // Fill retained managed heap only until the OLD full-heap formula refuses.
  // Keep enough space for the explicitly derived bounded output + cleanup.
  for (let iterations = 0; iterations < 2000; iterations++) {
    const m = memory();
    if (m.used + 32*MiB > m.available && m.available > 48*MiB) break;
    ballast.push(Array.from({length:5000},(_,i)=>({a:i,b:i+1,c:i+2})));
    if (iterations === 1999) throw Error('could not establish near-limit predicate');
  }
  globalThis.fixtureBallast = ballast;
}
if (scenario === 'scan-deadline') {
  let chain = Object.prototype;
  for(let i=0;i<200;i++) chain=Object.create(chain);
  globalThis.deadlineBallast=Array.from({length:200000},()=>Object.create(chain));
}
if (scenario === 'overflow' || scenario === 'at-cap') {
  globalThis.overflowOwners = Array.from({ length:scenario === 'overflow' ? addon.maxMatches+1 : addon.maxMatches-12 }, () => new types[0]());
}
const before = memory();
let result;
const connected = scenario === 'bounded' || scenario === 'near-limit';
const key = '__legacyEngineCensus_33333333333333333333333333333333';
const modules = {gameServer:{GameServer:types[0]},engine:{ServerTableEngine:types[1]},
 manager:{TournamentManager:types[2]},lightningWorker:{LightningClusterWorker:types[3]},lightningHost:{LightningHandHost:types[4]}};
try {
  if (!connected) for (const top of tops) Object.setPrototypeOf(top, marker);
  if (scenario === 'scan-deadline') {
    // Calibrate actual native predicate span in this isolated process, then
    // expire midway through that real span. No mocked clock or production hook.
    addon.collect(marker,Date.now()+30000,process.availableMemory());
    const calibration=addon.diagnostics();
    const span=calibration.lastValidAtMs-calibration.firstValidAtMs;
    assert.ok(span>=20,'real scan span insufficient for a meaningful midpoint');
    const budget=calibration.firstValidAtMs-calibration.queryStartedAtMs+Math.ceil(span/2);
    for(const top of tops)Object.setPrototypeOf(top,Object.prototype);
    const deadline=Date.now()+budget;
    bindLegacyCensusModules.call(modules,key,deadline,addon);
    assert.throws(()=>collectMarkedLegacyCensus(key,deadline),/deadline/);
    const diag=addon.diagnostics();
    assert.ok(diag.validPredicateVisits>0,'must start actual predicate before expiry');
    assert.equal(diag.deadlineRefused,true);
    assert.equal(diag.arrayAllocated,false);
    assert.equal(Object.hasOwn(globalThis,key),false);
  } else if (scenario === 'deadline-refusal') {
    assert.throws(() => addon.collect(marker, Date.now()-1, process.availableMemory()), /deadline/);
  } else if (scenario === 'process-refusal') {
    assert.throws(() => addon.collect(marker, Date.now()+30000, 1), /memory headroom/);
  } else if (scenario === 'overflow') {
    assert.throws(() => addon.collect(marker, Date.now()+30000, process.availableMemory()), /overflow before array/);
    assert.equal(addon.diagnostics().matched,addon.maxMatches+1);
    assert.equal(addon.diagnostics().overflow,true);
    assert.equal(addon.diagnostics().arrayAllocated,false);
  } else if (scenario === 'at-cap') {
    result = addon.collect(marker, Date.now()+30000, process.availableMemory());
    assert.equal(result.length,addon.maxMatches);
    for (const value of globalThis.overflowOwners) assert.ok(result.includes(value));
  } else if (scenario === 'headroom-refusal') {
    // The same real process under a 48 MiB heap must refuse before collection.
    assert.ok(before.available < 32*MiB + addon.managedOutputBytes);
    assert.throws(() => addon.collect(marker, Date.now()+30000, process.availableMemory()), /memory headroom/);
  } else {
    if (scenario === 'near-limit') {
      assert.ok(before.used+32*MiB > before.available, 'old managed guard must refuse');
      assert.ok(before.available >= 32*MiB+addon.managedOutputBytes, 'derived output must fit');
      assert.ok(before.process >= before.used*8+32*MiB, 'unchanged real process guard must pass');
    }
    const deadline = Date.now()+30000;
    bindLegacyCensusModules.call(modules,key,deadline,addon);
    result = collectMarkedLegacyCensus(key,deadline);
    const projected = projectLegacyCensus.call(result,modules,deadline);
    assert.deepEqual(projected.map(xs=>xs.length),[1,1,2,1,1]);
    assert.equal(Object.hasOwn(globalThis,key),false);
    assert.ok(Array.isArray(result));
    for (const value of [...owned, detached()]) assert.ok(result.includes(value), 'lost detached/typed owner');
    assert.equal(result.includes(proxy),false);
    assert.equal(result.includes(throughProxy),false);
    assert.equal(result.includes(foreign),false,'must match original Inspector context exclusion');
  }
} finally {
  for (const top of tops) Object.setPrototypeOf(top, Object.prototype);
}
assert.equal(traps,0);
for (const top of tops) assert.equal(Object.getPrototypeOf(top),Object.prototype);
assert.ok(detached() instanceof types[2]);
console.log(JSON.stringify({ok:true,scenario,node:process.version,platform:process.platform,arch:process.arch,
  before,after:memory(),matched:result?.length??null,prototypeRestored:true,proxyTraps:traps,
  managedOutputBytes:addon.managedOutputBytes,maxMatches:addon.maxMatches,attempt:addon.diagnostics()}));
