/**
 * The shell update gate's poll, run for real (src/hooks/useShellUpdateGate.ts).
 *
 * 2026-10-05 audit: a route change that landed inside the probe's one-minute
 * throttle was marked as seen even though no probe ran, so a tab that had just
 * been focused and then navigated did not learn it was stale until the
 * 15-minute idle check. The route change now stays due until a probe runs.
 * None of this reloads anything: a stale answer only arms the same gate.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/lib/readDeployedShell', () => ({ readDeployedShell: vi.fn() }));

import { readDeployedShell } from '../../src/lib/readDeployedShell';
import {
  STALE_CHECK_IDLE_MS,
  STALE_CHECK_MIN_INTERVAL_MS,
  useShellUpdateGate,
} from '../../src/hooks/useShellUpdateGate';

const probes = vi.mocked(readDeployedShell);
let entry: HTMLMetaElement;

beforeEach(() => {
  vi.useFakeTimers();
  probes.mockReset();
  // The deployed shell is the one running: nothing is ever stale here.
  probes.mockResolvedValue('<script type="module" src="/assets/index-same.js"></script>');
  // The running shell's entry chunk, as extractEntryScript reads it from the page.
  entry = document.createElement('meta');
  entry.setAttribute('content', '/assets/index-same.js');
  document.head.appendChild(entry);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getRegistration: vi.fn().mockResolvedValue(undefined),
    },
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  window.history.replaceState(null, '', '/hub/club-arena/clubs/a');
});

afterEach(() => {
  entry.remove();
  vi.useRealTimers();
});

describe('useShellUpdateGate poll', () => {
  it('a route change inside the throttle is probed once the throttle allows, not forgotten', async () => {
    renderHook(() => useShellUpdateGate());
    expect(probes).toHaveBeenCalledTimes(1); // the mount check

    window.history.replaceState(null, '', '/hub/club-arena/clubs/b');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probes).toHaveBeenCalledTimes(1); // inside the throttle

    await vi.advanceTimersByTimeAsync(STALE_CHECK_MIN_INTERVAL_MS);
    expect(probes).toHaveBeenCalledTimes(2); // the route change, once allowed

    // Consumed: no further probe until the idle interval.
    await vi.advanceTimersByTimeAsync(STALE_CHECK_MIN_INTERVAL_MS * 2);
    expect(probes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STALE_CHECK_IDLE_MS);
    expect(probes).toHaveBeenCalledTimes(3);
  });

  it('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useShellUpdateGate());
    unmount();
    window.history.replaceState(null, '', '/hub/club-arena/clubs/c');
    await vi.advanceTimersByTimeAsync(STALE_CHECK_IDLE_MS * 2);
    expect(probes).toHaveBeenCalledTimes(1);
  });
});
