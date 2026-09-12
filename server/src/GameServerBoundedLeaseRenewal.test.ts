/** Repository-discovered runtime regression probes for bounded renewal.
 * Reads the CURRENT checkout's methods/helper. No server boot, network, database,
 * old candidate source, historical base fixture or additional dependency.
 * The deterministic VM owns only clock/transport/retirement collaborators.
 * Full composition/scope evidence is external to this behavioral test.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import ts from 'typescript';
const source = fs.readFileSync(resolve(process.cwd(), 'src/GameServer.ts'), 'utf8');
const ast = ts.createSourceFile('GameServer.ts', source, ts.ScriptTarget.Latest, true),
  cls = ast.statements.filter(ts.isClassDeclaration).find((x) => x.name?.text === 'GameServer');
assert(cls, 'GameServer class is required');
const names = [
  'renewVerifiedCashTableLeaseProofs',
  'renewVerifiedTournamentManagerLeaseProofs',
  'renewOwnedEngineLeaseProofs',
  'performOwnedEngineLeaseProofRenewal',
  'runOwnershipLeaseRenewalLoop',
  'superviseOwnershipLeaseRenewal',
  'runShutdownOwnershipLeaseRenewalLoop',
  'stopShutdownOwnershipLeaseRenewal',
];
const members = names.map((n) => {
  const m = cls.members.find((x) => x.name?.getText(ast) === n);
  assert(m, n);
  return m.getText(ast);
});
const helper = fs
  .readFileSync(resolve(process.cwd(), 'src/services/BoundedLeaseRenewalScope.ts'), 'utf8')
  .replace('export class', 'class');
const deferred = () => {
  let resolve!: (value?: any) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<any>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
type Rpc = (args: any[], call: number) => Promise<any>;
type Timer = {
  fn: () => void;
  at: number;
  unref: () => void;
};
function harness({
  cash,
  tournament,
  reportThrows = false,
}: {
  cash?: Rpc;
  tournament?: Rpc;
  reportThrows?: boolean;
} = {}) {
  let now = 0,
    timers: Timer[] = [],
    cashCalls = 0,
    tournamentCalls = 0;
  const outcomes: string[] = [],
    retired: any[] = [],
    reports: string[] = [];
  // Dynamic VM bridge only: production method bodies are extracted unchanged.
  const context: any = {
    performance: { now: () => now },
    Date: { now: () => now },
    Promise,
    Map,
    Set,
    Math,
    Number,
    Error,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, at: now + ms, unref() {} };
      timers.push(t);
      return t;
    },
    clearTimeout: (t: Timer) => {
      timers = timers.filter((x) => x !== t);
    },
    heartbeatTables: (args: any[]) => {
      cashCalls++;
      return cash
        ? cash(args, cashCalls)
        : Promise.resolve({ status: 'answered', proofs: [], lostTableIds: [] });
    },
    heartbeatTournaments: (args: any[]) => {
      tournamentCalls++;
      return tournament
        ? tournament(args, tournamentCalls)
        : Promise.resolve({ status: 'answered', proofs: [], lostTournamentIds: [] });
    },
    TABLE_LEASE_PROOF_WINDOW_MS: 20000,
    TOURNAMENT_LEASE_PROOF_WINDOW_MS: 20000,
    OWNERSHIP_LEASE_RENEWAL_ABANDON_MS: 20000,
    OWNERSHIP_LEASE_RENEWAL_CADENCE_MS: 5000,
    leaseRenewalPassesTotal: {
      inc: (
        _n: number,
        x: {
          outcome: string;
        }
      ) => outcomes.push(x.outcome),
    },
    leaseRenewalLoopRunning: { set() {} },
    leaseRenewalLoopRelaunchesTotal: { inc() {} },
    reportError: (_e: unknown, label: string) => {
      reports.push(label);
      if (reportThrows) throw Error('report failed');
    },
    retired,
  };
  const shell = `${helper}\nclass Probe {
 ownershipLeaseRenewalAbandoned=new WeakSet();ownershipLeaseRenewalOperation=null;ownershipLeaseRenewalCompletedAtMs=0;
 cashLeaseRenewalScope=new BoundedLeaseRenewalScope();tournamentLeaseRenewalScope=new BoundedLeaseRenewalScope();
 shutdownOwnershipLeaseRenewalOperation=null; lifecycleGeneration=1;running=true;shutdownOwnershipLeaseRenewalActive=false;
 tableEngines=new Map();tournamentEngines=new Map();tournamentOwnedTables=new Set();tournamentManagersJudgedLost=new Set();tournamentResumeDistress=0;
 directAdmissionIsCurrent(g){return this.running&&this.lifecycleGeneration===g;} sleep(ms){return new Promise(r=>setTimeout(r,ms));}
 recoverDirectTableEngine(id,e){retired.push(['cash',id,e]);return Promise.resolve();}
 stopTournamentManagerIfOwned(id,m){retired.push(['tournament',id,m]);return Promise.resolve();}
 launchServerLifecycleJob(p){p.catch(()=>{});}
 ${members.join('\n')}
 };globalThis.Probe=Probe;globalThis.Scope=BoundedLeaseRenewalScope;`;
  const emitted = ts.transpileModule(shell, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal((emitted.diagnostics ?? []).length, 0);
  vm.runInNewContext(emitted.outputText, context);
  const p = new context.Probe();
  const flush = async () => {
    for (let i = 0; i < 35; i++) await Promise.resolve();
  };
  async function advance(ms: number) {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
    await flush();
  }
  return {
    p,
    context,
    flush,
    advance,
    outcomes,
    retired,
    reports,
    stats: () => ({ cashCalls, tournamentCalls, timers: timers.length, now }),
  };
}
function engine(gen = 'cash1') {
  return {
    gen,
    current: true,
    renewed: 0,
    fenced: 0,
    getEngineLeaseAuthority() {
      return { scope: 'cash', verified: true, generation: this.gen };
    },
    hasCurrentEngineLeaseAuthority() {
      return this.current;
    },
    renewEngineLeaseProof() {
      this.renewed++;
      return true;
    },
    fenceForEngineLeaseLoss() {
      this.fenced++;
    },
  };
}
function manager(gen = 'tour1') {
  return {
    gen,
    current: true,
    renewed: 0,
    fenced: 0,
    getTournamentLeaseGeneration() {
      return this.gen;
    },
    hasCurrentTournamentLeaseAuthority() {
      return this.current;
    },
    renewTournamentLeaseProof() {
      this.renewed++;
      return true;
    },
    stoodDownWithItsLeaseIntact() {
      return true;
    },
    fenceForTournamentLeaseLoss() {
      this.fenced++;
    },
  };
}
const cashProof = (id = 'c') => ({
  status: 'answered',
  proofs: [{ tableId: id, leaseGeneration: 'cash1', proofDeadlineMonotonicMs: 999999 }],
  lostTableIds: [],
});
const tourProof = () => ({
  status: 'answered',
  proofs: [{ tournamentId: 't', leaseGeneration: 'tour1', proofDeadlineMonotonicMs: 999999 }],
  lostTournamentIds: [],
});
test('exact primary loop escapes deadline; healthy scope continues; retained requests stay bounded', async () => {
  const hang = deferred(),
    h = harness({ cash: () => hang.promise });
  const e = engine();
  h.p.tableEngines.set('c', e);
  let done = false;
  const loop = h.p.superviseOwnershipLeaseRenewal(1).then(() => (done = true));
  await h.flush();
  assert.equal(h.stats().cashCalls, 1);
  await h.advance(20001);
  await h.advance(0);
  for (let i = 0; i < 100; i++) await h.advance(5000);
  assert.equal(h.stats().cashCalls, 1);
  assert(h.stats().tournamentCalls > 90);
  assert(h.stats().timers <= 1);
  assert.equal(h.outcomes.filter((x) => x === 'abandoned').length, 1);
  assert(!done);
  hang.resolve(cashProof());
  await h.flush();
  assert.equal(e.renewed, 0);
  h.p.running = false;
  await h.advance(5000);
  await loop;
  assert(done);
});
test('both hung scopes retain exactly two requests with no growing timers/waiters', async () => {
  const c = deferred(),
    t = deferred(),
    h = harness({ cash: () => c.promise, tournament: () => t.promise });
  let done = false;
  h.p.renewOwnedEngineLeaseProofs().then(() => (done = true));
  await h.advance(20001);
  assert(done);
  for (let i = 0; i < 100; i++) await h.p.renewOwnedEngineLeaseProofs();
  assert.equal(h.stats().cashCalls, 1);
  assert.equal(h.stats().tournamentCalls, 1);
  assert.equal(h.stats().timers, 0);
});
test('expired owners retire locally while a scope transport remains pending', async () => {
  const c = deferred(),
    h = harness({ cash: () => c.promise }),
    e = engine();
  h.p.tableEngines.set('c', e);
  h.p.renewOwnedEngineLeaseProofs();
  e.current = false;
  await h.advance(20001);
  assert.equal(e.fenced, 1);
  assert.equal(h.retired.length, 1);
  c.resolve(cashProof());
  await h.flush();
  assert.equal(e.renewed, 0);
});
for (const scope of ['cash', 'tournament'])
  for (const change of [
    'replacement',
    'same-object-generation',
    'lifecycle',
    'shutdown-ended',
    'deadline-before-timer',
  ])
    test(scope + ' refuses late result after ' + change, async () => {
      const d = deferred(),
        h = harness({ [scope]: () => d.promise }),
        old = scope === 'cash' ? engine() : manager(),
        map = scope === 'cash' ? h.p.tableEngines : h.p.tournamentEngines,
        id = scope === 'cash' ? 'c' : 't';
      map.set(id, old);
      if (change === 'shutdown-ended') {
        h.p.running = false;
        h.p.shutdownOwnershipLeaseRenewalActive = true;
      }
      const pending = h.p.renewOwnedEngineLeaseProofs();
      if (change === 'replacement') map.set(id, scope === 'cash' ? engine('new') : manager('new'));
      if (change === 'same-object-generation') old.gen = 'new';
      if (change === 'lifecycle') h.p.lifecycleGeneration++;
      if (change === 'shutdown-ended') h.p.shutdownOwnershipLeaseRenewalActive = false;
      if (change === 'deadline-before-timer') h.context.performance.now = () => 20001;
      d.resolve(scope === 'cash' ? cashProof() : tourProof());
      await pending;
      assert.equal(old.renewed, 0);
      assert.equal(map.get(id).renewed, 0);
      assert.equal(old.fenced, 0);
      assert.equal(h.retired.length, 0);
    });
test('late rejected transport is observed and cannot clear another scope operation', async () => {
  const d = deferred(),
    next = deferred(),
    h = harness({
      cash: () => d.promise,
      tournament: (_a, n) => (n === 1 ? Promise.resolve(tourProof()) : next.promise),
    });
  h.p.renewOwnedEngineLeaseProofs();
  await h.advance(20001);
  const successor = h.p.renewOwnedEngineLeaseProofs();
  d.reject(Error('late'));
  await h.flush();
  assert.strictEqual(h.p.ownershipLeaseRenewalOperation, successor);
  next.resolve(tourProof());
  await successor;
  assert.equal(h.p.ownershipLeaseRenewalOperation, null);
});
test('scope resumes only after original transport settles; timed-out value never applies', async () => {
  const d = deferred(),
    h = harness({ cash: (_a, n) => (n === 1 ? d.promise : Promise.resolve(cashProof())) }),
    e = engine();
  h.p.tableEngines.set('c', e);
  h.p.renewOwnedEngineLeaseProofs();
  await h.advance(20001);
  await h.p.renewOwnedEngineLeaseProofs();
  assert.equal(h.stats().cashCalls, 1);
  d.resolve(cashProof());
  await h.flush();
  assert.equal(e.renewed, 0);
  await h.p.renewOwnedEngineLeaseProofs();
  assert.equal(h.stats().cashCalls, 2);
  assert.equal(e.renewed, 1);
});
test('throwing abandon reporter cannot prevent settlement', async () => {
  const d = deferred(),
    h = harness({ cash: () => d.promise, reportThrows: true });
  let done = false;
  h.p.renewOwnedEngineLeaseProofs().then(() => (done = true));
  await h.advance(20001);
  assert(done);
});
test('normal cash and tournament proofs still renew, and concurrent callers share pass', async () => {
  const c = deferred(),
    t = deferred(),
    h = harness({ cash: () => c.promise, tournament: () => t.promise }),
    e = engine(),
    m = manager();
  h.p.tableEngines.set('c', e);
  h.p.tournamentEngines.set('t', m);
  const a = h.p.renewOwnedEngineLeaseProofs(),
    b = h.p.renewOwnedEngineLeaseProofs();
  assert.strictEqual(a, b);
  c.resolve(cashProof());
  t.resolve(tourProof());
  await a;
  assert.equal(e.renewed, 1);
  assert.equal(m.renewed, 1);
  assert.equal(h.stats().timers, 0);
});
test('synchronous operation throw clears scope and observes rejection', async () => {
  const h = harness(),
    s = new h.context.Scope();
  await assert.rejects(
    s.run(
      20,
      () => true,
      () => {
        throw Error('sync');
      },
      () => {}
    )
  );
  assert.equal(
    await s.run(
      20,
      () => true,
      async () => 7,
      () => {}
    ),
    7
  );
  assert.equal(h.stats().timers, 0);
});
for (const scope of ['cash', 'tournament'])
  test(scope + ' loss cannot retire reused generation across opposite scope await', async () => {
    const wait = deferred(),
      isCash = scope === 'cash',
      h = harness({
        cash: () =>
          isCash
            ? Promise.resolve({ status: 'answered', proofs: [], lostTableIds: ['c'] })
            : wait.promise,
        tournament: () =>
          isCash
            ? wait.promise
            : Promise.resolve({ status: 'answered', proofs: [], lostTournamentIds: ['t'] }),
      }),
      old = isCash ? engine() : manager();
    (isCash ? h.p.tableEngines : h.p.tournamentEngines).set(isCash ? 'c' : 't', old);
    const p = h.p.renewOwnedEngineLeaseProofs();
    await h.flush();
    old.gen = 'successor';
    wait.resolve(isCash ? tourProof() : cashProof());
    await p;
    assert.equal(old.fenced, 0);
    assert.equal(h.retired.length, 0);
  });
test('shutdown mode still renews retained drain ownership, and completed stop launches no transport', async () => {
  const h = harness({ cash: () => Promise.resolve(cashProof()) }),
    e = engine();
  h.p.running = false;
  h.p.shutdownOwnershipLeaseRenewalActive = true;
  h.p.tableEngines.set('c', e);
  await h.p.renewOwnedEngineLeaseProofs();
  assert.equal(e.renewed, 1);
  h.p.shutdownOwnershipLeaseRenewalActive = false;
  const before = h.stats().cashCalls;
  await h.p.renewOwnedEngineLeaseProofs();
  assert.equal(h.stats().cashCalls, before);
});
test('preserves4444 completed versus abandoned metrics with no double count or fresh completion timestamp', async () => {
  const d = deferred(),
    h = harness({ cash: () => d.promise, tournament: () => d.promise });
  const loop = h.p.runOwnershipLeaseRenewalLoop(1);
  await h.advance(20001);
  assert.equal(h.outcomes.filter((x) => x === 'abandoned').length, 1);
  assert.equal(h.outcomes.filter((x) => x === 'completed').length, 0);
  assert.equal(h.p.ownershipLeaseRenewalCompletedAtMs, 0);
  for (let i = 0; i < 20; i++) await h.advance(5000);
  assert.equal(h.outcomes.filter((x) => x === 'abandoned').length, 1);
  assert.equal(h.outcomes.filter((x) => x === 'completed').length, 0);
  h.p.running = false;
  await h.advance(5000);
  await loop;
});
test('shutdown stop releases after bounded scope timeout while transport remains retained', async () => {
  const d = deferred(),
    h = harness({ cash: () => d.promise });
  h.p.running = false;
  h.p.shutdownOwnershipLeaseRenewalActive = true;
  const loop = h.p.runShutdownOwnershipLeaseRenewalLoop();
  h.p.shutdownOwnershipLeaseRenewalOperation = loop;
  let done = false;
  const stop = h.p.stopShutdownOwnershipLeaseRenewal().then(() => (done = true));
  await h.advance(20001);
  await stop;
  assert(done);
  assert.equal(h.stats().cashCalls, 1);
  assert.equal(h.stats().timers, 0);
  d.resolve(cashProof());
  await h.flush();
  assert.equal(h.retired.length, 0);
});
test('positive settled pass still counts completed and clears its4444 wait timer', async () => {
  const h = harness();
  const loop = h.p.runOwnershipLeaseRenewalLoop(1);
  await h.flush();
  assert.equal(h.outcomes.filter((x) => x === 'completed').length, 1);
  assert.equal(h.outcomes.filter((x) => x === 'abandoned').length, 0);
  assert.equal(h.stats().timers, 1);
  h.p.running = false;
  await h.advance(5000);
  await loop;
  assert.equal(h.stats().timers, 0);
});
test('retains4444 fallback for a whole-pass wedge and late-finalizer identity', async () => {
  const h = harness(),
    first = deferred(),
    next = deferred();
  let calls = 0;
  h.p.performOwnedEngineLeaseProofRenewal = () => (++calls === 1 ? first.promise : next.promise);
  h.p.renewOwnedEngineLeaseProofs();
  await h.advance(20001);
  assert.equal(h.p.ownershipLeaseRenewalOperation, null);
  const successor = h.p.renewOwnedEngineLeaseProofs();
  first.resolve();
  await h.flush();
  assert.strictEqual(h.p.ownershipLeaseRenewalOperation, successor);
  next.resolve();
  await successor;
  assert.equal(h.p.ownershipLeaseRenewalOperation, null);
  assert.equal(h.outcomes.filter((x) => x === 'abandoned').length, 1);
});
test('supervisor exits on owner loss while underlying transport remains retained', async () => {
  const d = deferred(),
    h = harness({ cash: () => d.promise }),
    e = engine();
  h.p.tableEngines.set('c', e);
  let done = false;
  const loop = h.p.superviseOwnershipLeaseRenewal(1).then(() => (done = true));
  h.p.running = false;
  await h.advance(20001);
  await loop;
  assert(done);
  assert.equal(h.stats().cashCalls, 1);
  assert.equal(e.renewed, 0);
  d.resolve(cashProof());
  await h.flush();
  assert.equal(e.renewed, 0);
  assert.equal(h.retired.length, 0);
});
