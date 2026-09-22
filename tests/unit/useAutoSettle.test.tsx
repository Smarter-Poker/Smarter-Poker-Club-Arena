/**
 * useAutoSettle: a saved wager settles itself.
 *
 * The page never asks the player to check a round. While `pending` holds, the
 * hook calls `settle` immediately, then again after each failure the page
 * reports through `attempts` (1s, 2s, 4s, ... capped at 8s), and a turn the
 * page skipped because it was busy is retried shortly rather than counted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { settleDelay, useAutoSettle } from '../../src/hooks/useAutoSettle';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The tab's visibility, as the hook reads it. */
let hidden = false;
const setHidden = (value: boolean) =>
  act(async () => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  });
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function Harness({ settle, pending }: { settle: () => Promise<boolean>; pending: boolean }) {
  const [attempts, setAttempts] = useState(0);
  useAutoSettle(pending, attempts, async () => {
    const ran = await settle();
    // The page bumps attempts when a replay ran and was not an answer.
    if (ran) setAttempts((count) => count + 1);
    return ran;
  });
  return <span data-attempts={attempts} />;
}

describe('settleDelay', () => {
  it('is immediate first, then doubles from one second and caps at eight', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(settleDelay)).toEqual([0, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe('useAutoSettle', () => {
  it('replays immediately, then on the backoff schedule, until pending clears', async () => {
    vi.useFakeTimers();
    const settle = vi.fn(async () => true);
    const view = render(<Harness settle={settle} pending />);
    expect(settle).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(settle).toHaveBeenCalledTimes(1);
    // Failure one: the next try waits one second.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(settle).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(settle).toHaveBeenCalledTimes(2);
    // Failure two: two seconds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(settle).toHaveBeenCalledTimes(3);
    // Settled: nothing more fires, however long we wait.
    view.rerender(<Harness settle={settle} pending={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(settle).toHaveBeenCalledTimes(3);
  });

  it('retries a turn the page skipped without counting it as a failure', async () => {
    vi.useFakeTimers();
    let busy = true;
    const settle = vi.fn(async () => !busy);
    render(<Harness settle={settle} pending />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(settle).toHaveBeenCalledTimes(1);
    // Skipped: back in 400ms, not on the failure schedule.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(settle).toHaveBeenCalledTimes(2);
    busy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(settle).toHaveBeenCalledTimes(3);
    // That one ran and failed, so the first failure wait applies: one second.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(settle).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(settle).toHaveBeenCalledTimes(4);
  });

  it('replays nothing from a background tab, and finishes the held wait when it is visible', async () => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const settle = vi.fn(async () => true);
    render(<Harness settle={settle} pending />);
    await tick(0);
    expect(settle).toHaveBeenCalledTimes(1);
    // The next try is due in one second; the tab goes to the background first.
    await tick(500);
    await setHidden(true);
    await tick(60_000);
    expect(settle).toHaveBeenCalledTimes(1);
    // Back in front: that wait fell due long ago, so it finishes at once...
    await setHidden(false);
    await tick(0);
    expect(settle).toHaveBeenCalledTimes(2);
    // ...and the schedule carries on from there: two seconds.
    await tick(1999);
    expect(settle).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(settle).toHaveBeenCalledTimes(3);
  });

  it('cannot skip the backoff by switching tabs', async () => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const settle = vi.fn(async () => true);
    render(<Harness settle={settle} pending />);
    await tick(0);
    expect(settle).toHaveBeenCalledTimes(1);
    // A quick hide and show keeps the wait that was running, one second from
    // the failure, rather than firing early or starting it over.
    await tick(200);
    await setHidden(true);
    await tick(100);
    await setHidden(false);
    await tick(699);
    expect(settle).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('waits for a tab that is hidden when the wager is saved', async () => {
    vi.useFakeTimers();
    hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const settle = vi.fn(async () => true);
    render(<Harness settle={settle} pending />);
    await tick(30_000);
    expect(settle).not.toHaveBeenCalled();
    await setHidden(false);
    await tick(0);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('fires each wait once, however often the tab is hidden and shown during the replay', async () => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    // A replay whose answer has not come back yet.
    const settle = vi.fn(() => new Promise<boolean>(() => {}));
    render(<Harness settle={settle} pending />);
    await tick(0);
    expect(settle).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      await setHidden(true);
      await setHidden(false);
      await tick(10_000);
    }
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('stops when the page unmounts', async () => {
    vi.useFakeTimers();
    const settle = vi.fn(async () => true);
    const view = render(<Harness settle={settle} pending />);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(settle).not.toHaveBeenCalled();
  });
});
