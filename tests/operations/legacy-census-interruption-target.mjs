import { open, url } from 'node:inspector';
import { createHook } from 'node:async_hooks';
const source = await import(process.argv[2]);
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
const tops = [classes[0].prototype, Shared.prototype, classes[3].prototype, classes[4].prototype];
const objects = classes.map((C) => new C());
const ballast = new Array(10_000_000);
for (let i = 0; i < ballast.length; i++) ballast[i] = { a: i, b: i + 1, c: i + 2 };
const events = [];
const record = (kind) =>
  events.push({ kind, restored: tops.every((x) => Object.getPrototypeOf(x) === Object.prototype) });
globalThis.__concurrent = { classes, modules, tops, objects, ballast, events, record, source };
createHook({
  before() {
    record('async_before');
  },
}).enable();
open(0, '127.0.0.1');
console.log(JSON.stringify({ endpoint: url() }));
setInterval(() => {}, 1000);
