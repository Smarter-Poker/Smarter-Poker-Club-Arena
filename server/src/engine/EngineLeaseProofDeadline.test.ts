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
  it('passive leave diagnostics do not expire an overdue proof or create authority', () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000)) as any;
    activate(engine);
    now = 20_001;
    const expire = vi.spyOn(engine, 'expireEngineLeaseAuthority');
    const guard = vi.spyOn(engine, 'lifecycleCanMutate');
    const current = vi.spyOn(engine, 'hasCurrentEngineLeaseAuthority');
    const renewal = vi.spyOn(engine, 'renewEngineLeaseProof');
    const before = vi.getTimerCount();
    expect(engine.leavePendingLifecycleSnapshot()).toMatchObject({
      running: true,
      terminal: false,
      lease_expired: false,
      lease_generation: GENERATION,
      proof_deadline_monotonic_ms: 20_000,
      observed_monotonic_ms: 20_001,
      first_terminal: null,
    });
    expect(vi.getTimerCount()).toBe(before);
    expect(expire).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(renewal).not.toHaveBeenCalled();
    engine.fenceForEngineLeaseLoss('test_cleanup', false);
  });
  it('refuses a late renewal before an overdue expiry timer has run', () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);
    now = 20_001;
    // Promise continuations can run before an overdue timer after an event
    // loop stall. A fresh answer must not revive this expired incarnation.
    expect(engine.renewEngineLeaseProof(verifiedCash(25_000))).toBe(false);
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(false);
    expect(engine.isRunning()).toBe(false);
  });

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

  /* ═══ THE TWO FAILURE MODES ARE NOT THE SAME FAILURE (2026-09-21) ════════
     `atomic hand commit refused (lease_proof_expired)` was raised for BOTH a
     lease that was genuinely gone and a proof that had merely gone unrenewed.
     Only the first may refuse a hand. The heartbeat client no longer reports
     a loss it has no evidence for (services/aLeaseIsNotLostBecauseNobodyAsked
     .law.test.ts), so a renewal that arrives late now arrives at all - and
     these two cases pin that the engine still tells the modes apart. */

  it('a GENUINELY lost lease still refuses the hand commit', () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);

    // Well inside the proof window: authority is current and the write is
    // authorised.
    now = 1_000;
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(true);

    // The database said this generation is gone. This is the fence a real
    // takeover takes, and it is synchronous.
    engine.fenceForEngineLeaseLoss('tournament_lease_lost', false);

    // The commit gate in ServerTableEngineSettlement is exactly this call.
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(false);
    // And no renewal may resurrect it, however fresh the offered deadline.
    expect(engine.renewEngineLeaseProof(verifiedCash(60_000))).toBe(false);
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(false);
  });

  it('a renewal that lands inside the window keeps the hand commit authorised', () => {
    vi.useFakeTimers();
    let now = 0;
    _setEngineLeaseMonotonicNowForTests(() => now);
    const engine = new ServerTableEngine(TABLE, verifiedCash(20_000));
    activate(engine);

    /* The seventh wave of a 13,000-tournament pass used to have its `kept`
       answer discarded and its manager fenced. Delivered instead, it is an
       ordinary renewal and the table keeps dealing - and keeps its history. */
    now = 19_000;
    expect(engine.renewEngineLeaseProof(verifiedCash(39_000))).toBe(true);

    now = 21_000; // past the ORIGINAL window, inside the renewed one
    expect(engine.hasCurrentEngineLeaseAuthority()).toBe(true);
    expect(engine.getEngineLeaseAuthority()).toMatchObject({
      verified: true,
      proofDeadlineMonotonicMs: 39_000,
    });
    engine.fenceForEngineLeaseLoss('test_cleanup', false);
  });
});
