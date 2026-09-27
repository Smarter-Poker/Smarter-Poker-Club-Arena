import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { tournamentEliminationScheduler } from './TournamentEliminationScheduler.js';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
class Harness extends TournamentManagerBase {
  protected startEliminationChecker() {}
  protected async recalculateEliminatedPrizes() {
    return true;
  }
  protected async resolveTournamentSeatMoveQuarantine() {
    return true;
  }
}
function manager(): any {
  return new Harness(
    id(1),
    { unregisterTournamentTableEngine: vi.fn() } as any,
    id(2),
    performance.now() + 20_000
  );
}
function original(n: number, stop = () => Promise.resolve()) {
  return {
    getLifecycleDiagnosticSnapshot: vi.fn(() =>
      Object.freeze({ instanceId: id(n), tableId: id(n) })
    ),
    stop: vi.fn(stop),
    hasReleasedProcessOwnership: () => true,
  };
}
afterEach(() => vi.restoreAllMocks());

describe('retained movement diagnostics', () => {
  it('reads the original permit and boundary without authority, mutation or binding disclosure', () => {
    const value = manager();
    const rpc = vi.fn(),
      current = vi.fn(() => true);
    const permit = new F06HandPermit(
      {
        tournament_id: id(1),
        lease_generation: id(2),
        table_id: id(100),
        lifecycle: '4',
        permit_id: id(101),
        hand_number: '20',
        custody_id: id(102),
      },
      rpc,
      current
    );
    const engine = original(100) as any;
    engine.f06CurrentPermit = permit;
    engine.claimedTournamentMovePauseOwners = new Set(['original-owner']);
    engine.tournamentMoveOperations = new Map();
    engine.getF06RetainedPermit = ServerTableEngine.prototype.getF06RetainedPermit;
    engine.hasClaimedTournamentMoveBoundary =
      ServerTableEngine.prototype.hasClaimedTournamentMoveBoundary;
    value.tableEngines.set(id(100), engine);
    value.noteSeatMoveQuarantineRefusal('recovery:claimed_move_boundary');
    const result = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(100)] });
    expect(result.seatMoveQuarantineRefusal).toBe('recovery:claimed_move_boundary');
    expect(result.originals[0].movement).toEqual({
      claimedBoundary: true,
      retainedPermit: { status: 'retained', phase: 'new' },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(permit.recoveryState()).toBe('new');
    expect(engine.f06CurrentPermit).toBe(permit);
    expect(engine.claimedTournamentMovePauseOwners.size).toBe(1);
    expect(JSON.stringify(result)).not.toContain(id(101));
    expect(JSON.stringify(result)).not.toContain(id(102));
    expect(Object.isFrozen(result.originals[0].movement)).toBe(true);
    expect(Object.isFrozen(result.originals[0].movement.retainedPermit)).toBe(true);
  });

  it.each(['new', 'reserved', 'unknown', 'attempted', 'terminated', 'number_refused'])(
    'retains observed %s distinctly from unavailable',
    (phase) => {
      const value = manager();
      value.tableEngines.set(id(100), {
        ...original(100),
        getF06RetainedPermit: () => ({ phase }),
        hasClaimedTournamentMoveBoundary: () => false,
      });
      expect(value.getLifecycleDiagnosticSnapshot().originals[0].movement).toEqual({
        claimedBoundary: false,
        retainedPermit: { status: 'retained', phase },
      });
    }
  );

  it('distinguishes no permit from absent, throwing or malformed original getters', () => {
    const value = manager();
    const absent = {
      claimedBoundary: null,
      retainedPermit: { status: 'unavailable', phase: null },
    };
    value.tableEngines.set(id(100), original(100));
    expect(value.getLifecycleDiagnosticSnapshot().originals[0].movement).toEqual(absent);
    const engine = {
      ...original(100),
      getF06RetainedPermit: () => null,
      hasClaimedTournamentMoveBoundary: () => false,
    };
    value.tableEngines.set(id(100), engine);
    expect(value.getLifecycleDiagnosticSnapshot().originals[0].movement).toEqual({
      claimedBoundary: false,
      retainedPermit: { status: 'none', phase: null },
    });
    engine.getF06RetainedPermit = (() => {
      throw new Error('private diagnostic detail');
    }) as any;
    expect(value.getLifecycleDiagnosticSnapshot().originals[0].movement).toEqual({
      claimedBoundary: false,
      retainedPermit: { status: 'unavailable', phase: null },
    });
    engine.getF06RetainedPermit = (() => ({ phase: 'sensitive-unknown-value' })) as any;
    engine.hasClaimedTournamentMoveBoundary = (() => 'yes') as any;
    const result = value.getLifecycleDiagnosticSnapshot();
    expect(result.originals[0].movement).toEqual(absent);
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(
      value.getLifecycleDiagnosticSnapshot({ tableIds: [id(999)] }).originals[0].movement
    ).toEqual(absent);
  });

  it('reads the retained original without calling a replacement or recovery', async () => {
    const value = manager();
    const old = {
      ...original(100),
      getF06RetainedPermit: vi.fn(() => ({ phase: 'reserved' })),
      hasClaimedTournamentMoveBoundary: vi.fn(() => true),
      replayF06OriginalPermit: vi.fn(),
    };
    value.tableEngines.set(id(100), old);
    await value.stop();
    const replacement = { ...original(999), getF06RetainedPermit: vi.fn(() => null) };
    value.tableEngines.set(id(100), replacement);
    const result = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(100)] });
    expect(result.originals[0].movement.retainedPermit).toEqual({
      status: 'retained',
      phase: 'reserved',
    });
    expect(replacement.getF06RetainedPermit).not.toHaveBeenCalled();
    expect(old.replayF06OriginalPermit).not.toHaveBeenCalled();
  });
});

describe('manager lifecycle diagnostics on the selected non-F06 base', () => {
  it.each([34, 36, 37, 45])(
    'selects exact live tables and retains bounded originals for %i engines',
    async (count) => {
      const value = manager(),
        engines = [];
      for (let i = 0; i < count; i++) {
        const engine = original(100 + i);
        engines.push(engine);
        value.tableEngines.set(id(100 + i), engine);
      }
      const first = value.getLifecycleDiagnosticSnapshot();
      expect(first.originals).toHaveLength(8);
      expect(first).toMatchObject({
        originalsCount: count,
        originalsReturned: 8,
        originalsOmitted: count - 8,
      });
      const last = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(99 + count)] });
      expect(last.originals[0].engine.instanceId).toBe(id(99 + count));
      expect(last.originals[0]).toMatchObject({
        session: null,
        sessionCoverage: 'unavailable_on_selected_base',
      });
      await value.stop();
      expect(engines.every((engine) => engine.stop.mock.calls.length === 2)).toBe(true);
      value.tableEngines.set(id(132), original(999));
      const retained = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(100), id(132)] });
      expect(retained).toMatchObject({
        originalSelection: 'retained-stop',
        originalsCount: count,
        retainedOriginalCount: 32,
      });
      expect(retained.originals[0].engine.instanceId).toBe(id(100));
      expect(retained.originals[1]).toMatchObject({ availability: 'unavailable', engine: null });
      expect(retained.selectionMissingCount).toBe(1);
    }
  );

  it('an empty stop snapshot never substitutes engines added later', async () => {
    const value = manager();
    await value.stop();
    value.tableEngines.set(id(100), original(100));
    const result = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(100)] });
    expect(result).toMatchObject({
      originalSelection: 'retained-stop',
      originalsCount: 0,
      retainedOriginalCount: 0,
    });
    expect(result.originals[0].engine).toBeNull();
  });

  it('does not call lease/authority checks during observation and retains exact pending stop', async () => {
    const value = manager();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.tableEngines.set(
      id(100),
      original(100, () => pending)
    );
    const stopping = value.stop();
    const authority = vi.spyOn(value, 'getTournamentLeaseGeneration').mockImplementation(() => {
      throw new Error('must not inspect authority');
    });
    const snapshot = value.getLifecycleDiagnosticSnapshot();
    expect(snapshot.stopPending).toBe(true);
    expect(snapshot.records.map((row: any) => row.event)).toEqual(['stop_initiated']);
    expect(authority).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(value.getLifecycleDiagnosticSnapshot().records.map((row: any) => row.event)).toEqual([
      'stop_initiated',
      'owned_work_joined',
      'stop_completed',
    ]);
  });

  it('binds the same physical promise UUID and preserves its original rejection despite diagnostic failure', async () => {
    const value = manager();
    value.lifecycleIsCurrent = vi.fn(() => true);
    let registration: any;
    vi.spyOn(tournamentEliminationScheduler, 'register').mockImplementation((input) => {
      registration = input;
      return () => {};
    });
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    value.registerEliminationScheduler(() => pending);
    const physical = registration.run(new AbortController().signal);
    const operationId = registration.diagnostics.operationIdFor(physical);
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(value.getLifecycleDiagnosticSnapshot().schedulerRecent).toEqual([{ operationId }]);
    const authorityCalls = value.lifecycleIsCurrent.mock.calls.length;
    value.getLifecycleDiagnosticSnapshot();
    expect(value.lifecycleIsCurrent.mock.calls.length).toBe(authorityCalls);
    vi.spyOn(value.managerLifecycleDiagnostics, 'record').mockImplementation(() => {
      throw new Error('diagnostic only');
    });
    const failure = new Error('actual sweep failure');
    const rejected = expect(physical).rejects.toBe(failure);
    reject(failure);
    await rejected;
    expect(value.getLifecycleDiagnosticSnapshot()).toMatchObject({
      schedulerPendingCount: 0,
      diagnosticWriteFailures: 1,
    });
    await value.stop();
  });

  it('retains richer release evidence and rejects oversized, duplicate and malformed table selection', async () => {
    const value = manager();
    const observe = value.captureLeaseReleaseDiagnosticObserver(id(1), id(2));
    observe({ status: 'confirmed', attempts: 1, releasedCount: 0 });
    expect(value.getLifecycleDiagnosticSnapshot().leaseRelease).toMatchObject({
      status: 'confirmed',
      releasedCount: 0,
    });
    expect(value.getLeaseReleaseDiagnosticSnapshot().records[0]).toMatchObject({
      event: 'lease_release_observed',
      leaseStatus: 'confirmed',
      releasedCount: 0,
    });
    for (const tableIds of [
      Array.from({ length: 9 }, (_, n) => id(n)),
      [id(1), id(1)],
      ['malformed'],
    ]) {
      expect(() => value.getLifecycleDiagnosticSnapshot({ tableIds })).toThrow();
    }
    await value.stop();
  });
});
