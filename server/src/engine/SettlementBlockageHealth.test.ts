import { readFileSync } from 'node:fs';
import { handleHealth } from '../handlers/health.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  settlementHealthSnapshot,
  settlementPrometheusLines,
} from '../observability/SettlementHealth.js';
import { evaluateEngineLiveness } from './EngineLivenessVerdict.js';
import { ServerTableEngine } from './ServerTableEngine.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const makeEngine = () => new ServerTableEngine('62626262-6262-4262-8262-626262626262') as any;
afterEach(() => vi.useRealTimers());

describe('settlement blockage has its own clock', () => {
  it('keeps ageing while retry heartbeats report process progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const engine = makeEngine();
    const work = deferred();
    engine.trackSettlementInFlight(work.promise);
    for (let i = 0; i < 80; i++) {
      vi.setSystemTime(1_000_000 + (i + 1) * 15_000);
      engine.markProgress();
    }
    expect(engine.msSinceProgress()).toBe(0);
    expect(engine.settlementAgeMs()).toBe(1_200_000);
    work.resolve();
    await work.promise;
    expect(engine.settlementAgeMs()).toBeNull();
  });

  it('does not reset age when the same hand extends its settlement barrier', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const engine = makeEngine();
    const first = deferred();
    const second = deferred();
    engine.trackSettlementInFlight(first.promise);
    vi.setSystemTime(1_030_000);
    const extended = Promise.all([first.promise, second.promise]).then(() => undefined);
    engine.trackSettlementInFlight(extended);
    first.resolve();
    await first.promise;
    expect(engine.hasSettlementInFlight()).toBe(true);
    expect(engine.settlementAgeMs()).toBe(30_000);
    second.resolve();
    await extended;
    expect(engine.settlementAgeMs()).toBeNull();
  });

  it('starts a fresh clock for the next hand and ignores an older completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const engine = makeEngine();
    const old = deferred();
    const next = deferred();
    engine.trackSettlementInFlight(old.promise);
    engine.trackSettlementInFlight(null);
    vi.setSystemTime(2_000_000);
    engine.trackSettlementInFlight(next.promise);
    old.resolve();
    await old.promise;
    expect(engine.settlementAgeMs()).toBe(0);
    vi.setSystemTime(2_001_000);
    expect(engine.settlementAgeMs()).toBe(1_000);
    next.resolve();
    await next.promise;
    expect(engine.settlementAgeMs()).toBeNull();
  });

  it('clears completed rejection ownership without leaving a false blockage', async () => {
    const engine = makeEngine();
    const work = deferred();
    engine.trackSettlementInFlight(work.promise);
    work.reject(new Error('accepted settlement refused'));
    await expect(work.promise).rejects.toThrow('accepted settlement refused');
    await Promise.resolve();
    expect(engine.settlementAgeMs()).toBeNull();
  });
});

describe('blocked settlement telemetry', () => {
  it('reports the retrying hand while keeping the process-survival verdict independent', () => {
    const tables = [
      {
        tableId: 'table-a',
        handCount: 8251566,
        settlementAgeMs: 1_061_000,
        msSinceProgress: 0,
        dealable: 6,
        paused: false,
      },
    ];
    expect(settlementHealthSnapshot(tables)).toEqual({
      settlementStatus: 'blocked',
      blockedSettlementCount: 1,
      blockedSettlements: [{ tableId: 'table-a', handCount: 8251566, ageMs: 1_061_000 }],
    });
    expect(settlementPrometheusLines(tables)).toContain('poker_blocked_settlements 1');
    expect(settlementPrometheusLines(tables)).toContain(
      'poker_table_settlement_age_ms{table_id="table-a"} 1061000'
    );
    expect(
      evaluateEngineLiveness({
        isLeader: true,
        processUptimeMs: 1_000_000,
        discoveryLoopStalledMs: 0,
        discoveryStaleMs: 0,
        dbConfirmedDead: false,
        tables,
      }).status
    ).toBe('ok');
  });

  it('counts every blocked hand and returns the oldest 20 without mutating the snapshot', () => {
    const tables = Array.from({ length: 30 }, (_, n) => ({
      tableId: `table-${n}`,
      handCount: n,
      settlementAgeMs: 30_000 + n,
      loopPhase: `await_post_hand_tasks+${n}s`,
    }));
    const before = structuredClone(tables);
    const result = settlementHealthSnapshot(tables);
    expect(result.blockedSettlementCount).toBe(30);
    expect(result.blockedSettlements).toHaveLength(20);
    expect(result.blockedSettlements[0].tableId).toBe('table-29');
    expect(result.blockedSettlements[0].loopPhase).toBe('await_post_hand_tasks+29s');
    expect(result.blockedSettlements[19].loopPhase).toBe('await_post_hand_tasks+10s');
    expect(tables).toEqual(before);
  });

  it('excludes finished and short settlements, and includes the exact alarm boundary', () => {
    const observation = (settlementAgeMs: number | null) => [
      { tableId: 't', handCount: 1, settlementAgeMs },
    ];
    for (const age of [null, 0, 29_999]) {
      expect(settlementHealthSnapshot(observation(age)).settlementStatus).toBe('ok');
    }
    expect(settlementHealthSnapshot(observation(30_000)).blockedSettlementCount).toBe(1);

    /* A TABLE THAT IS NOT SETTLING IS NOT A SAMPLE (2026-09-11). This used to
       assert the zero line, one per table, and that is what it cost: 1,363
       samples on engine-01 and every one of them read 0, rendered on the
       authoritative event loop every fifteen seconds. The continuous clock is
       still published - as the fleet maximum, which is always present and is
       what a reader of this gauge was ever going to aggregate anyway - and the
       per-table line survives for a table that really is settling. */
    const quiet = settlementPrometheusLines(observation(null));
    expect(quiet).not.toContain('poker_table_settlement_age_ms{table_id="t"} 0');
    expect(quiet).toContain('poker_settlement_age_max_ms 0');
    expect(quiet).toContain('poker_settlements_in_flight 0');

    const settling = settlementPrometheusLines(observation(12_000));
    expect(settling).toContain('poker_table_settlement_age_ms{table_id="t"} 12000');
    expect(settling).toContain('poker_settlement_age_max_ms 12000');
    expect(settling).toContain('poker_settlements_in_flight 1');
  });
});

describe('public settlement health wiring', () => {
  it('publishes the continuous clock on both health and metrics', () => {
    const source = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    expect(source).toContain('settlementAgeMs: engine.settlementAgeMs()');
    expect(source).toContain('...settlementHealthSnapshot(tableLiveness)');
    expect(source).toContain('...settlementPrometheusLines(liveness)');
  });

  it('does not evict every healthy table from routing for one blocked settlement', () => {
    const response = { writeHead: vi.fn(), end: vi.fn() };
    const status = {
      liveness: 'ok',
      status: 'ok',
      dealerPrerequisitesReady: true,
      liveHorseDecision: { phase: 'ready' },
      ...settlementHealthSnapshot([{ tableId: 'blocked', handCount: 1, settlementAgeMs: 120_000 }]),
    };
    handleHealth(response as any, {
      gameServer: {
        getStatus: () => status,
        getPrometheusMetrics: () => '',
      },
    });
    expect(response.writeHead.mock.calls[0][0]).toBe(200);
    expect(JSON.parse(response.end.mock.calls[0][0]).settlementStatus).toBe('blocked');
  });
});
