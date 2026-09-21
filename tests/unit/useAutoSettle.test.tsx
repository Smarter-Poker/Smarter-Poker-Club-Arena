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
});

function Harness({
  settle,
  pending,
}: {
  settle: () => Promise<boolean>;
  pending: boolean;
}) {
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
