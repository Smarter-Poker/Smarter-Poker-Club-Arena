import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('./services/supabase/client.js', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));
vi.mock('./services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { GameServer } from './GameServer.js';
import { ServerTableEngine } from './engine/ServerTableEngine.js';
import { _setEngineLeaseMonotonicNowForTests } from './engine/ServerTableEngineBase.js';
import { _setTableLeaseMonotonicNowForTests } from './services/tableLease.js';
import { _setTournamentLeaseMonotonicNowForTests } from './services/tournamentLease.js';
import { TournamentManagerBase } from './tournament/TournamentManagerBase.js';

type Scope = 'cash' | 'tournament';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let now = 0;
const live: Array<ServerTableEngine | TournamentManagerBase> = [];

class Manager extends TournamentManagerBase {
  activate() {
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    (this as any).armTournamentLeaseExpiryTimer();
    return this;
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function serverFixture() {
  const server = Object.create(GameServer.prototype) as any;
  Object.assign(server, {
    running: true,
    lifecycleGeneration: 1,
    leaderBootComplete: true,
    dealerPrerequisitesReady: true,
    teardownPromise: null,
    tableEngines: new Map(),
    tournamentEngines: new Map(),
    tournamentOwnedTables: new Set(),
    ownershipLeaseRenewalScopes: new Map(),
    serverLifecycleJobs: new Set(),
    tournamentManagersJudgedLost: new WeakSet(),
    tournamentResumeDistress: 0,
    recoverDirectTableEngine: vi.fn(async () => {}),
    stopTournamentManagerIfOwned: vi.fn(async () => true),
  });
  const cash = new ServerTableEngine(id(1), {
    scope: 'cash',
    verified: true,
    generation: id(11),
    proofDeadlineMonotonicMs: 20_000,
  });
  (cash as any).running = true;
  (cash as any).armEngineLeaseExpiryTimer();
  const tournament = new Manager(id(2), server, id(12), 20_000).activate();
  server.tableEngines.set(id(1), cash);
  server.tournamentEngines.set(id(2), tournament);
  live.push(cash, tournament);
  return { server, cash, tournament };
}

type Call = {
  scope: Scope;
  started: number;
  args: any;
  settle: (state?: string, generation?: string) => void;
  fail: () => void;
};
function transport() {
  const calls: Call[] = [];
  const pending = { cash: 0, tournament: 0 };
  const maximum = { cash: 0, tournament: 0, total: 0 };
  rpc.mockImplementation((name: string, args: any) => {
    const scope: Scope = name === 'heartbeat_table_leases_v4' ? 'cash' : 'tournament';
    const key = scope === 'cash' ? 'table_id' : 'tournament_id';
    pending[scope]++;
    maximum[scope] = Math.max(maximum[scope], pending[scope]);
    maximum.total = Math.max(maximum.total, pending.cash + pending.tournament);
    let resolve!: (value: any) => void;
    const reply = new Promise<any>((done) => {
      resolve = done;
    });
    let done = false;
    const finish = (value: any) => {
      if (done) throw new Error('Response delivered twice');
      done = true;
      pending[scope]--;
      resolve(value);
    };
    calls.push({
      scope,
      started: now,
      args,
      settle: (state = 'kept', generation) =>
        finish({
          error: null,
          data: args.p_claims.map((claim: any) => ({
            [key]: claim[key],
            state,
            lease_generation: generation ?? claim.lease_generation,
          })),
        }),
      fail: () => finish({ error: { message: 'transport_unknown' }, data: null }),
    });
    return reply;
  });
  return { calls, pending, maximum };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
async function advance(ms: number) {
  now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}
function valid(scope: Scope, fixture: ReturnType<typeof serverFixture>) {
  return scope === 'cash'
    ? fixture.cash.hasCurrentEngineLeaseAuthority()
    : fixture.tournament.hasCurrentTournamentLeaseAuthority();
}
function deadline(scope: Scope, fixture: ReturnType<typeof serverFixture>) {
  return scope === 'cash'
    ? fixture.cash.getEngineLeaseAuthority()?.proofDeadlineMonotonicMs
    : (fixture.tournament as any).tournamentLeaseProofDeadlineMonotonicMs;
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  rpc.mockReset();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  _setTableLeaseMonotonicNowForTests(() => now);
  _setTournamentLeaseMonotonicNowForTests(() => now);
  _setEngineLeaseMonotonicNowForTests(() => now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  for (const item of live.splice(0)) {
    if (item instanceof ServerTableEngine) item.fenceForEngineLeaseLoss('test_cleanup', false);
    else item.fenceForTournamentLeaseLoss();
  }
  _setTableLeaseMonotonicNowForTests();
  _setTournamentLeaseMonotonicNowForTests();
  _setEngineLeaseMonotonicNowForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the actual GameServer lease composition hedges each scope independently', () => {
  it.each<Scope>(['cash', 'tournament'])(
    'one hung %s request cannot prevent later proofs',
    async (scope) => {
      const fixture = serverFixture();
      const t = transport();
      void fixture.server.renewOwnedEngineLeaseProofs();
      t.calls.find((c) => c.scope !== scope)!.settle();
      await flush();
      for (let i = 1; i <= 6; i++) {
        await advance(5_000);
        void fixture.server.renewOwnedEngineLeaseProofs();
        for (const c of t.calls.filter((c) => c.started === now)) c.settle();
        await flush();
        expect(valid(scope, fixture)).toBe(true);
      }
      expect(t.maximum[scope]).toBe(2);
      expect(t.maximum.total).toBeLessThanOrEqual(6);
    }
  );

  it('uniform six-second responses keep both scopes alive through the primary loop', async () => {
    const fixture = serverFixture();
    const t = transport();
    const loop = fixture.server.runOwnershipLeaseRenewalLoop(1);
    for (let i = 0; i < 60; i++) {
      await advance(1_000);
      for (const c of t.calls.filter((c) => now - c.started === 6_000)) c.settle();
      await flush();
      expect(valid('cash', fixture)).toBe(true);
      expect(valid('tournament', fixture)).toBe(true);
    }
    expect(t.calls.filter((c) => c.scope === 'cash')).toHaveLength(13);
    expect(t.maximum.cash).toBe(2);
    expect(t.maximum.tournament).toBe(2);
    fixture.server.running = false;
    fixture.server.lifecycleGeneration++;
    const count = t.calls.length;
    await advance(5_000);
    await loop;
    expect(t.calls).toHaveLength(count);
  });

  it.each<Scope>(['cash', 'tournament'])(
    'three stalled %s calls do not starve the other scope',
    async (stalled) => {
      const fixture = serverFixture();
      const t = transport();
      // Test admission capacity independently of normal authority expiry: a real
      // owner would correctly expire after 20s without a response, tested below.
      for (let i = 0; i < 4; i++) {
        if (i > 0) await advance(5_000);
        void fixture.server.renewOwnedEngineLeaseProofs();
        void fixture.server.renewOwnedEngineLeaseProofs(); // same-cadence direct/handoff call
        for (const c of t.calls.filter((c) => c.started === now && c.scope !== stalled)) c.settle();
        await flush();
      }
      expect(t.calls.filter((c) => c.scope === stalled)).toHaveLength(3);
      expect(t.calls.filter((c) => c.scope !== stalled)).toHaveLength(4);
      expect(t.maximum[stalled]).toBe(3);
      expect(t.maximum.total).toBeLessThanOrEqual(6);
      t.calls.find((c) => c.scope === stalled)!.settle();
      await flush();
      await advance(1_000);
      void fixture.server.renewOwnedEngineLeaseProofs();
      await flush();
      // Capacity returns at a later tick; no queued catch-up is replayed.
      expect(t.calls.filter((c) => c.scope === stalled)).toHaveLength(4);
    }
  );

  it('both scopes stop at six real RPCs with no catch-up queue', async () => {
    const fixture = serverFixture();
    const t = transport();
    for (let i = 0; i < 4; i++) {
      if (i > 0) await advance(5_000);
      for (let caller = 0; caller < 12; caller++) void fixture.server.renewOwnedEngineLeaseProofs();
      await flush();
    }
    expect(t.calls).toHaveLength(6);
    expect(t.maximum.total).toBe(6);
    await advance(5_001);
    expect(valid('cash', fixture)).toBe(false);
    expect(valid('tournament', fixture)).toBe(false);
    for (const c of t.calls) c.settle();
    await flush();
    expect(valid('cash', fixture)).toBe(false);
    expect(valid('tournament', fixture)).toBe(false);
  });

  it.each<Scope>(['cash', 'tournament'])(
    'an obsolete %s success cannot erase newer valid proof',
    async (scope) => {
      const fixture = serverFixture();
      const t = transport();
      void fixture.server.renewOwnedEngineLeaseProofs();
      for (const c of t.calls.filter((c) => c.scope !== scope)) c.settle();
      await flush();
      await advance(5_000);
      void fixture.server.renewOwnedEngineLeaseProofs();
      for (const c of t.calls.filter((c) => c.started === 5_000)) c.settle();
      await flush();
      expect(deadline(scope, fixture)).toBe(25_000);
      await advance(15_001);
      t.calls.find((c) => c.scope === scope && c.started === 0)!.settle();
      await flush();
      expect(deadline(scope, fixture)).toBe(25_000);
      expect(valid(scope, fixture)).toBe(true);
    }
  );

  it.each<Scope>(['cash', 'tournament'])(
    'a genuine %s takeover remains a loss even from an earlier request',
    async (scope) => {
      const fixture = serverFixture();
      const t = transport();
      void fixture.server.renewOwnedEngineLeaseProofs();
      await advance(5_000);
      void fixture.server.renewOwnedEngineLeaseProofs();
      for (const c of t.calls.filter((c) => c.started === 5_000)) c.settle();
      await flush();
      t.calls.find((c) => c.scope === scope && c.started === 0)!.settle('taken', id(99));
      await flush();
      expect(valid(scope, fixture)).toBe(false);
      // Once fenced, no still-pending success can revive the owner.
      expect(
        scope === 'cash'
          ? fixture.server.recoverDirectTableEngine
          : fixture.server.stopTournamentManagerIfOwned
      ).toHaveBeenCalled();
    }
  );

  it.each(['busy', 'unknown'])(
    '%s replies never extend either twenty-second window',
    async (state) => {
      const fixture = serverFixture();
      const t = transport();
      for (let i = 0; i < 4; i++) {
        if (i) await advance(5_000);
        void fixture.server.renewOwnedEngineLeaseProofs();
        for (const c of t.calls.filter((c) => c.started === now))
          state === 'busy' ? c.settle('busy') : c.fail();
        await flush();
      }
      expect(deadline('cash', fixture)).toBe(20_000);
      expect(deadline('tournament', fixture)).toBe(20_000);
      await advance(5_000);
      expect(valid('cash', fixture)).toBe(false);
      expect(valid('tournament', fixture)).toBe(false);
    }
  );

  it('checks the previous deadline before a stalled event loop applies later valid proof', async () => {
    const fixture = serverFixture();
    const t = transport();
    now = 5_000;
    void fixture.server.renewOwnedEngineLeaseProofs();
    // No timer callbacks run while monotonic time crosses the old proof.
    now = 20_001;
    for (const c of t.calls) c.settle();
    await flush();
    expect(valid('cash', fixture)).toBe(false);
    expect(valid('tournament', fixture)).toBe(false);
  });

  it.each(['kept', 'taken'])(
    'an old %s response cannot modify replacement acquisitions',
    async (state) => {
      const fixture = serverFixture();
      const t = transport();
      void fixture.server.renewOwnedEngineLeaseProofs();
      fixture.cash.fenceForEngineLeaseLoss('replace_for_test', false);
      fixture.tournament.fenceForTournamentLeaseLoss();
      const replacementCash = new ServerTableEngine(id(1), {
        scope: 'cash',
        verified: true,
        generation: id(41),
        proofDeadlineMonotonicMs: 30_000,
      });
      (replacementCash as any).running = true;
      const replacementTournament = new Manager(id(2), fixture.server, id(42), 30_000).activate();
      live.push(replacementCash, replacementTournament);
      fixture.server.tableEngines.set(id(1), replacementCash);
      fixture.server.tournamentEngines.set(id(2), replacementTournament);
      for (const c of t.calls) c.settle(state);
      await flush();
      expect(replacementCash.hasCurrentEngineLeaseAuthority()).toBe(true);
      expect(replacementCash.getEngineLeaseAuthority()?.proofDeadlineMonotonicMs).toBe(30_000);
      expect(replacementTournament.hasCurrentTournamentLeaseAuthority()).toBe(true);
      expect((replacementTournament as any).tournamentLeaseProofDeadlineMonotonicMs).toBe(30_000);
      expect(fixture.server.recoverDirectTableEngine).not.toHaveBeenCalled();
      expect(fixture.server.stopTournamentManagerIfOwned).not.toHaveBeenCalled();
    }
  );

  it('old-process responses cannot renew after the lifecycle generation changes', async () => {
    const fixture = serverFixture();
    const t = transport();
    now = 5_000;
    void fixture.server.renewOwnedEngineLeaseProofs();
    fixture.server.lifecycleGeneration++;
    for (const c of t.calls) c.settle();
    await flush();
    expect(deadline('cash', fixture)).toBe(20_000);
    expect(deadline('tournament', fixture)).toBe(20_000);
  });

  it('authorized shutdown shares bounds and joins every remaining RPC before final release', async () => {
    const fixture = serverFixture();
    const t = transport();
    const primary = fixture.server.runOwnershipLeaseRenewalLoop(1);
    fixture.server.startShutdownOwnershipLeaseRenewal();
    await flush();
    await advance(5_000);
    await advance(5_000);
    expect(t.calls).toHaveLength(6);
    fixture.server.running = false;
    fixture.server.lifecycleGeneration++;
    let drained = false;
    const stop = fixture.server.stopShutdownOwnershipLeaseRenewal().then(() => {
      drained = true;
    });
    await advance(5_000);
    await primary;
    expect(drained).toBe(false);
    expect(t.calls).toHaveLength(6);
    for (const c of t.calls) c.settle();
    await flush();
    await stop;
    expect(drained).toBe(true);
    await advance(10_000);
    expect(t.calls).toHaveLength(6);
  });
});
