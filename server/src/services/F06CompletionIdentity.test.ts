import { it, expect, vi } from 'vitest';
import {
  F06EngineWriterCapture,
  captureCurrentEngineWriterOrigin,
} from './F06EngineWriterCapture.js';
it('returns the exact canonical promise synchronously while observing a raw rejection', async () => {
  const tracker = new F06EngineWriterCapture();
  let reject!: (e: unknown) => void;
  const canonical = new Promise<void>((r, j) => {
    reject = j;
  });
  const dispatch = vi.fn(() => canonical);
  const returned = tracker.runDispatch('original', dispatch);
  expect(returned).toBe(canonical);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(tracker.observe().writers[0].state).toBe('pending');
  tracker.fence();
  const drain = tracker.join(() => {});
  reject(new Error('canonical failure'));
  await expect(returned).rejects.toThrow('canonical failure');
  expect((await drain).state).toBe('unknown');
});
it('synchronous dispatch failure is retained and returned as the original failure outcome', async () => {
  const tracker = new F06EngineWriterCapture();
  await expect(
    tracker.runDispatch('original', () => {
      throw new Error('synchronous');
    })
  ).rejects.toThrow('synchronous');
  tracker.fence();
  expect((await tracker.join(() => {})).state).toBe('unknown');
});
it('refuses a registry join from its own accepted ancestor without deadlocking', async () => {
  const tracker = new F06EngineWriterCapture();
  const work = tracker.captureAccepted('dispatch', 'ancestor', async () => {
    tracker.fence();
    await expect(tracker.join(() => {})).rejects.toThrow('f06_engine_writer_ancestor_join');
  });
  await work;
  expect((await tracker.join(() => {})).writers).toEqual([]);
});
it('retains unknown attempts while bounding successful history with nested capture context', async () => {
  const tracker = new F06EngineWriterCapture();
  await expect(
    tracker.captureAccepted('table-metadata', 'original-unknown', () =>
      Promise.reject(new Error('lost'))
    )
  ).rejects.toThrow('lost');
  for (let i = 0; i < 2000; i++)
    await tracker.captureAccepted('dispatch', 'accepted', async () => {
      await tracker.captureAccepted('table-metadata', 'child', async () => undefined);
    });
  tracker.fence();
  const result = await tracker.join(() => {});
  expect(result.returned).toBe(4000);
  expect(result.writers).toMatchObject([{ state: 'unknown', operationId: 'original-unknown' }]);
  expect(result.writers).toHaveLength(1);
});
it('closes future launches only after accepted descendants finish', async () => {
  const tracker = new F06EngineWriterCapture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child = vi.fn(async () => undefined);
  const parent = tracker.captureAccepted('dispatch', 'accepted-parent', async () => {
    await gate;
    await tracker.captureAccepted('table-metadata', 'accepted-child', child);
  });
  let closed = false;
  const close = tracker
    .closeCoveredWriters(() => {})
    .then((v) => {
      closed = true;
      return v;
    });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await parent;
  await close;
  expect(child).toHaveBeenCalledTimes(1);
  const late = vi.fn(async () => undefined);
  await expect(tracker.captureAccepted('table-metadata', 'late', late)).rejects.toThrow(
    'f06_engine_writer_closed'
  );
  expect(late).not.toHaveBeenCalled();
  expect(tracker.observe().coverage).toBe('incomplete');
});
it('rejoins work registered across the join return before closing', async () => {
  const tracker = new F06EngineWriterCapture();
  let release!: () => void;
  let done = false;
  const close = tracker
    .closeCoveredWriters(() => {})
    .then(() => {
      done = true;
    });
  const concurrent = tracker.captureAccepted(
    'table-metadata',
    'boundary',
    () =>
      new Promise<void>((r) => {
        release = r;
      })
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await concurrent;
  await close;
  expect(done).toBe(true);
});

it('retains the exact accepted parent ordinal across nested raw attempts', async () => {
  const tracker = new F06EngineWriterCapture();
  const seen: number[] = [];
  expect(tracker.currentAcceptedAttempt()).toBe(null);
  await tracker.run('maintenance', async () => {
    const parent = tracker.currentAcceptedAttempt();
    expect(parent).not.toBe(null);
    for (let retry = 0; retry < 2; retry++) {
      expect(tracker.currentAcceptedAttempt()).toBe(parent);
      await tracker.captureAccepted('retirement-control', 'same-original-request', async () => {
        const child = tracker.currentAcceptedAttempt();
        expect(child).not.toBe(parent);
        seen.push(child!);
      });
    }
    expect(tracker.currentAcceptedAttempt()).toBe(parent);
  });
  expect(new Set(seen).size).toBe(2);
  expect(tracker.currentAcceptedAttempt()).toBe(null);
  expect(tracker.observe().writers).toHaveLength(0);
});

it('a detached callback cannot borrow a parent that has already returned', async () => {
  const tracker = new F06EngineWriterCapture();
  let later!: Promise<boolean>;
  await tracker.run('maintenance', async () => {
    expect(tracker.isAcceptedContext()).toBe(true);
    later = new Promise((resolve) => setImmediate(() => resolve(tracker.isAcceptedContext())));
  });
  expect(await later).toBe(false);
});

it('raw Session origin must be the actual accepted engine object, never its clone', async () => {
  const tracker = new F06EngineWriterCapture();
  const other = new F06EngineWriterCapture();
  let origin: Readonly<{ attempt: number }> | null = null;
  expect(captureCurrentEngineWriterOrigin()).toBe(null);
  await tracker.run('allocator', async () => {
    origin = captureCurrentEngineWriterOrigin();
    expect(origin).not.toBe(null);
  });
  expect(tracker.ownsAcceptedOrigin(origin, origin!.attempt)).toBe(true);
  expect(tracker.ownsAcceptedOrigin({ attempt: origin!.attempt }, origin!.attempt)).toBe(false);
  expect(other.ownsAcceptedOrigin(origin, origin!.attempt)).toBe(false);
  expect(tracker.ownsAcceptedOrigin(origin, origin!.attempt + 1)).toBe(false);
  expect(captureCurrentEngineWriterOrigin()).toBe(null);
});
