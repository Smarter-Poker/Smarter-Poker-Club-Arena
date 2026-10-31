import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
const { bindLegacyCensusModules, collectMarkedLegacyCensus, projectLegacyCensus } = await import(
  process.argv[2]
);
assert.equal(process.version, 'v22.23.2');
class Shared {
  inherited() {
    return 19;
  }
}
const classes = [
  class A {},
  class B extends Shared {},
  class C extends Shared {},
  class D {},
  class E {},
];
const modules = {
  gameServer: { GameServer: classes[0] },
  engine: { ServerTableEngine: classes[1] },
  manager: { TournamentManager: classes[2] },
  lightningWorker: { LightningClusterWorker: classes[3] },
  lightningHost: { LightningHandHost: classes[4] },
};
const owned = classes.map((C) => [new C(), new C()]);
const ballast = new Array(35_000_000);
for (let i = 0; i < ballast.length; i++) ballast[i] = { a: i, b: i + 1, c: i + 2 };
globalThis.__loadedMarkerFixture = { modules, owned, ballast };
const session = new Session();
session.connect();
const before = process.memoryUsage();
const began = performance.now();
let result,
  error,
  finished = false;
const holderKey = '__legacyEngineCensus_22222222222222222222222222222222';
const deadline = Date.now() + 30000;
bindLegacyCensusModules.call(modules, holderKey, deadline);
session.post(
  'Runtime.evaluate',
  {
    expression: `(${collectMarkedLegacyCensus.toString()})(${JSON.stringify(holderKey)},${deadline})`,
    disableBreaks: true,
    awaitPromise: false,
    objectGroup: 'loaded-union',
  },
  (e, r) => {
    finished = true;
    error = e;
    result = r;
  }
);
assert.equal(finished, true);
if (error) throw error;
assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
let group;
session.post(
  'Runtime.callFunctionOn',
  {
    objectId: result.result.objectId,
    functionDeclaration: `function(){return (${projectLegacyCensus.toString()}).call(this,globalThis.__loadedMarkerFixture.modules,Date.now()+5000)}`,
    objectGroup: 'loaded-groups',
  },
  (e, r) => {
    if (e) throw e;
    assert.equal(r.exceptionDetails, undefined);
    group = r.result;
  }
);
let proof;
session.post(
  'Runtime.callFunctionOn',
  {
    objectId: group.objectId,
    functionDeclaration:
      'function(){const f=globalThis.__loadedMarkerFixture;return this.map((xs,i)=>({count:xs.length,containsAll:f.owned[i].every(x=>xs.includes(x))}))}',
    returnByValue: true,
  },
  (e, r) => {
    if (e) throw e;
    proof = r.result.value;
  }
);
session.post('Runtime.releaseObjectGroup', { objectGroup: 'loaded-union' });
session.post('Runtime.releaseObjectGroup', { objectGroup: 'loaded-groups' });
session.disconnect();
const elapsedMs = performance.now() - began;
assert.deepEqual(
  proof,
  classes.map(() => ({ count: 2, containsAll: true }))
);
assert.equal(new classes[1]().inherited(), 19);
assert.ok(elapsedMs < 30000, 'unchanged census work allowance exceeded');
assert.equal(Object.hasOwn(globalThis, holderKey), false);
for (const top of [
  classes[0].prototype,
  Shared.prototype,
  classes[3].prototype,
  classes[4].prototype,
])
  assert.equal(Object.getPrototypeOf(top), Object.prototype);
console.log(
  JSON.stringify({
    ok: true,
    restored: true,
    bindingRemoved: true,
    sessionDisconnected: true,
    version: process.version,
    platform: process.platform,
    arch: process.arch,
    objects: ballast.length,
    before,
    after: process.memoryUsage(),
    elapsedMs,
    proof,
  })
);
