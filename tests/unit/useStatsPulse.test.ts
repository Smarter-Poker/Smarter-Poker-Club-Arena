/**
 * useStatsPulse - the stats page's heartbeat (Stats Page Programme phase 3).
 *
 * Every pin here is a behaviour a player would notice if it went missing:
 * a hand from another tab that never shows, a hidden tab that keeps the
 * database busy, a tab return that fetches twice, an error that reaches the
 * screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const rpc = vi.hoisted(() => vi.fn());
const reportError = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError }));

import {
  useStatsPulse,
  pulseOf,
  STATS_PULSE_INTERVAL_MS,
  STATS_PULSE_STALE_AFTER_MS,
} from '../../src/hooks/useStatsPulse';

let visibility: DocumentVisibilityState = 'visible';

function setVisible(v: boolean) {
  visibility = v ? 'visible' : 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
}

const payload = (pulse: string) => ({
  data: { newest_hand_at: null, tournaments: null, pulse },
  error: null,
});

async function flush() {
  // Let the awaited rpc promise settle and the effect's callbacks run.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  rpc.mockReset();
  reportError.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pulseOf', () => {
  it('reads the pulse string and refuses anything else', () => {
    expect(pulseOf({ pulse: 'a#b' })).toBe('a#b');
    expect(pulseOf({ pulse: 7 })).toBeNull();
    expect(pulseOf(null)).toBeNull();
    expect(pulseOf('a#b')).toBeNull();
    expect(pulseOf([])).toBeNull();
  });
});

describe('useStatsPulse', () => {
  it('samples at once, treats the first sample as a baseline, and fires when the pulse moves', async () => {
    rpc.mockResolvedValueOnce(payload('h1#t1'));
    const onChange = vi.fn();
    renderHook(() => useStatsPulse({ userId: 'u1', enabled: true, onChange }));
    await flush();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('ca_player_stats_pulse', { p_user: 'u1' });
    expect(onChange).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce(payload('h1#t1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS);
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce(payload('h2#t1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS);
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    // A tournament row moving is a change too; the hand index never saw those.
    rpc.mockResolvedValueOnce(payload('h2#t2'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS);
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does nothing when disabled or without a user', async () => {
    const onChange = vi.fn();
    renderHook(() => useStatsPulse({ userId: 'u1', enabled: false, onChange }));
    renderHook(() => useStatsPulse({ userId: null, enabled: true, onChange }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS * 3);
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('costs nothing while hidden and polls the moment the tab is back', async () => {
    rpc.mockResolvedValue(payload('h1#t1'));
    const onChange = vi.fn();
    renderHook(() => useStatsPulse({ userId: 'u1', enabled: true, onChange }));
    await flush();
    expect(rpc).toHaveBeenCalledTimes(1);

    act(() => setVisible(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS * 3);
    });
    expect(rpc).toHaveBeenCalledTimes(1);

    // Back after less than the stale bar, with a new hand: one change, no
    // blind refetch.
    rpc.mockResolvedValue(payload('h2#t1'));
    act(() => setVisible(true));
    await flush();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a return after the stale bar refetches once, and the new sample is the baseline', async () => {
    rpc.mockResolvedValue(payload('h1#t1'));
    const onChange = vi.fn();
    renderHook(() => useStatsPulse({ userId: 'u1', enabled: true, onChange }));
    await flush();

    act(() => setVisible(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_STALE_AFTER_MS + 1);
    });
    // The pulse moved while away. The return owes ONE refetch, not one for
    // "time passed" plus one for "the pulse moved".
    rpc.mockResolvedValue(payload('h9#t1'));
    act(() => setVisible(true));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);

    // And the next tick sees the same pulse: quiet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports a failing poll once, keeps polling, and never calls onChange for it', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const onChange = vi.fn();
    renderHook(() => useStatsPulse({ userId: 'u1', enabled: true, onChange }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS * 2);
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toBe('useStatsPulse.rpc_ca_player_stats_pulse');
    expect(onChange).not.toHaveBeenCalled();

    // Recovery: the first good sample is a baseline, the next change fires.
    rpc.mockResolvedValueOnce(payload('h1#t1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS);
    });
    rpc.mockResolvedValueOnce(payload('h2#t1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount and drops a sample that lands afterwards', async () => {
    let release: (v: unknown) => void = () => {};
    rpc.mockImplementation(() => new Promise((res) => (release = res)));
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useStatsPulse({ userId: 'u1', enabled: true, onChange }));
    await flush();
    expect(rpc).toHaveBeenCalledTimes(1);
    unmount();
    release(payload('h1#t1'));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS * 3);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls the CURRENT onChange, not the one from the first render', async () => {
    rpc.mockResolvedValueOnce(payload('h1#t1'));
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onChange }) => useStatsPulse({ userId: 'u1', enabled: true, onChange }),
      { initialProps: { onChange: first } }
    );
    await flush();
    rerender({ onChange: second });
    rpc.mockResolvedValueOnce(payload('h2#t1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_PULSE_INTERVAL_MS);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    // Rerendering with a new callback did not restart the poll (no extra rpc).
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
