import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClusterController,
  CLUSTER_TICK_STALL_MS,
  CLUSTER_WAKE_DEBOUNCE_MS,
  type ClusterControllerDeps,
} from './ClusterController.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const wakeResult = { data: { ok: true, seated_total: 0, actions: [] }, error: null };
type RpcReply = { data: unknown; error: { message: string } | null };
const pass = (enabled: boolean, main: string) => ({
  data: {
    ok: true,
    games: 1,
    ticked: 1,
    errors: 0,
    rested: 0,
    rested_games: [],
    results: [
      {
        game_id: 'game',
        main1_table_id: main,
        enabled,
        result: { ok: true, seated_total: 2, actions: [] },
      },
    ],
  },
  error: null,
});

function controllerWith(rpc: ReturnType<typeof vi.fn>, extra: Partial<ClusterControllerDeps> = {}) {
  return new ClusterController({
    rpc: rpc as unknown as ClusterControllerDeps['rpc'],
    eligibleCounts: () => new Map(),
    eligibleHorseCount: () => 0,
    hasEngine: () => false,
    ensureEngine: async () => true,
    seatedCount: async () => 1,
    frozen: () => false,
    ...extra,
  });
}

afterEach(() => vi.useRealTimers());

describe('Must Move wakes retain ownership until the actual request settles', () => {
  it('coalesces changes during a slow wake into exactly one subsequent wake', async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof wakeResult>();
    const rpc = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(wakeResult);
    const controller = controllerWith(rpc);
    controller.start();
    try {
      controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      for (let i = 0; i < 25; i++) controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS * 2);
      expect(rpc).toHaveBeenCalledTimes(1);
      pending.resolve(wakeResult);
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(rpc.mock.calls.every(([name]) => name === 'fn_cash_cluster_tick')).toBe(true);
      expect(controller.wakeStats.pending).toBe(0);
    } finally {
      pending.resolve(wakeResult);
      await controller.stop();
    }
  });

  it('a slow game does not block a different game', async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof wakeResult>();
    const rpc = vi.fn((_fn, args) =>
      args.p_game_id === 'slow' ? pending.promise : Promise.resolve(wakeResult)
    );
    const controller = controllerWith(rpc);
    controller.start();
    try {
      controller.wake('slow');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      controller.wake('other');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      expect(rpc.mock.calls.map(([, args]) => args.p_game_id)).toEqual(['slow', 'other']);
    } finally {
      pending.resolve(wakeResult);
      await controller.stop();
    }
  });

  it('stop joins the admitted wake and discards its queued successor', async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof wakeResult>();
    const rpc = vi.fn().mockReturnValue(pending.promise);
    const controller = controllerWith(rpc);
    controller.start();
    controller.wake('game');
    await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
    controller.wake('game');
    const stopped = vi.fn();
    const stopping = controller.stop().then(stopped);
    try {
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS * 2);
      expect(stopped).not.toHaveBeenCalled();
      pending.resolve(wakeResult);
      await stopping;
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(controller.wakeStats.pending).toBe(0);
    } finally {
      pending.resolve(wakeResult);
      await stopping;
    }
  });

  it('a failed wake still admits the one queued successor', async () => {
    vi.useFakeTimers();
    const pending = deferred<RpcReply>();
    const rpc = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(wakeResult);
    const controller = controllerWith(rpc);
    controller.start();
    try {
      controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      controller.wake('game');
      pending.resolve({ data: null, error: { message: 'temporarily unavailable' } });
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve(wakeResult);
      await controller.stop();
    }
  });

  it('a rejected transport also releases the game for its queued successor', async () => {
    vi.useFakeTimers();
    const pending = deferred<RpcReply>();
    const rpc = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(wakeResult);
    const controller = controllerWith(rpc);
    controller.start();
    try {
      controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      controller.wake('game');
      pending.reject(new Error('connection reset'));
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(controller.wakeStats.pending).toBe(0);
    } finally {
      pending.resolve(wakeResult);
      await controller.stop();
    }
  });

  it('accepts a new wake after stop has drained and the controller restarts', async () => {
    vi.useFakeTimers();
    const pending = deferred<RpcReply>();
    const rpc = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(wakeResult);
    const controller = controllerWith(rpc);
    controller.start();
    try {
      controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      controller.wake('game');
      const stopping = controller.stop();
      controller.start();
      expect(controller.isRunning).toBe(false);
      pending.resolve(wakeResult);
      await stopping;
      controller.start();
      controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(controller.wakeStats.pending).toBe(0);
    } finally {
      pending.resolve(wakeResult);
      await controller.stop();
    }
  });
});

describe('a wake cannot reuse a Main 1 hint superseded by a full pass', () => {
  it('ignores a late wake response after a newer pass disables the game', async () => {
    vi.useFakeTimers();
    const pending = deferred<RpcReply>();
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(pass(true, 'obsolete-main'))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(pass(false, 'current-main'));
    const ensureEngine = vi.fn(async () => true);
    const hasEngine = vi.fn(() => true);
    const controller = controllerWith(rpc, { ensureEngine, hasEngine });
    await controller.tick();
    hasEngine.mockReturnValue(false);
    controller.start();
    try {
      controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      const current = await controller.tick();
      pending.resolve({ data: { ok: true, seated_total: 2, actions: [] }, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(ensureEngine).not.toHaveBeenCalled();
      expect(controller.summary).toBe(current);
    } finally {
      pending.resolve(wakeResult);
      await controller.stop();
    }
  });

  it('ignores a late wake seat count after a newer pass replaces Main 1', async () => {
    vi.useFakeTimers();
    const count = deferred<number>();
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(pass(true, 'obsolete-main'))
      .mockResolvedValueOnce({ data: { ok: true, seated_total: 2, actions: [] }, error: null })
      .mockResolvedValue(pass(true, 'current-main'));
    const ensureEngine = vi.fn(async () => true);
    const hasEngine = vi.fn(() => true);
    const seatedCount = vi.fn((table: string) =>
      table === 'obsolete-main' ? count.promise : Promise.resolve(2)
    );
    const controller = controllerWith(rpc, { ensureEngine, hasEngine, seatedCount });
    await controller.tick();
    hasEngine.mockReturnValue(false);
    controller.start();
    try {
      controller.wake('game');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS);
      expect(seatedCount).toHaveBeenCalledWith('obsolete-main');
      const current = await controller.tick();
      count.resolve(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(ensureEngine).toHaveBeenCalledTimes(1);
      expect(ensureEngine).toHaveBeenCalledWith('current-main');
      expect(controller.summary).toBe(current);
    } finally {
      count.resolve(2);
      await controller.stop();
    }
  });
});

describe('a replacement controller pass owns its hints and dealer wakes', () => {
  it('ignores an older RPC response after a replacement pass has completed', async () => {
    vi.useFakeTimers();
    const older = deferred<ReturnType<typeof pass>>();
    const rpc = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValue(pass(false, 'current-main'));
    const ensureEngine = vi.fn(async () => true);
    const controller = controllerWith(rpc, { ensureEngine });
    const obsolete = controller.tick();
    try {
      vi.setSystemTime(Date.now() + CLUSTER_TICK_STALL_MS + 1);
      const current = await controller.tick();
      older.resolve(pass(true, 'obsolete-main'));
      await obsolete;
      expect(ensureEngine).not.toHaveBeenCalled();
      expect(controller.summary).toBe(current);
    } finally {
      older.resolve(pass(true, 'obsolete-main'));
      await obsolete;
      await controller.stop();
    }
  });

  it('rechecks pass ownership after a seat count returns', async () => {
    vi.useFakeTimers();
    const count = deferred<number>();
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(pass(true, 'obsolete-main'))
      .mockResolvedValue(pass(false, 'current-main'));
    const ensureEngine = vi.fn(async () => true);
    const seatedCount = vi.fn(() => count.promise);
    const controller = controllerWith(rpc, { ensureEngine, seatedCount });
    const obsolete = controller.tick();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(seatedCount).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + CLUSTER_TICK_STALL_MS + 1);
      const current = await controller.tick();
      count.resolve(2);
      await obsolete;
      expect(ensureEngine).not.toHaveBeenCalled();
      expect(controller.summary).toBe(current);
    } finally {
      count.resolve(2);
      await obsolete;
      await controller.stop();
    }
  });
});
