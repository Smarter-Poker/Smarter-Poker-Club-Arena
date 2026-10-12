/**
 * AN ACTION WHOSE ANSWER WAS LOST IS CHECKED BEFORE THE BAR COMES BACK
 * (2026-10-05).
 *
 * submitAction ends with ACTION_NOT_DELIVERED when no send was answered,
 * which includes a first send the engine executed whose response was lost.
 * The page used to hand the action bar straight back, showing a landed
 * action as undone. It now asks the engine for its state once (the existing
 * RESYNC path) and waits, bounded, for that snapshot before the revert,
 * which hands nothing back once the engine's decision has moved on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ACTION_OUTCOME_STATE_BUDGET_MS, awaitEngineState } from '../src/lib/awaitEngineState';

const TABLE_PAGE = readFileSync(resolve(__dirname, '..', 'src/pages/TablePage.tsx'), 'utf8');

describe('awaitEngineState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks once and is released by the next snapshot', async () => {
    const waiters = new Set<() => void>();
    const request = vi.fn();
    let done = false;
    void awaitEngineState(waiters, request).then(() => (done = true));
    expect(request).toHaveBeenCalledTimes(1);
    expect(waiters.size).toBe(1);
    await Promise.resolve();
    expect(done).toBe(false);
    for (const release of [...waiters]) release();
    await Promise.resolve();
    expect(done).toBe(true);
    expect(waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never waits past its budget when no snapshot comes', async () => {
    const waiters = new Set<() => void>();
    let done = false;
    void awaitEngineState(waiters, () => {}).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(ACTION_OUTCOME_STATE_BUDGET_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(waiters.size).toBe(0);
  });

  it('a request that throws does not hold the bar', async () => {
    const waiters = new Set<() => void>();
    await awaitEngineState(waiters, () => {
      throw new Error('no socket');
    });
    expect(waiters.size).toBe(0);
  });
});

describe('TablePage wiring', () => {
  it('waits for engine state on ACTION_NOT_DELIVERED before it reports and reverts', () => {
    const i = TABLE_PAGE.indexOf('const submitActionWithToast = useCallback(');
    expect(i).toBeGreaterThan(-1);
    const fn = TABLE_PAGE.slice(i, TABLE_PAGE.indexOf('\n  );', i));
    const wait = fn.indexOf(
      'await awaitEngineState(snapshotWaitersRef.current, requestEngineSnapshot)'
    );
    expect(wait).toBeGreaterThan(fn.indexOf("res.code === 'ACTION_NOT_DELIVERED'"));
    expect(wait).toBeLessThan(fn.indexOf('showActionError({'));
    expect(wait).toBeLessThan(fn.indexOf('return false;'));
  });

  it('the snapshot releases the wait after the merge effect is queued', () => {
    const merge = TABLE_PAGE.indexOf('}, [engineSnapshot, USE_ENGINE_WS, userId]);');
    const release = TABLE_PAGE.indexOf('const snapshotWaitersRef = useRef<Set<() => void>>');
    expect(merge).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(merge);
  });
});
