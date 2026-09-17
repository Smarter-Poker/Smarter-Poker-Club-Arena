import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MaintenanceBreak,
  type MaintenanceBreakStore,
  type PersistedMaintenanceBreak,
} from './MaintenanceBreak.js';
import {
  MAINTENANCE_THAW_STEPS,
  runMaintenanceThawV3,
  type MaintenanceThawRpcArgs,
} from './maintenanceThawV3.js';
import { setMaintenanceFrozen } from './freezeState.js';

const owners: MaintenanceBreak[] = [];
const epoch = Date.parse('2026-09-11T10:10:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  setMaintenanceFrozen(false);
  vi.useRealTimers();
});
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function harness() {
  let row: PersistedMaintenanceBreak | null = null;
  let boundary: number | null = null;
  let dbNow = epoch;
  const engine = {
    paused: false,
    independentPause: true,
    resumes: 0,
    pauseForMaintenance() {
      this.paused = true;
    },
    resumeFromMaintenance() {
      this.paused = false;
      this.resumes++;
    },
    isParkedBetweenHands: () => true,
    isBetweenHands: () => true,
    isRunning: () => true,
  };
  const store: MaintenanceBreakStore = {
    load: vi.fn(async () => row && { ...row }),
    loadReleaseBoundary: vi.fn(async () =>
      boundary !== null && dbNow < boundary ? boundary : null
    ),
    save: async (next) => {
      if (row && row.ownershipToken !== next.ownershipToken) throw new Error('owner');
      row = { ...next };
    },
    claim: async (expected, replacement) => {
      if (!row || row.ownershipToken !== expected) return null;
      row = { ...row, ownershipToken: replacement };
      return { ...row };
    },
    clear: vi.fn(async () => {
      throw new Error('v3 must own deletion');
    }),
  };
  function receipt(args: Readonly<MaintenanceThawRpcArgs>, at = Date.now()) {
    return {
      ok: true,
      complete: true,
      released: true,
      abandoned: false,
      retryable: false,
      reason: 'thaw_complete_release_scheduled',
      freeze_started_at: args.p_freeze_started,
      ownership_token: args.p_ownership_token,
      credited_through_at: new Date(at).toISOString(),
      effective_frozen_seconds: (at - Date.parse(args.p_freeze_started)) / 1000,
      shifted: { complete: true, ...Object.fromEntries(MAINTENANCE_THAW_STEPS.map((s) => [s, 0])) },
    };
  }
  const rpc = vi.fn(async (args: Readonly<MaintenanceThawRpcArgs>): Promise<unknown> => {
    row = null;
    return receipt(args);
  });
  const contract = vi.fn(async () => {});
  const emit = vi.fn();
  const emitPresentation = vi.fn();
  const owner = new MaintenanceBreak({
    store,
    assertRecoveryWindowContract: contract,
    engines: () => new Map([['table', engine]]),
    isRunning: () => true,
    emit,
    emitPresentation,
    thaw: (request, signal) => runMaintenanceThawV3(request, rpc, { signal }),
  });
  owners.push(owner);
  return {
    owner,
    contract,
    emit,
    emitPresentation,
    engine,
    store,
    rpc,
    receipt,
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    set boundary(value: number | null) {
      boundary = value;
    },
    set dbNow(value: number) {
      dbNow = value;
    },
  };
}
async function ready(h: ReturnType<typeof harness>) {
  await h.owner.announceLastHand();
  vi.setSystemTime(Date.now() + 120_000);
  await h.owner.beginCountdown();
  vi.setSystemTime(Date.now() + 300_000);
}
describe('real maintenance owner consumes the current v3 contract', () => {
  it('holds through a future receipt and a fast host clock until the database releases', async () => {
    const h = harness();
    await ready(h);
    expect(h.owner.presentation()).toMatchObject({ active: true, phase: 'finalizing' });
    const end = Date.now() + 2_000;
    h.boundary = end;
    h.rpc.mockImplementation(async (args) => {
      h.row = null;
      return h.receipt(args, end);
    });
    const ending = h.owner.end();
    await flush();
    expect(h.engine.paused).toBe(true);
    expect(h.owner.presentation()).toMatchObject({
      active: true,
      phase: 'counting_down',
      break_ends_at: end,
    });
    expect(h.emit).toHaveBeenCalledWith(
      'table',
      expect.objectContaining({ type: 'maintenance_break', break_ends_at: end })
    );
    vi.setSystemTime(end + 10_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.engine.resumes).toBe(0);
    expect(h.owner.isActive()).toBe(true);
    expect(h.owner.presentation()).toMatchObject({
      active: true,
      phase: 'finalizing',
      break_ends_at: null,
    });
    h.dbNow = end;
    await vi.advanceTimersByTimeAsync(250);
    await ending;
    expect(h.engine.resumes).toBe(1);
    expect(h.emitPresentation).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false, phase: 'idle' })
    );
    h.emit.mockClear();
    h.owner.replay('table');
    expect(h.emit).toHaveBeenCalledWith(
      'table',
      expect.objectContaining({ type: 'maintenance_break_ended' })
    );
    expect(h.engine.independentPause).toBe(true);
    expect(h.store.clear).not.toHaveBeenCalled();
  });
  it('recovers a lost committed response with the identical five arguments', async () => {
    const h = harness();
    await ready(h);
    let saved: unknown;
    let calls = 0;
    h.rpc.mockImplementation(async (args) => {
      if (++calls === 1) {
        h.row = null;
        saved = h.receipt(args);
        throw new Error('response lost');
      }
      return { ...(saved as object), reason: 'release_receipt_recovered' };
    });
    const ending = h.owner.end();
    await flush();
    expect(h.engine.resumes).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    await ending;
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[1][0]).toEqual(h.rpc.mock.calls[0][0]);
    expect(h.engine.resumes).toBe(1);
    expect(h.store.clear).not.toHaveBeenCalled();
  });
  it('does not wake after shutdown during an in-flight RPC', async () => {
    const h = harness();
    await ready(h);
    const wait = deferred();
    h.rpc.mockImplementation(async (args) => {
      await wait.promise;
      return h.receipt(args);
    });
    const ending = h.owner.end();
    await flush();
    const stopping = h.owner.stop();
    wait.resolve();
    await Promise.all([ending, stopping]);
    expect(h.engine.resumes).toBe(0);
    expect(h.store.clear).not.toHaveBeenCalled();
  });
  it('cancels a transport retry delay without waking tables', async () => {
    const h = harness();
    await ready(h);
    h.rpc.mockRejectedValue(new Error('transport'));
    const ending = h.owner.end();
    await flush();
    await h.owner.stop();
    await ending;
    expect(h.engine.resumes).toBe(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('cancels a release wait without waking tables', async () => {
    const h = harness();
    await ready(h);
    h.rpc.mockImplementation(async (args) => h.receipt(args, Date.now() + 5_000));
    const ending = h.owner.end();
    await flush();
    await h.owner.stop();
    await ending;
    expect(h.engine.resumes).toBe(0);
  });
  it('holds a row-deleted boot on the release witness without fabricating ownership', async () => {
    const h = harness();
    h.boundary = epoch + 2_000;
    await h.owner.start();
    expect(h.engine.paused).toBe(true);
    expect(h.row).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
    h.dbNow = epoch + 2_000;
    await vi.advanceTimersByTimeAsync(2_001);
    expect(h.engine.resumes).toBe(1);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.store.clear).not.toHaveBeenCalled();
  });
  it('retains unknown recovery state and resumes after a successful empty read', async () => {
    const h = harness();
    let unreadable = true;
    vi.mocked(h.store.load).mockImplementation(async () => {
      if (unreadable) throw new Error('unreadable');
      return null;
    });
    const starting = h.owner.start();
    await vi.advanceTimersByTimeAsync(
      MaintenanceBreak.RESTORE_ATTEMPTS * MaintenanceBreak.RESTORE_RETRY_MS
    );
    await starting;
    expect(h.engine.paused).toBe(true);
    expect(h.engine.resumes).toBe(0);
    unreadable = false;
    await vi.advanceTimersByTimeAsync(MaintenanceBreak.THAW_RETRY_MS + 1);
    expect(h.engine.resumes).toBe(1);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each(['owner', 'receipt', 'step', 'legacy'] as const)(
    'keeps the durable row on %s refusal',
    async (kind) => {
      const h = harness();
      await ready(h);
      const row = h.row;
      h.rpc.mockImplementation(async (args) => {
        const result = h.receipt(args);
        if (kind === 'owner') result.ownership_token = 'different-owner';
        if (kind === 'receipt') result.credited_through_at = 'invalid';
        if (kind === 'step') delete (result.shifted as Record<string, unknown>).sit_out_at;
        if (kind === 'legacy') return { ok: false, reason: 'legacy_partial_checkpoint' };
        return result;
      });
      await h.owner.end();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(h.engine.resumes).toBe(0);
      expect(h.row).toEqual(row);
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(h.store.clear).not.toHaveBeenCalled();
    }
  );
  it.each(['counting_down', 'last_hand'] as const)(
    'recovers an expired %s owner beyond 900 seconds',
    async (phase) => {
      const h = harness();
      const freeze = epoch - 1_200_000;
      h.row = {
        phase,
        announcedAt: freeze - 120_000,
        breakStartedAt: phase === 'last_hand' ? null : freeze,
        breakEndsAt: phase === 'last_hand' ? null : freeze + 300_000,
        reason: 'Scheduled Engine Maintenance',
        ownershipToken: 'retired',
      };
      await h.owner.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.rpc).toHaveBeenCalledTimes(1);
      const args = h.rpc.mock.calls[0][0];
      expect(Date.parse(args.p_freeze_started)).toBe(freeze);
      expect(args.p_frozen_seconds).toBeGreaterThanOrEqual(1_200);
      expect(args.p_ownership_token).not.toBe('retired');
      expect(h.row).toBeNull();
      expect(h.engine.resumes).toBe(1);
    }
  );
});

describe('one explicit recovery request uses the durable maintenance owner', () => {
  it('announces immediately outside the hourly window, preserves the full lead and never slides on replay', async () => {
    const h = harness();
    await h.owner.start();
    const requestAt = Date.now();
    expect(await h.owner.requestRecoveryWindow(requestAt)).toEqual({
      status: 'accepted',
      announcedAt: requestAt,
      endsAt: requestAt + 420_000,
    });
    expect(h.row).toMatchObject({
      phase: 'last_hand',
      announcedAt: requestAt,
      reason: 'Deployment Recovery',
    });
    expect(h.engine.paused).toBe(true);
    expect(h.owner.readyForRestart()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.owner.snapshot()).toMatchObject({
      phase: 'counting_down',
      durableConfirmed: true,
      remainingMs: 300_000,
    });
    expect(h.owner.readyForRestart()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await h.owner.requestRecoveryWindow(requestAt)).toEqual({
      status: 'active',
      announcedAt: requestAt,
      endsAt: requestAt + 420_000,
    });
    expect(h.contract).toHaveBeenCalledTimes(1);
    expect(h.owner.remainingMs()).toBe(290_000);
  });

  it('recovers a committed announcement with a lost response under the same identity', async () => {
    const h = harness();
    await h.owner.start();
    const save = h.store.save;
    vi.spyOn(h.store, 'save').mockImplementationOnce(async (row) => {
      await save(row);
      throw new Error('socket hang up');
    });
    const at = Date.now();
    expect((await h.owner.requestRecoveryWindow(at)).status).toBe('accepted');
    expect(h.row?.announcedAt).toBe(at);
    expect(h.owner.endsAt()).toBe(at + 420_000);
    expect(h.store.save).toHaveBeenCalledOnce();
  });

  it('finishes the ordinary thaw and refuses an expired replay without pausing again', async () => {
    const h = harness();
    await h.owner.start();
    const at = Date.now();
    await h.owner.requestRecoveryWindow(at);
    await vi.advanceTimersByTimeAsync(425_000);
    expect(h.owner.isActive()).toBe(false);
    expect(h.row).toBeNull();
    expect(h.engine.paused).toBe(false);
    expect(h.engine.independentPause).toBe(true);
    expect((await h.owner.requestRecoveryWindow(at)).status).toBe('expired');
    expect(h.engine.resumes).toBe(1);
  });

  it('withholds restart authority from an unparked hand during the recovery window', async () => {
    const h = harness();
    h.engine.isParkedBetweenHands = () => false;
    h.engine.isBetweenHands = () => false;
    await h.owner.start();
    await h.owner.requestRecoveryWindow(Date.now());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.owner.snapshot()).toMatchObject({ phase: 'counting_down', unparkedTables: 1 });
    expect(h.owner.readyForRestart()).toBe(false);
  });

  it('refuses a competing request without extending or replacing the current break', async () => {
    const h = harness();
    await h.owner.start();
    const at = Date.now();
    await h.owner.requestRecoveryWindow(at);
    vi.setSystemTime(at + 1_000);
    expect((await h.owner.requestRecoveryWindow(at + 1_000)).status).toBe('busy');
    expect(h.row?.announcedAt).toBe(at);
    expect(h.owner.endsAt()).toBe(at + 420_000);
  });

  it('refuses expired and future timestamps without opening a break', async () => {
    const h = harness();
    await h.owner.start();
    for (const at of [Date.now() - 120_000, Date.now() + 1, 0, NaN]) {
      expect((await h.owner.requestRecoveryWindow(at)).status).toBe('expired');
    }
    expect(h.row).toBeNull();
    expect(h.contract).not.toHaveBeenCalled();
  });

  it('uses the ordinary hour when a recovery pause would overlap its announcement', async () => {
    vi.setSystemTime(Date.parse('2026-09-17T10:48:00Z'));
    const h = harness();
    await h.owner.start();
    expect((await h.owner.requestRecoveryWindow(Date.now())).status).toBe('use_hourly');
    expect(h.row).toBeNull();
  });

  it('cannot pause before the database recovery contract is installed', async () => {
    const h = harness();
    await h.owner.start();
    h.contract.mockRejectedValueOnce(new Error('database contract unavailable'));
    await expect(h.owner.requestRecoveryWindow(Date.now())).rejects.toThrow(
      'database contract unavailable'
    );
    expect(h.row).toBeNull();
    expect(h.engine.paused).toBe(false);
  });

  it('rechecks a stopped lifecycle after the database response', async () => {
    const h = harness();
    await h.owner.start();
    const pending = deferred();
    h.contract.mockImplementationOnce(() => pending.promise);
    const attempt = h.owner.requestRecoveryWindow(Date.now());
    await flush();
    await h.owner.stop();
    pending.resolve();
    expect((await attempt).status).toBe('unavailable');
    expect(h.row).toBeNull();
  });

  it('adopts the exact recovery window across process replacement', async () => {
    const first = harness();
    await first.owner.start();
    const at = Date.now();
    await first.owner.requestRecoveryWindow(at);
    const saved = { ...first.row! };
    await first.owner.stop();
    vi.setSystemTime(at + 30_000);
    const second = harness();
    second.row = saved;
    await second.owner.start();
    expect(second.owner.endsAt()).toBe(at + 420_000);
    expect((await second.owner.requestRecoveryWindow(at)).status).toBe('active');
    expect(second.contract).not.toHaveBeenCalled();
    expect(second.row?.ownershipToken).not.toBe(saved.ownershipToken);
  });
});
