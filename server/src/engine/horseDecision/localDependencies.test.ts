import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseMind } from '../HorseMind.js';
import { drainDecisionLatency, drainFires } from '../BrainTelemetry.js';
import type { HorseDecisionWorkerResponse, LiveHorseDecisionSnapshot } from './protocol.js';
import { buildHorseDecisionKey } from './protocol.js';
import { HorseDecisionWorkerRuntime } from './workerRuntime.js';

const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  lastFlush: '2026-09-11T00:00:00.000Z',
  gate: null as Promise<void> | null,
  fail: false,
}));
vi.mock('../../services/HorseMindPersistence.js', () => ({
  startHorseMindPersistence: () => fixture.calls.push('start:mind'),
  stopHorseMindPersistence: async () => {
    fixture.calls.push('stop:mind');
  },
  hydrateHorseMindFromDb: async () => {
    fixture.calls.push('hydrate:mind-db');
    if (fixture.gate) await fixture.gate;
    if (fixture.fail) throw new Error('fixture hydration failed');
    return fixture.lastFlush;
  },
}));
vi.mock('../../services/HorseMindHydrator.js', () => ({
  hydrateHorseMind: async (since: string | null) => {
    fixture.calls.push(`hydrate:history:${since}`);
  },
}));
vi.mock('../../services/BrainTelemetryFlush.js', async () => {
  const { enableBrainTelemetry } = await import('../BrainTelemetry.js');
  return {
    startBrainTelemetryFlush: () => {
      fixture.calls.push('start:telemetry');
      enableBrainTelemetry();
    },
    stopBrainTelemetryFlush: async () => {
      fixture.calls.push('stop:telemetry');
    },
  };
});
vi.mock('../../services/GtoChartLoader.js', () => ({
  loadGtoCharts: async () => {
    fixture.calls.push('hydrate:charts');
  },
  startGtoChartLoader: () => fixture.calls.push('start:charts'),
  stopGtoChartLoader: () => fixture.calls.push('stop:charts'),
}));
vi.mock('../../services/GtoPostflopLoader.js', () => ({
  loadGtoPostflop: async () => {
    fixture.calls.push('hydrate:postflop');
  },
  startGtoPostflopLoader: () => fixture.calls.push('start:postflop'),
  stopGtoPostflopLoader: () => fixture.calls.push('stop:postflop'),
}));
vi.mock('../../services/GtoPostflopV31Loader.js', () => ({
  loadGtoPostflopV31: async () => {
    fixture.calls.push('hydrate:v31');
  },
  startGtoPostflopV31Loader: () => fixture.calls.push('start:v31'),
  stopGtoPostflopV31Loader: () => fixture.calls.push('stop:v31'),
}));
vi.mock('../../gto/SolverPolicyArtifactLoader.js', () => ({
  solverPolicyArtifactStatus: () => ({ totalPolicies: 0 }),
  startSolverPolicyArtifactLoader: () => fixture.calls.push('start:policy'),
  stopSolverPolicyArtifactLoader: () => fixture.calls.push('stop:policy'),
}));

// The real production binding module uses the extracted lifecycle and real
// HorseLogic/HorseMind. Only I/O hooks are replaced; no Supabase client is loaded.
import { localHorseDecisionWorkerDependencies as local } from './localDependencies.js';

function snapshot(): LiveHorseDecisionSnapshot {
  const players = [
    {
      seat: 1,
      user_id: 'local-hero',
      username: 'Hero',
      stack: 98,
      bet: 2,
      totalInvested: 2,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 2,
      user_id: 'local-opponent',
      username: 'Opponent',
      stack: 96,
      bet: 4,
      totalInvested: 4,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
  ];
  const value: LiveHorseDecisionSnapshot = {
    generation: 1,
    fence: 'local:hand:turn',
    decisionKey: '',
    decisionTimeMs: 10000,
    style: 'balanced',
    mods: {},
    opts: {},
    player: {
      ...players[0],
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
    },
    gameState: {
      stateSchemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      toCall: 2,
      minRaiseTo: 6,
      maxRaiseTo: 100,
      bettingStructure: 'no_limit',
      fixedBetSize: null,
      wagersCapped: false,
      commitmentCapRemaining: null,
      players,
      communityCards: [],
      communityCards2: [],
      communityCards3: [],
      pot: 6,
      contestablePot: 6,
      currentBet: 4,
      minRaise: 2,
      stage: 'preflop',
      gameVariant: 'nlh',
      gameMode: 'cash',
      format: 'cash',
      bigBlind: 2,
      dealerSeat: 1,
      actionHistory: [
        {
          seat: 2,
          userId: 'local-opponent',
          action: 'raise',
          amount: 4,
          timestamp: 9000,
          stage: 'preflop',
          isFullRaise: true,
        },
      ],
      pots: [
        { amount: 4, eligiblePlayers: ['local-hero', 'local-opponent'] },
        { amount: 2, eligiblePlayers: ['local-opponent'] },
      ],
      rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
      variantRules: {
        holeCardsDealt: 2,
        holeCardsUse: 'any',
        boardCardsUse: 'any',
        deckSize: 52,
        splitLow8OrBetter: false,
      },
    },
  };
  value.decisionKey = buildHorseDecisionKey(value);
  return value;
}

beforeEach(async () => {
  await local.stopServices();
  fixture.calls.length = 0;
  fixture.gate = null;
  fixture.fail = false;
  HorseMind.reset();
  drainFires();
  drainDecisionLatency();
});
afterEach(async () => {
  await local.stopServices();
});

describe('actual LOCAL worker dependency construction', () => {
  it('does not start writers on import or construction and waits for hydration before READY', async () => {
    let release!: () => void;
    fixture.gate = new Promise((resolve) => {
      release = resolve;
    });
    const messages: HorseDecisionWorkerResponse[] = [];
    const runtime = new HorseDecisionWorkerRuntime((message) => messages.push(message), local);
    expect(fixture.calls).toEqual([]);
    const pending = runtime.start();
    expect(runtime.start()).toBe(pending);
    expect(fixture.calls).toEqual([
      'start:mind',
      'start:telemetry',
      'start:policy',
      'hydrate:mind-db',
    ]);
    expect(messages).toEqual([]);
    release();
    await pending;
    expect(fixture.calls.slice(4)).toEqual([
      `hydrate:history:${fixture.lastFlush}`,
      'hydrate:charts',
      'hydrate:postflop',
      'hydrate:v31',
      'start:charts',
      'start:postflop',
      'start:v31',
    ]);
    expect(messages.map((m) => m.type)).toEqual(['READY']);
    runtime.receive({ type: 'SHUTDOWN' });
    await runtime.drain();
    expect(fixture.calls.slice(-6)).toEqual([
      'stop:v31',
      'stop:postflop',
      'stop:charts',
      'stop:policy',
      'stop:telemetry',
      'stop:mind',
    ]);
    const stopped = fixture.calls.length;
    await local.stopServices();
    expect(fixture.calls).toHaveLength(stopped);
  });

  it('joins pending startup before shutdown so hydration cannot restart loaders after stop', async () => {
    let release!: () => void;
    fixture.gate = new Promise((resolve) => {
      release = resolve;
    });
    const messages: HorseDecisionWorkerResponse[] = [];
    const runtime = new HorseDecisionWorkerRuntime((message) => messages.push(message), local);
    const starting = runtime.start();
    runtime.receive({ type: 'SHUTDOWN' });
    let joined = false;
    const stopping = runtime.drain().then(() => {
      joined = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    expect(fixture.calls.some((call) => call.startsWith('stop:'))).toBe(false);
    release();
    await starting;
    await stopping;
    expect(messages.map((message) => message.type)).toEqual(['READY', 'STOPPED']);
    const lastStart = fixture.calls.lastIndexOf('start:v31');
    const firstStop = fixture.calls.findIndex((call) => call.startsWith('stop:'));
    expect(lastStart).toBeGreaterThan(-1);
    expect(firstStop).toBeGreaterThan(lastStart);
    const terminal = [...fixture.calls];
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.calls).toEqual(terminal);
  });

  it('stops all local writers and clocks when initial hydration fails without claiming READY', async () => {
    fixture.fail = true;
    const messages: HorseDecisionWorkerResponse[] = [];
    const runtime = new HorseDecisionWorkerRuntime((message) => messages.push(message), local);
    await expect(runtime.start()).rejects.toThrow('fixture hydration failed');
    expect(messages.map((m) => m.type)).toEqual(['ERROR']);
    expect(fixture.calls).not.toContain('start:charts');
    expect(fixture.calls.slice(-6)).toEqual([
      'stop:v31',
      'stop:postflop',
      'stop:charts',
      'stop:policy',
      'stop:telemetry',
      'stop:mind',
    ]);
  });

  it('keeps authoritative FAST observations ordered, dirty and deduplicated before selected intent effects commit', async () => {
    const messages: HorseDecisionWorkerResponse[] = [];
    const observationsAtSend: number[] = [];
    const runtime = new HorseDecisionWorkerRuntime((message) => {
      if (message.type === 'FAST_RESULT')
        observationsAtSend.push(
          HorseMind.exportDirty().find((r) => r.user_id === 'local-opponent')?.pfr ?? 0
        );
      messages.push(message);
    }, local);
    await runtime.start();
    const view = snapshot();
    runtime.receive({
      ...structuredClone(view),
      type: 'DECIDE_FAST',
      requestId: 1,
      style: 'balanced',
      mods: {},
      opts: {},
    });
    runtime.receive({
      ...structuredClone(view),
      type: 'DECIDE_FAST',
      requestId: 2,
      style: 'balanced',
      mods: {},
      opts: {},
    });
    await runtime.drain();
    expect(messages.filter((m) => m.type === 'ERROR')).toEqual([]);
    expect(messages.filter((m) => m.type === 'FAST_RESULT').map((m) => m.requestId)).toEqual([
      1, 2,
    ]);
    expect(observationsAtSend).toEqual([1, 0]);
    const fires = drainFires();
    expect(fires.find((f) => f.feature === 'phase5_canonical_state')?.fires).toBe(2);
    expect(drainDecisionLatency().some((r) => r.scope === 'nlh')).toBe(true);
    const capture = local.captureDecisionEffects(() =>
      HorseMind.notePlan('local-effect-hand', 'local-hero', true)
    );
    expect(HorseMind.getPlan('local-effect-hand', 'local-hero')).toBeUndefined();
    runtime.receive({
      type: 'COMMIT_DECISION_EFFECTS',
      requestId: 3,
      generation: 1,
      fence: view.fence,
      effects: capture.effects,
    });
    await runtime.drain();
    expect(HorseMind.getPlan('local-effect-hand', 'local-hero')).toBe(true);
    expect(messages.at(-1)).toMatchObject({
      type: 'ACK',
      requestId: 3,
      operation: 'COMMIT_DECISION_EFFECTS',
    });
    runtime.receive({ type: 'SHUTDOWN' });
    await runtime.drain();
  });

  it('keeps DEEP replay non-observing and applies completed public history before the next FAST request', async () => {
    const timeline: Array<{ type: string; pfr: number; cbetFolds: number }> = [];
    const messages: HorseDecisionWorkerResponse[] = [];
    const runtime = new HorseDecisionWorkerRuntime((message) => {
      messages.push(message);
      if (message.type !== 'READY')
        timeline.push({
          type: message.type,
          pfr: HorseMind.getStats('local-opponent')?.pfr ?? 0,
          cbetFolds: HorseMind.getStats('local-hero')?.cbetFolds ?? 0,
        });
    }, local);
    await runtime.start();
    const view = snapshot();
    const completion = {
      type: 'OBSERVE_COMPLETED_HAND' as const,
      requestId: 2,
      generation: 1,
      fence: view.fence,
      handKey: 'completed-public-hand',
      bigBlind: 2,
      actions: [
        { userId: 'local-opponent', action: 'raise', amount: 4, stage: 'preflop' },
        { userId: 'local-hero', action: 'call', amount: 4, stage: 'preflop' },
        { userId: 'local-opponent', action: 'bet', amount: 8, stage: 'flop' },
        { userId: 'local-hero', action: 'fold', stage: 'flop' },
      ],
    };
    runtime.receive({
      ...structuredClone(view),
      type: 'DECIDE_DEEP',
      requestId: 1,
      rngBefore: 123,
      deepEquity: 2,
    });
    runtime.receive(completion);
    runtime.receive({ ...structuredClone(view), type: 'DECIDE_FAST', requestId: 3 });
    runtime.receive({ ...completion, requestId: 4 });
    await runtime.drain();
    expect(messages.filter((m) => m.type === 'ERROR')).toEqual([]);
    expect(timeline).toEqual([
      { type: 'DEEP_RESULT', pfr: 0, cbetFolds: 0 },
      { type: 'ACK', pfr: 0, cbetFolds: 1 },
      { type: 'FAST_RESULT', pfr: 1, cbetFolds: 1 },
      { type: 'ACK', pfr: 1, cbetFolds: 1 },
    ]);
    expect(
      HorseMind.exportDirty()
        .map((row) => row.user_id)
        .sort()
    ).toEqual(['local-hero', 'local-opponent']);
    runtime.receive({ type: 'SHUTDOWN' });
    await runtime.drain();
  });
});
