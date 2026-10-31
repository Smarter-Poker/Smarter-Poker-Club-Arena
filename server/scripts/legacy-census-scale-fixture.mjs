// Disposable scale qualification only: no application imports, configuration or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { performance } from 'node:perf_hooks';
const sha = value => createHash('sha256').update(value).digest('hex');
const MiB = 1024 ** 2;
const started = performance.now();
assert.equal(process.version, 'v22.23.2');
assert.equal(process.versions.v8, '12.4.254.21-node.56');
assert.equal(process.versions.modules, '127');
assert.equal(process.platform, 'linux');
assert.ok(['x64', 'arm64'].includes(process.arch));
const [expectedFixture, outerDeadline] = process.argv.slice(2);
assert.equal(sha(fs.readFileSync(new URL(import.meta.url))), expectedFixture);
assert.ok(Number.isSafeInteger(Number(outerDeadline)) && Number(outerDeadline) > Date.now());
const read = name => fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
const cgroup = { memoryMax: read('memory.max'), swapMax: read('memory.swap.max'),
  cpuMax: read('cpu.max'), pidsMax: read('pids.max') };
assert.deepEqual(cgroup, { memoryMax: String(36 * 1024 ** 3), swapMax: '0',
  cpuMax: '100000 100000', pidsMax: '32' });
const binary = new URL('./legacy-census.node', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('./legacy-census.node.json', import.meta.url)));
assert.equal(manifest.binarySHA256, sha(fs.readFileSync(binary)));
assert.equal(manifest.sourceSHA256, 'cbd7279fc6595a31bd2044769d2ad85684d63713351acd0bb602dbfcdbdce31e');
for (const [key, value] of Object.entries({ node: process.version, v8: process.versions.v8,
  modules: process.versions.modules, platform: process.platform, arch: process.arch,
  pointerCompression: process.config.variables.v8_enable_pointer_compression })) assert.equal(manifest[key], value);
const addon = createRequire(import.meta.url)(binary.pathname);
const types = [class A {}, class B {}, class C {}, class D {}, class E {}];
const owners = types.map(C => new C());
const detached = (() => { const value = new types[2](); return () => value; })();
globalThis.scaleOwners = { types, owners, detached };
// One fixed attempt, not an adaptive calibration or retry. All 35M objects
// remain strongly retained. Ten in-object SMI fields model ordinary shallow
// objects; this is cardinality/memory proof, not a full production graph model.
const count = 35_000_000;
const ballast = new Array(count);
for (let i = 0; i < count; i++) {
  ballast[i] = { a:i, b:i, c:i, d:i, e:i, f:i, g:i, h:i, j:i, k:i };
  if ((i & 0x3ffff) === 0 && Date.now() >= Number(outerDeadline) - 1000)
    throw Error('fixed allocation exceeded disposable fixture deadline');
}
globalThis.scaleBallast = ballast;
const heap = getHeapStatistics();
const before = { used: heap.used_heap_size, available: heap.total_available_size,
  heapLimit: heap.heap_size_limit, process: process.availableMemory(), rss: process.memoryUsage().rss, cgroupPeak: Number(read('memory.peak')) };
assert.ok(before.used >= 3_913_011_648, 'representative used-heap floor not reached');
assert.ok(before.available <= 322_107_592, 'representative additional-heap ceiling not reached');
assert.ok(before.available >= 32 * MiB + addon.managedOutputBytes, 'bounded managed output must fit');
assert.ok(before.used + 32 * MiB > before.available, 'original full-heap admission must refuse');
assert.ok(before.process >= before.used * 8 + 32 * MiB, 'unchanged actual 8x process reserve must pass');
const allocationMs = performance.now() - started;
const marker = {};
const originals = types.map(C => Object.getPrototypeOf(C.prototype));
let result, queryMs;
try {
  types.forEach(C => Object.setPrototypeOf(C.prototype, marker));
  const queryStarted = performance.now();
  const deadline = Math.min(Date.now() + 20_000, Number(outerDeadline) - 1000);
  assert.ok(deadline > Date.now());
  result = addon.collect(marker, deadline, process.availableMemory());
  queryMs = performance.now() - queryStarted;
  assert.ok(queryMs <= 20_000, 'native query component exceeded 20 seconds');
  assert.equal(result.length, 11); // Five prototypes plus six exact owner objects.
  for (const owner of [...owners, detached()]) assert.ok(result.includes(owner));
} finally {
  types.forEach((C, i) => Object.setPrototypeOf(C.prototype, originals[i]));
}
types.forEach((C, i) => assert.equal(Object.getPrototypeOf(C.prototype), originals[i]));
const attempt = addon.diagnostics();
assert.ok(attempt.predicateVisits >= count, 'complete cardinality not visited');
assert.equal(attempt.arrayAllocated, true);
assert.equal(attempt.deadlineRefused, false);
assert.equal(ballast.length, count);
assert.equal(ballast[count - 1].k, count - 1);
console.log(JSON.stringify({ schema:'legacy-native-scale-fixture/v1', ok:true,
  qualification:'synthetic-cardinality-and-memory-only', count, before, allocationMs, queryMs,
  fixtureMs:performance.now()-started, matched:result.length, attempt, cgroup,
  cgroupPeak:Number(read('memory.peak')), maxRSSKiB:process.resourceUsage().maxRSS,
  prototypeRestored:true, fixtureSHA256:expectedFixture, binarySHA256:manifest.binarySHA256,
  sourceSHA256:manifest.sourceSHA256, node:process.version, v8:process.versions.v8,
  arch:process.arch, platform:process.platform }));
