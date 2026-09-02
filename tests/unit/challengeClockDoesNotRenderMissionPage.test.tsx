import { act, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { challengeClock, useChallengeClockNow } from '../../src/hooks/useChallengeClock';

describe('the Daily Missions clock render boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T23:59:55.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates countdown leaves each second without re-rendering their page container', () => {
    let pageRenders = 0;
    let leafRenders = 0;

    function ClockLeaf() {
      leafRenders += 1;
      const now = useChallengeClockNow();
      return <span data-testid="clock">{Math.floor(now / 1000)}</span>;
    }

    function MissionPageContainer() {
      pageRenders += 1;
      return <ClockLeaf />;
    }

    const view = render(<MissionPageContainer />);
    const mountedPageRenders = pageRenders;
    const mountedLeafRenders = leafRenders;
    const initial = view.getByTestId('clock').textContent;

    // Separate acts model separate browser task turns; one 3.1s advance would
    // intentionally let React batch the three external-store notifications.
    for (let second = 0; second < 3; second += 1) {
      act(() => void vi.advanceTimersByTime(1_050));
    }

    expect(view.getByTestId('clock').textContent).not.toBe(initial);
    expect(pageRenders).toBe(mountedPageRenders);
    expect(leafRenders).toBeGreaterThanOrEqual(mountedLeafRenders + 3);

    view.unmount();
    expect(challengeClock.listenerCount).toBe(0);
  });

  it('catches up from wall time after a background-tab style throttle', () => {
    function ClockLeaf() {
      const now = useChallengeClockNow();
      return <span data-testid="clock">{Math.floor(now / 1000)}</span>;
    }

    const view = render(<ClockLeaf />);
    const before = Number(view.getByTestId('clock').textContent);

    act(() => {
      vi.setSystemTime(new Date('2026-09-01T00:05:00.000Z'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const after = Number(view.getByTestId('clock').textContent);
    expect(after - before).toBeGreaterThanOrEqual(300);
    view.unmount();
  });
});
