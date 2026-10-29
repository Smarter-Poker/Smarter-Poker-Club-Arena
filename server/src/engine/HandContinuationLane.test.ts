import { describe, expect, it, vi } from 'vitest';
import { HandContinuationLane, type HandContinuationBatch } from './HandContinuationLane.js';
import type { HandEvent } from '../types.js';

const action: HandEvent = { type: 'TURN_CHANGE', seat: 1, availableActions: ['fold', 'call'] };
function setup(persist: (b: Readonly<HandContinuationBatch>) => Promise<void> = async () => {}) {
  let state = 'before',
    current = true;
  const dispatch = vi.fn(async () => {}),
    report = vi.fn();
  const lane = new HandContinuationLane(
    0,
    () => state,
    () => ({ chips: 100 }),
    persist,
    dispatch,
    () => current,
    report
  );
  return {
    lane,
    dispatch,
    report,
    change: (s: string) => {
      state = s;
    },
    fence: () => {
      current = false;
    },
  };
}

describe('the hand continuation retains before publishing', () => {
  it('acknowledges durable bytes without waiting for the next turn animation', async () => {
    let releaseDispatch!: () => void;
    let retained = false;
    const lane = new HandContinuationLane(
      0,
      () => 'state',
      () => ({}),
      async () => {
        retained = true;
      },
      () =>
        new Promise<void>((r) => {
          releaseDispatch = r;
        }),
      () => true,
      () => {}
    );
    lane.enqueue(action);
    await lane.awaitRetention();
    expect(retained).toBe(true);
    expect(lane.isUnretained()).toBe(false);
    releaseDispatch();
    await lane.join();
  });
  it('refuses a close before the scheduled write instead of acknowledging a dropped batch', async () => {
    const h = setup();
    h.lane.enqueue(action);
    h.lane.close();
    await expect(h.lane.join()).rejects.toThrow('Fenced');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.report).toHaveBeenCalledOnce();
  });
  it('preserves the original write failure when its reporting sink also throws', async () => {
    const original = new Error('write outcome unknown');
    const lane = new HandContinuationLane(
      0,
      () => 'state',
      () => ({}),
      async () => {
        throw original;
      },
      async () => {},
      () => true,
      () => {
        throw new Error('report unavailable');
      }
    );
    lane.enqueue(action);
    await expect(lane.join()).rejects.toBe(original);
  });
  it('writes one stable immutable batch before dispatching any of its events', async () => {
    let finish!: () => void;
    const writes: Readonly<HandContinuationBatch>[] = [];
    const h = setup(async (b) => {
      writes.push(b);
      await new Promise<void>((r) => {
        finish = r;
      });
    });
    h.lane.enqueue(action);
    h.change('after');
    h.lane.enqueue(action);
    const joined = h.lane.join();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(writes[0].controller).toBe('after');
    expect(h.dispatch).not.toHaveBeenCalled();
    finish();
    await joined;
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it('never publishes or acknowledges a refused or unknown durable outcome', async () => {
    const error = new Error('unknown acknowledgement');
    const h = setup(async () => {
      throw error;
    });
    h.lane.enqueue(action);
    await expect(h.lane.join()).rejects.toBe(error);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.report).toHaveBeenCalledOnce();
    expect(() => h.lane.enqueue(action)).toThrow('Fenced');
  });
  it('does not publish when ownership changed while the write was pending', async () => {
    let finish!: () => void;
    const h = setup(
      async () =>
        new Promise<void>((r) => {
          finish = r;
        })
    );
    h.lane.enqueue(action);
    const joined = h.lane.join();
    await Promise.resolve();
    h.fence();
    finish();
    await expect(joined).rejects.toThrow('Fenced');
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('serializes consecutive mutation batches and captures prior engine metadata after dispatch', async () => {
    const writes: Readonly<HandContinuationBatch>[] = [];
    const h = setup(async (b) => {
      writes.push(b);
    });
    h.lane.enqueue(action);
    h.change('first');
    await h.lane.join();
    h.lane.enqueue(action);
    h.change('second');
    await h.lane.join();
    expect(writes.map((b) => [b.sequence, b.controller])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });
});

it('holds a failed original replay and never persists its queued successor batch', async () => {
  const error = new Error('Original consumer outcome unknown');
  const persist = vi.fn(),
    dispatch = vi.fn(),
    report = vi.fn();
  const lane = new HandContinuationLane(
    3,
    () => 'state',
    () => ({}),
    persist,
    dispatch,
    () => true,
    report,
    async () => {
      throw error;
    }
  );
  lane.enqueue(action);
  await expect(lane.join()).rejects.toBe(error);
  expect(lane.isReplayingOriginal()).toBe(true);
  expect(persist).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(error);
});
