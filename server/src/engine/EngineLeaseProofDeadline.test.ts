import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _setEngineLeaseMonotonicNowForTests,
  type EngineLeaseAuthority,
} from './ServerTableEngineBase.js';
import { ServerTableEngine } from './ServerTableEngine.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const TABLE = '11111111-2222-4333-8444-555555555555';
const GENERATION = 'aaaaaaaa-0000-4000-8000-000000000001';

const verifiedCash = (deadline: number): EngineLeaseAuthority => ({
  scope: 'cash',
  verified: true,
  generation: GENERATION,
  proofDeadlineMonotonicMs: deadline,
});

function activate(engine: ServerTableEngine): void {
  const internals = engine as unknown as {
    running: boolean;
    armEngineLeaseExpiryTimer(): void;
  };
  internals.running = true;
  internals.armEngineLeaseExpiryTimer();
}

afterEach(() => {
  _setEngineLeaseMonotonicNowForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('table-engine distributed lease proof deadline', () => {
  it('fail-stops a verified dealer before the 30-second database takeover boundary', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);

    now = 19_999;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(engine.isRunning()).toBe(true);

    now = 20_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.isRunning()).toBe(false);
  });

  it('re-arms only the same immutable scope and generation before expiry', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);

    now = 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.renewEngineLeaseProof(verifiedCash(25_000))).toBe(true);
    expect(
      engine.renewEngineLeaseProof({
        scope: 'tournament',
        verified: true,
        generation: 'bbbbbbbb-0000-4000-8000-000000000001',
        tournamentId: 'aaaaaaaa-0000-4000-8000-000000000001',
        proofDeadlineMonotonicMs: 30_000,
      })
    ).toBe(false);

    now = 20_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(engine.isRunning()).toBe(true);

    now = 25_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.isRunning()).toBe(false);
  });

  it('fences a delayed continuation before its timer callback gets CPU', () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);

    /* Model a blocked event loop: monotonic time crossed the authority
       deadline, but fake timers have deliberately not advanced. */
    now = 20_001;
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(false);
    expect(engine.isRunning()).toBe(false);
  });

  it('refuses new proof after an event-loop stall before the old expiry timer runs', () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);
    now = 20_001;
    expect(engine.renewEngineLeaseProof(verifiedCash(25_000))).toBe(false);
    expect(engine.getEngineLeaseAuthority()).toMatchObject({ proofDeadlineMonotonicMs: 20_000 });
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(false);
  });

  it('keeps only an explicitly injected test-harness authority unverified', () => {
    let now = 1_000_000;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, {
      scope: 'cash',
      verified: false,
      generation: null,
      proofDeadlineMonotonicMs: null,
    });
    activate(engine);
    now += 1_000_000;
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(true);
    expect(engine.isRunning()).toBe(true);
    engine.fenceForEngineLeaseLoss('test_cleanup', false);
  });

  it('does not treat an already-terminal child dealer as loss of its live parent lease', () => {
    let now = 5_000;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    const internals = engine as unknown as { terminal: boolean };
    internals.terminal = true;

    now = 10_000;
    expect(engine.renewEngineLeaseProof(verifiedCash(30_000))).toBe(true);
    expect(engine.getEngineLeaseAuthority()).toMatchObject({
      verified: true,
      proofDeadlineMonotonicMs: 30_000,
    });
  });

  it('never shortens proof when concurrent heartbeat responses complete out of order', async () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);

    now = 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.renewEngineLeaseProof(verifiedCash(30_000))).toBe(true);
    expect(engine.renewEngineLeaseProof(verifiedCash(25_000))).toBe(true);

    now = 25_001;
    await vi.advanceTimersByTimeAsync(20_001);
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(true);
    expect(engine.getEngineLeaseAuthority()).toMatchObject({
      proofDeadlineMonotonicMs: 30_000,
    });
    engine.fenceForEngineLeaseLoss('test_cleanup', false);
  });
});
