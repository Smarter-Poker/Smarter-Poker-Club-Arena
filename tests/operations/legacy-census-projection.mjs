import assert from 'node:assert/strict';
import { Session, open, close, url } from 'node:inspector';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import vm from 'node:vm';

const source = await import(process.argv[2]);
for (const name of [
  'readLegacyCensusMemory',
  'legacyCensusMemoryAdmission',
  'legacyCensusRoot',
  'projectLegacyCensus',
  'bindLegacyCensusModules',
  'collectMarkedLegacyCensus',
])
  assert.equal(typeof source[name], 'function', `maintained export missing: ${name}`);
assert.match(process.version, /^v(?:20|22|24|26)\./);
const originalPid = process.pid;
const session = new Session();
const post = promisify(session.post.bind(session));
class SharedAncestor {
  inherited() {
    return 19;
  }
}
const classes = [
  class C0 {},
  class C1 extends SharedAncestor {},
  class C2 extends SharedAncestor {},
  class C3 {},
  class C4 {},
];
const modules = {
  gameServer: { GameServer: classes[0] },
  engine: { ServerTableEngine: classes[1] },
  manager: { TournamentManager: classes[2] },
  lightningWorker: { LightningClusterWorker: classes[3] },
  lightningHost: { LightningHandHost: classes[4] },
};
const held = { modules, values: [], labels: [], baseline: [], traps: 0 };
const add = (value, label) => {
  held.values.push(value);
  held.labels.push(label);
};
for (let index = 0; index < classes.length; index++) {
  const Concrete = classes[index];
  add(new Concrete(), `${index}:registered`);
  add(new Concrete(), `${index}:detached`);
  class Intermediate extends Concrete {}
  class Subclass extends Intermediate {}
  add(new Intermediate(), `${index}:intermediate`);
  add(new Subclass(), `${index}:subclass`);
  add(Intermediate.prototype, `${index}:intermediate-prototype`);
  add(Subclass.prototype, `${index}:subclass-prototype`);
  add(Object.create(Concrete.prototype), `${index}:direct-chain`);
  add(
    vm.runInNewContext('new (class Cross extends Concrete {})()', { Concrete }),
    `${index}:cross-realm-subclass`
  );
  add(vm.runInNewContext('new (class Concrete {})()'), `${index}:foreign-realm-class`);
  add(new (class Concrete {})(), `${index}:foreign-local-class`);
  const proxy = new Proxy(new Concrete(), {
    getPrototypeOf() {
      held.traps++;
      throw Error('proxy trap executed');
    },
  });
  add(proxy, `${index}:throwing-proxy`);
  add(Object.create(proxy), `${index}:normal-with-proxy-chain`);
  const revoked = Proxy.revocable(new Concrete(), {});
  revoked.revoke();
  add(revoked.proxy, `${index}:revoked-proxy`);
  add(
    new Proxy(new Concrete(), {
      getPrototypeOf() {
        held.traps++;
        return Concrete.prototype;
      },
    }),
    `${index}:side-effect-proxy`
  );
}
add(new SharedAncestor(), 'unrelated-shared-ancestor');
add(Object.create(null), 'null-root');
// Even unrelated accessors must remain unread by the broad projection.
add(
  Object.defineProperty({}, 'constructor', {
    get() {
      held.traps++;
      throw Error('getter executed');
    },
  }),
  'getter'
);
const globalKey = '__isolatedLegacyCensusProjectionFixture';
globalThis[globalKey] = held;
let port;
try {
  assert.equal(url(), undefined);
  open(0, '127.0.0.1', false);
  port = Number(new URL(url()).port);
  session.connect();
  const memoryResponse = await post('Runtime.evaluate', {
    expression: `(${source.readLegacyCensusMemory.toString()})()`,
    returnByValue: true,
  });
  assert.equal(memoryResponse.exceptionDetails, undefined);
  const admission = source.legacyCensusMemoryAdmission(memoryResponse.result.value);
  assert.equal(admission?.ok, true, 'actual small-target heap/process admission');
  const rootResponse = await post('Runtime.evaluate', {
    expression: `(${source.legacyCensusRoot.toString()}).call(globalThis.${globalKey}.modules)`,
    objectGroup: 'projection-broad',
  });
  assert.equal(rootResponse.exceptionDetails, undefined);
  const nativeSets = [];
  for (let index = 0; index < 5; index++) {
    const prototype = await post('Runtime.evaluate', {
      expression: `Object.values(globalThis.${globalKey}.modules)[${index}][Object.keys(Object.values(globalThis.${globalKey}.modules)[${index}])[0]].prototype`,
      objectGroup: 'projection-baseline',
    });
    const census = await post('Runtime.queryObjects', {
      prototypeObjectId: prototype.result.objectId,
      objectGroup: 'projection-baseline',
    });
    const identities = await post('Runtime.callFunctionOn', {
      objectId: census.objects.objectId,
      functionDeclaration: `function(index){const f=globalThis.${globalKey};f.baseline[index]=this;return f.values.flatMap((v,i)=>this.includes(v)?[f.labels[i]]:[]).sort()}`,
      arguments: [{ value: index }],
      returnByValue: true,
    });
    nativeSets.push(identities.result.value);
  }
  const modulesResponse = await post('Runtime.evaluate', {
    expression: `globalThis.${globalKey}.modules`,
    objectGroup: 'projection-exact',
  });
  const holderKey = '__legacyEngineCensus_11111111111111111111111111111111';
  const deadline = Date.now() + 5000;
  const binding = await post('Runtime.callFunctionOn', {
    objectId: modulesResponse.result.objectId,
    functionDeclaration: source.bindLegacyCensusModules.toString(),
    arguments: [{ value: holderKey }, { value: deadline }],
    returnByValue: true,
  });
  assert.equal(binding.exceptionDetails, undefined);
  assert.equal(binding.result.value, true);
  const union = await post('Runtime.evaluate', {
    expression: `(${source.collectMarkedLegacyCensus.toString()})(${JSON.stringify(holderKey)}, ${deadline})`,
    disableBreaks: true,
    awaitPromise: false,
    objectGroup: 'projection-broad',
  });
  assert.equal(union.exceptionDetails, undefined, JSON.stringify(union.exceptionDetails));
  const broad = { objects: union.result };
  assert.equal(Object.hasOwn(globalThis, holderKey), false);
  assert.equal(Object.getPrototypeOf(classes[1].prototype), SharedAncestor.prototype);
  assert.equal(Object.getPrototypeOf(SharedAncestor.prototype), Object.prototype);
  assert.equal(new classes[1]().inherited(), 19);
  const projected = await post('Runtime.callFunctionOn', {
    objectId: broad.objects.objectId,
    functionDeclaration: source.projectLegacyCensus.toString(),
    arguments: [{ objectId: modulesResponse.result.objectId }, { value: Date.now() + 5000 }],
    objectGroup: 'projection-exact',
  });
  assert.equal(projected.exceptionDetails, undefined);
  await post('Runtime.releaseObjectGroup', { objectGroup: 'projection-broad' });
  const identities = await post('Runtime.callFunctionOn', {
    objectId: projected.result.objectId,
    functionDeclaration: `function(){const f=globalThis.${globalKey};return {labels:this.map(xs=>f.values.flatMap((v,i)=>xs.includes(v)?[f.labels[i]]:[]).sort()),exact:this.map((xs,n)=>xs.length===f.baseline[n].length&&xs.every(x=>f.baseline[n].includes(x))&&new Set(xs).size===xs.length),counts:this.map(xs=>xs.length)}}`,
    returnByValue: true,
  });
  assert.equal(identities.exceptionDetails, undefined);
  assert.deepEqual(identities.result.value.labels, nativeSets);
  assert.deepEqual(identities.result.value.exact, [true, true, true, true, true]);
  for (let index = 0; index < 5; index++) {
    assert.deepEqual(
      nativeSets[index],
      [
        'registered',
        'detached',
        'intermediate',
        'subclass',
        'intermediate-prototype',
        'subclass-prototype',
        'direct-chain',
        'cross-realm-subclass',
      ]
        .map((label) => `${index}:${label}`)
        .sort()
    );
  }
  assert.equal(held.traps, 0);
  assert.equal(source.legacyCensusRoot.call(modules), Object.prototype);
  const foreignModules = {
    ...modules,
    engine: { ServerTableEngine: vm.runInNewContext('(class Foreign {})') },
  };
  assert.throws(() => source.legacyCensusRoot.call(foreignModules), /native census root refused/);
  const overlapModules = {
    ...modules,
    engine: { ServerTableEngine: class Overlap extends classes[0] {} },
  };
  assert.throws(() => source.legacyCensusRoot.call(overlapModules), /native census root refused/);
  const proxyModules = {
    ...modules,
    engine: { ServerTableEngine: { prototype: held.values[10] } },
  };
  assert.throws(() => source.legacyCensusRoot.call(proxyModules), /native census root refused/);
  assert.equal(held.traps, 0);
  await post('Runtime.releaseObjectGroup', { objectGroup: 'projection-baseline' });
  await post('Runtime.releaseObjectGroup', { objectGroup: 'projection-exact' });
  session.disconnect();
  close();
  assert.equal(url(), undefined);
  const closed = await new Promise((resolve) => {
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
  assert.equal(closed, true);
  assert.equal(process.pid, originalPid);
  console.log(
    JSON.stringify({
      ok: true,
      nativeBaselineScans: 5,
      markedUnionScans: 1,
      bindingRemoved: true,
      inheritedBehaviorPreserved: true,
      exactSets: nativeSets,
      exactIdentityEquality: identities.result.value.exact,
      nativeCounts: identities.result.value.counts,
      traps: held.traps,
      admission: admission.ok,
      sameProcessAliveAfterCleanup: true,
      inspectorClosed: true,
      portClosed: closed,
    })
  );
} finally {
  session.disconnect();
  close();
  delete globalThis[globalKey];
}
