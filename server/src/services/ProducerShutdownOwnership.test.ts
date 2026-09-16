import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HorseFleetManager } from './HorseFleetManager.js';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { ScheduledTournamentService } from './ScheduledTournamentService.js';
import { HorseLifecycleManager } from './HorseLifecycleManager.js';
import { RakebackSettlerService } from './RakebackSettlerService.js';
import { DealRateVerifier } from './DealRateVerifier.js';
import { StatsHealthMonitor } from '../observability/StatsHealthMonitor.js';
import {
  ClusterController,
  type ClusterControllerDeps,
  type ClusterTickAllResult,
} from '../cluster/ClusterController.js';

type LifecycleHarness = {
  stop: () => Promise<void>;
  trackLifecycleJob: <T>(job: Promise<T>) => Promise<T>;
  lifecycleJobs: Set<Promise<unknown>>;
};
type Rpc = NonNullable<ClusterControllerDeps['rpc']>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cluster(overrides: Partial<ClusterControllerDeps> = {}): ClusterController {
  return new ClusterController({
    eligibleHorseCount: () => 0,
    eligibleCounts: () => new Map(),
    ensureEngine: async () => true,
    hasEngine: () => true,
    seatedCount: async () => 0,
    frozen: () => false,
    rpc: (async () => ({
      data: {
        ok: true,
        games: 0,
        ticked: 0,
        errors: 0,
        rested: 0,
        deferred: 0,
        results: [],
        rested_games: [],
      },
      error: null,
    })) as unknown as Rpc,
    ...overrides,
  });
}

function statsMonitor() {
  return new StatsHealthMonitor({
    read: async () => ({}),
    raise: async () => true,
    resolve: async () => true,
    paused: () => false,
    log: () => {},
  });
}

const services = [
  ['HorseFleetManager', () => new HorseFleetManager()],
  ['TournamentRecurringService', () => new TournamentRecurringService()],
  ['ScheduledTournamentService', () => new ScheduledTournamentService()],
  ['HorseLifecycleManager', () => new HorseLifecycleManager()],
  ['RakebackSettlerService', () => new RakebackSettlerService()],
  ['DealRateVerifier', () => new DealRateVerifier(() => [])],
  ['StatsHealthMonitor', () => statsMonitor()],
  ['ClusterController', () => cluster()],
] as const;

describe.each(services)('%s shutdown ownership', (_name, make) => {
  it('returns one idempotent stop promise and joins jobs to a fixed point', async () => {
    const service = make() as unknown as LifecycleHarness;
    const firstGate = deferred<void>();
    void service.trackLifecycleJob(firstGate.promise);

    const firstStop = service.stop();
    const concurrentStop = service.stop();
    expect(concurrentStop).toBe(firstStop);

    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    // Model a continuation that registers child work while the first snapshot
    // is draining. A one-shot Promise.all would miss it; the fixed-point loop
    // must take another snapshot.
    const childGate = deferred<void>();
    void service.trackLifecycleJob(childGate.promise);
    firstGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    childGate.resolve();
    await firstStop;
    expect(stopped).toBe(true);
    expect(service.lifecycleJobs.size).toBe(0);
  });
});

describe('shared-state producer launch ownership', () => {
  it('joins the HorseLifecycle startup pass instead of only clearing its timer', async () => {
    const gate = deferred<void>();
    const lifecycle = new HorseLifecycleManager() as unknown as {
      start(): void;
      stop(): Promise<void>;
      performMaintenanceCycle(): Promise<void>;
    };
    lifecycle.performMaintenanceCycle = vi.fn(() => gate.promise);

    lifecycle.start();
    expect(lifecycle.performMaintenanceCycle).toHaveBeenCalledOnce();

    let stopped = false;
    const stop = lifecycle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await stop;
    expect(stopped).toBe(true);
  });

  it('joins the Rakeback startup settlement instead of only clearing its timer', async () => {
    const gate = deferred<void>();
    const settler = new RakebackSettlerService();
    settler.runSettlement = vi.fn(() => gate.promise);

    settler.start();
    expect(settler.runSettlement).toHaveBeenCalledOnce();

    let stopped = false;
    const stop = settler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await stop;
    expect(stopped).toBe(true);
  });

  it('owns a fired Rakeback catch-up settlement', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<void>();
      const settler = new RakebackSettlerService() as unknown as {
        stop(): Promise<void>;
        runSettlement(): Promise<void>;
        scheduleCatchUp(backlogRemains: boolean, generation: number | null): void;
        isRunning: boolean;
        lifecycleGeneration: number;
        acceptingSettlements: boolean;
      };
      settler.isRunning = true;
      settler.lifecycleGeneration = 17;
      settler.acceptingSettlements = true;
      settler.runSettlement = vi.fn(() => gate.promise);
      settler.scheduleCatchUp(true, 17);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settler.runSettlement).toHaveBeenCalledOnce();

      let stopped = false;
      const stop = settler.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      gate.resolve();
      await stop;
      expect(stopped).toBe(true);
      expect(settler.runSettlement).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a direct Rakeback settlement after the service stop fence', async () => {
    const settler = new RakebackSettlerService() as unknown as {
      stop(): Promise<void>;
      runSettlement(): Promise<void>;
      _runSettlementInner(): Promise<string>;
    };
    settler._runSettlementInner = vi.fn(async () => 'idle');

    await settler.stop();
    await settler.runSettlement();

    expect(settler._runSettlementInner).not.toHaveBeenCalled();
  });

  it('joins a StatsHealth read and discards its stale post-stop snapshot', async () => {
    const readGate = deferred<unknown>();
    const raise = vi.fn(async () => true);
    const resolve = vi.fn(async () => true);
    const monitor = new StatsHealthMonitor({
      read: () => readGate.promise,
      raise,
      resolve,
      paused: () => false,
      log: () => {},
    });
    monitor.start();

    let stopped = false;
    const stop = monitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    readGate.resolve({ indexLagSeconds: 9_999, recentHandsWithoutStat: 4 });
    await stop;
    expect(stopped).toBe(true);
    expect(monitor.publish()).toBeNull();
    expect(raise).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('joins a StatsHealth alert POST and aborts later stale transitions', async () => {
    const alertGate = deferred<boolean>();
    const raise = vi.fn(() => alertGate.promise);
    const resolve = vi.fn(async () => true);
    const monitor = new StatsHealthMonitor({
      read: async () => ({ indexLagSeconds: 9_999, recentHandsWithoutStat: 4 }),
      raise,
      resolve,
      paused: () => false,
      log: () => {},
    });
    monitor.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(raise).toHaveBeenCalledOnce();

    let stopped = false;
    const stop = monitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    alertGate.resolve(true);
    await stop;
    expect(stopped).toBe(true);
    // The trigger-gap alert is later in evaluate(); the old generation must
    // not send it after the lag-alert POST returns into a stopped monitor.
    expect(raise).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('joins a DealRate database check and suppresses its stale verdict', async () => {
    const readGate = deferred<boolean>();
    const verifier = new DealRateVerifier(() => []) as unknown as {
      start(): void;
      stop(): Promise<void>;
      check(): Promise<void>;
      snapshot(): { belowFloorChecks: number; lastCheckedAt: number };
      fleetDarkAcrossRestarts(): Promise<boolean>;
    };
    verifier.fleetDarkAcrossRestarts = vi.fn(() => readGate.promise);
    verifier.start();
    const check = verifier.check();
    await Promise.resolve();

    let stopped = false;
    const stop = verifier.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    readGate.resolve(true);
    await Promise.all([check, stop]);
    expect(stopped).toBe(true);
    expect(verifier.snapshot().belowFloorChecks).toBe(0);
    expect(verifier.snapshot().lastCheckedAt).toBe(0);
  });

  it('joins a DealRate alert POST already admitted before stop', async () => {
    const alertGate = deferred<void>();
    const verifier = new DealRateVerifier(() => []) as unknown as {
      stop(): Promise<void>;
      launchAlert(job: Promise<unknown>, context: string): void;
    };
    verifier.launchAlert(alertGate.promise, 'test.alert');

    let stopped = false;
    const stop = verifier.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    alertGate.resolve();
    await stop;
    expect(stopped).toBe(true);
  });
});

describe('ClusterController generation fence', () => {
  it('does not start a dealer from an RPC response returned after stop', async () => {
    const rpcGate = deferred<{ data: ClusterTickAllResult; error: null }>();
    const ensureEngine = vi.fn(async () => true);
    const seatedCount = vi.fn(async () => 1);
    const controller = cluster({
      rpc: vi.fn(() => rpcGate.promise) as unknown as Rpc,
      hasEngine: () => false,
      seatedCount,
      ensureEngine,
    });
    controller.start();
    const tick = controller.tick();
    await Promise.resolve();

    const stopped = controller.stop();
    rpcGate.resolve({
      data: {
        ok: true,
        games: 1,
        ticked: 1,
        errors: 0,
        rested: 0,
        deferred: 0,
        results: [
          {
            game_id: 'game-1',
            main1_table_id: 'table-1',
            enabled: true,
            result: { ok: true, actions: [], seated_total: 1 },
          },
        ],
        rested_games: [],
      },
      error: null,
    });

    await Promise.all([tick, stopped]);
    expect(seatedCount).not.toHaveBeenCalled();
    expect(ensureEngine).not.toHaveBeenCalled();
  });

  it('keeps a dealer wake detached from the pass but joins it during stop', async () => {
    const engineGate = deferred<boolean>();
    const ensureEngine = vi.fn(() => engineGate.promise);
    const controller = cluster({
      ensureEngine,
      hasEngine: () => false,
      seatedCount: async () => 1,
      rpc: (async () => ({
        data: {
          ok: true,
          games: 1,
          ticked: 1,
          errors: 0,
          rested: 0,
          deferred: 0,
          results: [
            {
              game_id: 'game-1',
              main1_table_id: 'table-1',
              enabled: true,
              result: { ok: true, actions: [], seated_total: 1 },
            },
          ],
          rested_games: [],
        },
        error: null,
      })) as unknown as Rpc,
    });

    // tick() remains a public acceptance probe while stopped. Its dealer wake
    // is detached from the pass but still belongs to the service drain.
    await controller.tick();
    expect(ensureEngine).toHaveBeenCalledWith('table-1');

    let stopped = false;
    const stop = controller.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    engineGate.resolve(true);
    await stop;
    expect(stopped).toBe(true);
  });
});

describe('producer shutdown source contract', () => {
  const source = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');

  it.each([
    'HorseFleetManager.ts',
    'TournamentRecurringService.ts',
    'ScheduledTournamentService.ts',
    'HorseLifecycleManager.ts',
    'RakebackSettlerService.ts',
    'DealRateVerifier.ts',
    '../observability/StatsHealthMonitor.ts',
    '../cluster/ClusterController.ts',
  ])('%s fences synchronously and drains every owned promise', (file) => {
    const code = source(file);
    expect(code).toMatch(/stop\(\): Promise<void>/);
    expect(code).toContain('this.lifecycleGeneration++');
    expect(code).toMatch(/while \(this\.lifecycleJobs\.size > 0\)/);
    expect(code).toContain('await Promise.allSettled([...this.lifecycleJobs])');
    const stop = code.slice(code.indexOf('stop(): Promise<void>'));
    expect(stop.indexOf('this.lifecycleGeneration++')).toBeLessThan(
      stop.indexOf('this.drainLifecycleJobs()')
    );
  });

  it('routes every timer/immediate producer through an owned launcher', () => {
    const horse = source('HorseFleetManager.ts');
    expect(horse).not.toMatch(/this\.seedAllTables\(\)\.catch/);
    expect(horse).toContain('this.launchSeedCycle(generation');

    const recurring = source('TournamentRecurringService.ts');
    expect(recurring.match(/this\.launchLifecycleJob\(/g)?.length).toBeGreaterThanOrEqual(10);
    expect(recurring).not.toMatch(/^\s*this\.checkAndLaunch(?:Tournaments|SNGs|Spins|XMTTs)\(\);/m);
    expect(recurring).not.toMatch(/^\s*this\.checkAndCreateFreeBuys\(\);/m);

    const scheduled = source('ScheduledTournamentService.ts');
    expect(scheduled).not.toContain('void this.poll()');
    expect(scheduled).toContain('this.launchPoll(generation)');

    const lifecycle = source('HorseLifecycleManager.ts');
    expect(lifecycle).not.toContain('this.performMaintenanceCycle();');
    expect(lifecycle).toContain('this.launchMaintenanceCycle(generation)');

    const rakeback = source('RakebackSettlerService.ts');
    expect(rakeback).not.toMatch(/this\.runSettlement\(\)\.catch/);
    expect(rakeback).toContain("this.launchSettlement(generation, 'RakebackSettler.startup_run')");
    expect(rakeback).toContain("this.launchSettlement(generation, 'RakebackSettler.catch_up_run')");

    const dealRate = source('DealRateVerifier.ts');
    expect(dealRate).not.toContain('void this.check()');
    expect(dealRate).toContain('this.launchCheck(generation)');
    expect(dealRate).not.toMatch(/void (?:raiseEngineAlert|resolveEngineAlert)/);
    expect(dealRate.match(/this\.launchAlert\(/g)?.length).toBeGreaterThanOrEqual(6);

    const stats = source('../observability/StatsHealthMonitor.ts');
    expect(stats).not.toContain('void this.tick()');
    expect(stats).toContain('this.launchTick(generation)');
    expect(stats).toMatch(
      /await this\.trackLifecycleJob\([\s\S]{0,180}Promise\.resolve\(\)\.then\([\s\S]{0,180}return work\(\)/
    );

    const controller = source('../cluster/ClusterController.ts');
    expect(controller).not.toMatch(/void this\.deps\s*\.ensureEngine/);
    expect(controller).toMatch(/this\.deps\.ensureEngine\(tableId\)\.then/);
  });

  it('fences the continuations that can create post-stop work', () => {
    const horse = source('HorseFleetManager.ts');
    expect(horse).toMatch(
      /await this\.ensureAllTablesExist\(\);\s*if \(!this\.lifecycleIsCurrent\(generation\)\) return;/
    );

    const scheduled = source('ScheduledTournamentService.ts');
    expect(scheduled).toMatch(
      /await supabase[\s\S]{0,220}\.eq\('active', true\);\s*if \(!this\.lifecycleIsCurrent\(generation\)\) return;/
    );

    const controller = source('../cluster/ClusterController.ts');
    expect(controller).toMatch(
      /await rpc\('fn_cash_clusters_tick_all'[\s\S]{0,160}!this\.lifecycleIsCurrent\(generation\)/
    );
    expect(controller).toMatch(
      /await this\.deps\.seatedCount\(g\.main1_table_id\);\s*if \(generation !== null && !this\.lifecycleIsCurrent\(generation\)\) return;/
    );

    const rakeback = source('RakebackSettlerService.ts');
    expect(rakeback).toMatch(
      /scheduleCatchUp\(backlogRemains: boolean, generation: number \| null\)/
    );
    expect(rakeback).toMatch(
      /generation === null[\s\S]{0,120}!this\.lifecycleIsCurrent\(generation\)/
    );

    const dealRate = source('DealRateVerifier.ts');
    expect(dealRate).toMatch(
      /await this\.fleetDarkAcrossRestarts\(\);\s*if \(this\.lifecycleEnded\(generation\)\) return;/
    );
    expect(dealRate).toMatch(
      /await this\.checkKillRate\(generation\);\s*if \(this\.lifecycleEnded\(generation\)\) return;/
    );

    const stats = source('../observability/StatsHealthMonitor.ts');
    expect(stats).toMatch(
      /const raw = await this\.deps\.read\(\);\s*if \(this\.lifecycleEnded\(generation\)\) return;/
    );
    expect(stats.match(/await this\.deliverAlert\(generation/g)?.length).toBeGreaterThanOrEqual(8);
  });
});
