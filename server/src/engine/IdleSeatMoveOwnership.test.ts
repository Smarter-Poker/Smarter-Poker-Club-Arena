import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

function setup() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.seatBoundaryTail = Promise.resolve();
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.setLoopPhase = vi.fn();
  let resolve!: (ids: string[]) => void;
  let reject!: (error: Error) => void;
  const raw = new Promise<string[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  engine.executePendingSeatMoves = vi.fn(() => raw);
  return { engine, resolve, reject };
}
afterEach(() => vi.restoreAllMocks());

describe('idle move owns the seat boundary through its actual transaction', () => {
  it('an elapsed budget cannot release a queued departure before the move finishes', async () => {
    const h = setup();
    const timeout = new Error('deal_step_timeout: idle_seat_moves');
    h.engine.withStepBudget = vi.fn(() => Promise.reject(timeout));
    const failed = vi.fn();
    const moving = h.engine.executeIdleSeatMoves().catch(failed);
    await Promise.resolve();
    await Promise.resolve();
    const acquired = vi.fn();
    const queued = h.engine.acquireSeatBoundary().then((release: () => void) => {
      acquired();
      release();
    });
    await Promise.resolve();
    expect(acquired).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    h.resolve(['original']);
    await Promise.all([moving, queued]);
    expect(failed).toHaveBeenCalledWith(timeout);
    expect(acquired).toHaveBeenCalledOnce();
    expect(h.engine.executePendingSeatMoves).toHaveBeenCalledOnce();
  });

  it('releases ownership after a failed transaction and preserves its failure', async () => {
    const h = setup();
    h.engine.withStepBudget = vi.fn((_phase, _ms, raw) => raw);
    const error = new Error('database rejected move');
    const moving = h.engine.executeIdleSeatMoves();
    await Promise.resolve();
    h.reject(error);
    await expect(moving).rejects.toBe(error);
    const release = await h.engine.acquireSeatBoundary();
    release();
  });

  it('does not start a queued operation after losing engine authority', async () => {
    const h = setup();
    const release = await h.engine.acquireSeatBoundary();
    const moving = h.engine.executeIdleSeatMoves();
    h.engine.lifecycleCanMutate.mockReturnValue(false);
    release();
    await expect(moving).resolves.toEqual([]);
    expect(h.engine.executePendingSeatMoves).not.toHaveBeenCalled();
  });

  it('returns the actual completed move result', async () => {
    const h = setup();
    h.engine.withStepBudget = vi.fn((_phase, _ms, raw) => raw);
    const moving = h.engine.executeIdleSeatMoves();
    h.resolve(['original']);
    await expect(moving).resolves.toEqual(['original']);
  });
});
