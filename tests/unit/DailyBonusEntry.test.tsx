/**
 * DailyBonusEntry - the sheet is raised once per account per Chicago day, on
 * every visit that qualifies, and never left silent by a failed read, a
 * background tab, or a change of account.
 */
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  userId: 'u1' as string | null,
  pathname: '/',
  reportError: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: mocks.pathname }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));
vi.mock('../../src/services/DailyBonusService', () => ({
  dailyBonusService: { getStatus: mocks.getStatus },
}));
vi.mock('../../src/components/daily-bonus/DailyBonusSheet', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="sheet">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

import DailyBonusEntry from '../../src/components/daily-bonus/DailyBonusEntry';
import {
  RETRY_DELAY_MS,
  chicagoToday,
  markQuiet,
  quietUntil,
  shouldOpenSheet,
  wasSeenToday,
} from '../../src/components/daily-bonus/entryState';

const NOW = Date.parse('2026-09-08T20:00:00Z'); // 15:00 Chicago (CDT)
const RESET = '2026-09-09T05:00:00+00:00'; // Chicago midnight

const status = (over: Record<string, unknown> = {}) => ({
  eligible: true,
  today: '2026-09-08',
  reset_at: RESET,
  seconds_to_reset: 9 * 3600,
  shown_today: false,
  unclaimed: 2,
  tiles: [],
  ...over,
});

describe('DailyBonusEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    mocks.getStatus.mockReset();
    mocks.reportError.mockReset();
    mocks.userId = 'u1';
    mocks.pathname = '/';
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('names today the way the server does, in America/Chicago', () => {
    expect(chicagoToday(NOW)).toBe('2026-09-08');
    // 04:30Z is still 23:30 the previous evening in Chicago.
    expect(chicagoToday(Date.parse('2026-09-09T04:30:00Z'))).toBe('2026-09-08');
    expect(chicagoToday(Date.parse('2026-09-09T05:30:00Z'))).toBe('2026-09-09');
  });

  it('raises the sheet only for an eligible day with an unclaimed tile that was not dismissed', () => {
    expect(shouldOpenSheet(status() as never, 'u1')).toBe(true);
    expect(shouldOpenSheet(status({ unclaimed: 0 }) as never, 'u1')).toBe(false);
    expect(shouldOpenSheet(status({ eligible: false }) as never, 'u1')).toBe(false);
    expect(shouldOpenSheet(status({ shown_today: true }) as never, 'u1')).toBe(false);
    localStorage.setItem('ca_daily_bonus_seen:u1:2026-09-08', '1');
    expect(shouldOpenSheet(status() as never, 'u1')).toBe(false);
  });

  it('one popup per day: showing it spends the day, even if the tab is closed with the sheet still up', async () => {
    mocks.getStatus.mockResolvedValue(status());
    const first = render(<DailyBonusEntry />);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    // Marked the moment it is shown, before any close.
    expect(wasSeenToday('u1', '2026-09-08')).toBe(true);
    first.unmount(); // the tab closes with the sheet open

    render(<DailyBonusEntry />);
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it('one popup per day across devices: a day the server says was shown elsewhere stays quiet', async () => {
    mocks.getStatus.mockResolvedValue(status({ shown_today: true }));
    render(<DailyBonusEntry />);
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(quietUntil('u1')).toBe(Date.parse(RESET));
  });

  it('opens on entry and, once dismissed, stays down for that account and day without another read', async () => {
    mocks.getStatus.mockResolvedValue(status());
    const first = render(<DailyBonusEntry />);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    act(() => {
      screen.getByText('close').click();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(wasSeenToday('u1', '2026-09-08')).toBe(true);
    first.unmount();

    // The other host mounts its own copy: the local Chicago date says the
    // day was dismissed, so it does not even ask.
    render(<DailyBonusEntry />);
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('remembers a "nothing to show" answer per tab until midnight so the hub and the shell do not each re-ask', async () => {
    mocks.getStatus.mockResolvedValue(status({ unclaimed: 0 }));
    const first = render(<DailyBonusEntry />);
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(quietUntil('u1')).toBe(Date.parse(RESET));
    first.unmount();

    render(<DailyBonusEntry />);
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    // The memo dies with the day.
    vi.setSystemTime(Date.parse(RESET) + 1000);
    expect(quietUntil('u1')).toBeNull();
  });

  it('does not memo an ineligible answer: a profile still being created is asked again next time', async () => {
    mocks.getStatus.mockResolvedValue(
      status({ eligible: false, reason: 'no_profile', unclaimed: 0 })
    );
    render(<DailyBonusEntry />);
    await flush();
    expect(quietUntil('u1')).toBeNull();
  });

  it('asks again when the tab is looked at after the Chicago midnight the server reported', async () => {
    mocks.getStatus.mockResolvedValue(status({ unclaimed: 0 }));
    render(<DailyBonusEntry />);
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    // Same day, tab refocused: nothing to ask.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    // Next morning, the tab comes to the foreground.
    vi.setSystemTime(Date.parse(RESET) + 60_000);
    mocks.getStatus.mockResolvedValue(
      status({ today: '2026-09-09', reset_at: '2026-09-10T05:00:00+00:00' })
    );
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('asks again on its own the moment the day rolls over while the page stays open', async () => {
    mocks.getStatus.mockResolvedValue(status({ unclaimed: 0 }));
    render(<DailyBonusEntry />);
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    mocks.getStatus.mockResolvedValue(
      status({ today: '2026-09-09', reset_at: '2026-09-10T05:00:00+00:00' })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9 * 3600 * 1000 + 2000);
    });
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('a failed read on entry is retried, and the sheet still opens', async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error('503')).mockResolvedValue(status());
    render(<DailyBonusEntry />);
    await flush();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 10);
    });
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('a change of account asks for the new account and drops the old one’s sheet', async () => {
    mocks.getStatus.mockResolvedValue(status());
    const view = render(<DailyBonusEntry />);
    expect(await screen.findByRole('dialog')).toBeTruthy();

    mocks.userId = 'u2';
    mocks.getStatus.mockResolvedValue(status({ unclaimed: 0 }));
    view.rerender(<DailyBonusEntry />);
    await flush();
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays quiet on a table, on /bonuses and while the host suspends it, and asks once it may', async () => {
    mocks.getStatus.mockResolvedValue(status());
    mocks.pathname = '/table/abc';
    const view = render(<DailyBonusEntry suspended />);
    await flush();
    expect(mocks.getStatus).not.toHaveBeenCalled();

    mocks.pathname = '/bonuses';
    view.rerender(<DailyBonusEntry />);
    await flush();
    expect(mocks.getStatus).not.toHaveBeenCalled();

    mocks.pathname = '/clubs/x';
    view.rerender(<DailyBonusEntry suspended />);
    await flush();
    expect(mocks.getStatus).not.toHaveBeenCalled();

    view.rerender(<DailyBonusEntry />);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it('markQuiet ignores a reset_at it cannot parse', () => {
    markQuiet('u1', 'not-a-date');
    expect(quietUntil('u1')).toBeNull();
  });
});
