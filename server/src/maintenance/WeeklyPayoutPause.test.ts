import { describe, it, expect, vi } from 'vitest';
import { WeeklyPayoutPause, type WeeklyPayoutBoundary } from './WeeklyPayoutPause.js';
const boundary = (): WeeklyPayoutBoundary => ({
  runId: '10000000-0000-0000-0000-000000000001',
  ownershipToken: '10000000-0000-0000-0000-000000000002',
  scopeKind: 'global',
  scopeId: '10000000-0000-0000-0000-000000000003',
  periodStart: '2026-10-19T07:00:00Z',
  periodEnd: '2026-10-26T07:00:00Z',
  phase: 'draining',
  announcedAt: -120000,
  moneyStartsAt: 0,
  expiresAt: 300000,
  moneyDeadlineAt: 240000,
});
function fixture() {
  let now = -100_000;
  let parked = false;
  const holds = new Set<string>();
  const engine = {
    pauseForWeeklyPayout: (x: string) => holds.add(x),
    engageWeeklyPayoutHandPause: vi.fn(),
    resumeFromWeeklyPayout: (x: string) => holds.delete(x),
    isParkedForWeeklyPayout: (x: string) => parked && holds.has(x),
    isRunning: () => true,
  };
  const engines = [engine];
  const admit = vi.fn(
    async (b: WeeklyPayoutBoundary): Promise<WeeklyPayoutBoundary> => ({
      ...b,
      phase: 'ready' as const,
    })
  );
  const read = vi.fn(async () => ({ ...boundary(), phase: 'released' as const }));
  const pause = new WeeklyPayoutPause({
    engines: () => engines,
    admit,
    read,
    now: () => now,
    onChanged: vi.fn(),
  });
  return {
    pause,
    admit,
    read,
    engine,
    engines,
    holds,
    setParked: () => {
      parked = true;
      now = 0;
    },
    setNow: (n: number) => {
      now = n;
    },
  };
}
describe('original weekly financial pause ownership', () => {
  it('keeps a future row quiet, announces at 03:58 and captures the live hand only at 04:00', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.setNow(-300000);
      f.pause.accept(boundary());
      expect(f.holds.size).toBe(0);
      f.setNow(-120000);
      await vi.advanceTimersByTimeAsync(180000);
      expect(f.holds.size).toBe(1);
      expect(f.engine.engageWeeklyPayoutHandPause).not.toHaveBeenCalled();
      f.setNow(-1);
      await vi.advanceTimersByTimeAsync(119999);
      expect(f.engine.engageWeeklyPayoutHandPause).not.toHaveBeenCalled();
      f.setNow(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.engine.engageWeeklyPayoutHandPause).toHaveBeenCalledTimes(1);
      expect(f.admit).not.toHaveBeenCalled();
      f.setParked();
      await f.pause.handBoundary();
      expect(f.admit).toHaveBeenCalledTimes(1);
      expect(f.pause.snapshot()?.moneyDeadlineAt).toBe(240000);
    } finally {
      f.pause.stop();
      vi.useRealTimers();
    }
  });
  it('finishes the hand before admission and admits all actual parks once', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    await f.pause.handBoundary();
    expect(f.admit).not.toHaveBeenCalled();
    f.setParked();
    await f.pause.handBoundary();
    await f.pause.handBoundary();
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.pause.snapshot()?.phase).toBe('ready');
  });
  it('retains unresolved original custody even when that table engine has stopped', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.setParked();
    const retained = {
      ...f.engine,
      isRunning: () => false,
      hasUnretiredStoppedTimeBankCustody: () => true,
    };
    f.engines.push(retained);
    await f.pause.handBoundary();
    expect(f.admit).not.toHaveBeenCalled();
    retained.hasUnretiredStoppedTimeBankCustody = () => false;
    await f.pause.handBoundary();
    expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it('retains an original asynchronous writer even after its table stops', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.setParked();
    const stopped = {
      ...f.engine,
      isRunning: () => false,
      hasWeeklyPayoutMutationInFlight: () => true,
    };
    f.engines.push(stopped);
    await f.pause.handBoundary();
    expect(f.admit).not.toHaveBeenCalled();
    stopped.hasWeeklyPayoutMutationInFlight = () => false;
    await f.pause.handBoundary();
    expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it('admits a stable hand at four under the original unchanged deadline', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.setNow(0);
    f.setParked();
    await f.pause.handBoundary();
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.pause.snapshot()?.phase).toBe('ready');
    expect(f.pause.snapshot()?.moneyDeadlineAt).toBe(240000);
    f.setNow(300000);
    f.pause.expire();
    expect(f.holds.size).toBe(0);
  });
  it('adopts new engines into the same pause before they can deal', () => {
    const f = fixture();
    f.pause.accept(boundary());
    const other = { ...f.engine, pauseForWeeklyPayout: vi.fn() };
    f.pause.adopt(other);
    expect(other.pauseForWeeklyPayout).toHaveBeenCalledTimes(1);
  });
  it('cannot admit after the money deadline or renew the freeze', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.setParked();
    f.setNow(240000);
    await f.pause.handBoundary();
    expect(f.admit).not.toHaveBeenCalled();
    expect(() =>
      f.pause.accept({
        ...boundary(),
        announcedAt: -20000,
        moneyStartsAt: 100000,
        expiresAt: 400000,
        moneyDeadlineAt: 340000,
      })
    ).toThrow('deadline_renewal');
  });
  it('expires only its gameplay hold after the absolute safety bound without replaying money', () => {
    const f = fixture();
    f.pause.accept({ ...boundary(), phase: 'paying' });
    f.setNow(299999);
    f.pause.expire();
    expect(f.holds.size).toBe(1);
    f.setNow(300000);
    f.pause.expire();
    expect(f.holds.size).toBe(0);
    expect(f.admit).not.toHaveBeenCalled();
  });
  it('cannot release a different run or owner', () => {
    for (const change of [
      { runId: '20000000-0000-0000-0000-000000000001' },
      { ownershipToken: '20000000-0000-0000-0000-000000000002' },
      { scopeId: '20000000-0000-0000-0000-000000000003' },
      { periodEnd: '2026-10-27T07:00:00Z' },
    ]) {
      const f = fixture();
      f.pause.accept(boundary());
      expect(() => f.pause.accept({ ...boundary(), ...change, phase: 'released' })).toThrow(
        'owner_changed'
      );
      expect(f.holds.size).toBe(1);
    }
  });
  it('on unknown admission reads the same durable operation and never calls a payer', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.setParked();
    f.admit.mockRejectedValueOnce(new Error('transport_unknown'));
    await expect(f.pause.handBoundary()).rejects.toThrow('transport_unknown');
    expect(f.holds.size).toBe(1);
    await f.pause.reconcile();
    expect(f.read).toHaveBeenCalledWith(boundary());
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.holds.size).toBe(0);
  });
  it('does not release on an unreadable terminal outcome', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.read.mockRejectedValueOnce(new Error('unreadable'));
    await expect(f.pause.reconcile()).rejects.toThrow('unreadable');
    expect(f.holds.size).toBe(1);
  });
  it('refuses stale phase regression without replaying a committed money phase', async () => {
    const f = fixture();
    f.pause.accept({ ...boundary(), phase: 'paying' });
    await f.pause.handBoundary();
    expect(f.admit).not.toHaveBeenCalled();
    expect(() => f.pause.accept(boundary())).toThrow('phase_regression');
  });
  it('shutdown invalidates an in-flight acknowledgement without resuming tables', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.setParked();
    let finish!: (b: WeeklyPayoutBoundary) => void;
    f.admit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.pause.handBoundary();
    f.pause.stop();
    finish({ ...boundary(), phase: 'ready' });
    await pending;
    expect(f.pause.snapshot()?.phase).toBe('draining');
    expect(f.holds.size).toBe(1);
    expect(() => f.pause.accept({ ...boundary(), phase: 'released' })).toThrow(
      'controller_stopped'
    );
  });
  it('serializes concurrent actual hand-boundary events', async () => {
    const f = fixture();
    f.pause.accept(boundary());
    f.setParked();
    let finish!: (b: WeeklyPayoutBoundary) => void;
    f.admit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = f.pause.handBoundary();
    await f.pause.handBoundary();
    expect(f.admit).toHaveBeenCalledTimes(1);
    finish({ ...boundary(), phase: 'ready' });
    await first;
  });
});

describe('the real table keeps payout and maintenance ownership separate', () => {
  it('a foreign release cannot remove the weekly pause', async () => {
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine('aaaaaaaa-1111-2222-3333-444444444444');
    e.pauseForWeeklyPayout('original-run:owner-one');
    expect(e.isPausedByDesign()).toBe(true);
    e.resumeFromWeeklyPayout('foreign-owner');
    expect(e.isPausedByDesign()).toBe(true);
    e.resumeFromMaintenance();
    expect(e.isPausedByDesign()).toBe(true);
    e.resumeDealing();
    expect(e.isPausedByDesign()).toBe(true);
    e.resumeFromWeeklyPayout('original-run:owner-one');
    expect(e.isPausedByDesign()).toBe(false);
  }, 120_000);
  it('weekly completion cannot lift daily maintenance', async () => {
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine('aaaaaaaa-1111-2222-3333-444444444444');
    e.pauseForMaintenance(300000);
    e.pauseForWeeklyPayout('original-run:owner-one');
    e.resumeFromWeeklyPayout('original-run:owner-one');
    expect(e.isMaintenancePaused()).toBe(true);
    expect(e.isPausedByDesign()).toBe(true);
    e.resumeFromMaintenance();
  }, 60_000);
});

describe('an actual table park is the admission event', () => {
  it('does not let the generic safety timer lift the owned financial pause', async () => {
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    vi.useFakeTimers();
    try {
      const e = new ServerTableEngine('aaaaaaaa-1111-2222-3333-444444444444') as any;
      e.running = true;
      e.pauseForWeeklyPayout('exact-week-owner');
      e.engageWeeklyPayoutHandPause('exact-week-owner');
      const boundaryEvent = vi.fn();
      e.onWeeklyPayoutBoundary(boundaryEvent);
      let resolved = false;
      const parked = e.awaitPauseGate().then(() => {
        resolved = true;
      });
      expect(e.isParkedForWeeklyPayout('exact-week-owner')).toBe(true);
      expect(boundaryEvent).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120001);
      expect(resolved).toBe(false);
      e.resumeFromWeeklyPayout('foreign-week-owner');
      expect(resolved).toBe(false);
      e.resumeFromWeeklyPayout('exact-week-owner');
      await parked;
      expect(resolved).toBe(true);
      e.running = false;
    } finally {
      vi.useRealTimers();
    }
  }, 120000);
});
