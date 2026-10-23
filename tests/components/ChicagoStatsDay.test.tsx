import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chicagoStatsDay,
  nextChicagoStatsMidnight,
  useChicagoStatsDay,
} from '../../src/hooks/useChicagoStatsDay';
import { useRosterWinLoss } from '../../src/hooks/useRosterWinLoss';
import MemberWinLossCard from '../../src/components/club/MemberWinLossCard';
import ClubRosterService, { type RosterMember } from '../../src/services/ClubRosterService';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Chicago stats calendar', () => {
  it.each([
    ['2026-01-15T06:00:00Z', '2026-01-16T06:00:00Z'],
    ['2026-07-15T05:00:00Z', '2026-07-16T05:00:00Z'],
    ['2026-03-08T06:00:00Z', '2026-03-09T05:00:00Z'],
    ['2026-11-01T05:00:00Z', '2026-11-02T06:00:00Z'],
    ['2026-12-31T06:00:00Z', '2027-01-01T06:00:00Z'],
  ])('closes %s at %s including DST and year rollover', (start, end) => {
    expect(nextChicagoStatsMidnight(Date.parse(start))).toBe(Date.parse(end));
    expect(nextChicagoStatsMidnight(Date.parse(end) - 1)).toBe(Date.parse(end));
    expect(chicagoStatsDay(Date.parse(start) - 1)).not.toBe(chicagoStatsDay(Date.parse(start)));
  });

  it('emits the midnight event while the view stays open and cleans up its timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T04:59:59Z'));
    const view = renderHook(() => useChicagoStatsDay());
    expect(view.result.current).toBe('2026-10-23');
    act(() => vi.advanceTimersByTime(1000));
    expect(view.result.current).toBe('2026-10-24');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the record and the roster cache after waking across Chicago midnight', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-24T04:59:59Z'));
    const figure = { cash: 12, mtt: 0, net: 12 };
    const next = { cash: 0, mtt: 0, net: 0 };
    const record = vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue({
      as_of: '2026-10-23',
      today: figure,
      week: figure,
      month: figure,
      overall: figure,
    });
    const roster = vi
      .spyOn(ClubRosterService, 'getMembersWinLoss')
      .mockResolvedValue(new Map([['player', figure]]));
    const members = [{ user_id: 'player', can_view_financials: true }] as RosterMember[];
    render(<MemberWinLossCard clubId="club" userId="player" />);
    const list = renderHook(() => useRosterWinLoss('club', members, 'today', true, 1));
    await screen.findByText('Today');
    await waitFor(() => expect(list.result.current.get('player')?.net).toBe(12));
    expect(screen.getByText(/Today Resets At 12 AM Chicago Time/)).toBeInTheDocument();
    clock.mockReturnValue(Date.parse('2026-10-24T05:00:00Z'));
    record.mockResolvedValue({
      as_of: '2026-10-24',
      today: next,
      week: figure,
      month: figure,
      overall: figure,
    });
    roster.mockResolvedValue(new Map([['player', next]]));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(list.result.current.get('player')?.net).toBe(0));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(roster).toHaveBeenCalledTimes(2);
  });
});
