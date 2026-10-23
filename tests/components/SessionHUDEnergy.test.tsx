import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  getStats: vi.fn(),
  startSession: vi.fn(),
  handlers: new Map<string, (payload: any) => void>(),
}));
vi.mock('../../src/services/SessionStatsService', () => ({ sessionStatsService: fixture }));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => null }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (event: string, handler: (payload: any) => void) => {
    fixture.handlers.set(event, handler);
  },
}));
import { SessionHUD } from '../../src/components/table/SessionHUD';
import RealTimeResultPanel from '../../src/components/table/RealTimeResultPanel';

const stats = {
  tableId: 'local-energy-fixture',
  userId: 'fixture',
  sessionStartTime: 10_000,
  initialStack: 100,
  currentStack: 100,
  buyInTotal: 100,
  handsPlayed: 0,
  handsWon: 0,
  handsPerHour: 0,
  vpipHands: 0,
  vpipPercent: 0,
  pfrHands: 0,
  pfrPercent: 0,
  profitLoss: 0,
  bigBlindsWon: 0,
  bigBlind: 2,
  trajectory: [],
};
const panel = (isOpen: boolean) => (
  <SessionHUD
    isOpen={isOpen}
    onClose={() => {}}
    tableId="local-energy-fixture"
    userId="fixture"
    initialStack={100}
    bigBlind={2}
    arenaAsset="chips"
  />
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(69_750);
  fixture.getStats.mockReset().mockReturnValue(stats);
  fixture.startSession.mockReset();
  fixture.handlers.clear();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session HUD energy', () => {
  it('keeps the result drawer idle on bus updates while closed', () => {
    const { unmount } = render(
      <RealTimeResultPanel
        isOpen={false}
        onClose={() => {}}
        tableId={stats.tableId}
        userId="fixture"
        initialStack={100}
        bigBlind={2}
        arenaAsset="chips"
      />
    );
    act(() => {
      fixture.handlers.get('SESSION_STATS_UPDATE')?.({ tableId: stats.tableId, stats });
      fixture.handlers.get('HAND_COMPLETED')?.({ tableId: stats.tableId });
    });
    expect(fixture.getStats).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('does no session reads, writes or timer callbacks while closed, including bus updates', () => {
    const { unmount } = render(panel(false));
    act(() => {
      fixture.handlers.get('SESSION_STATS_UPDATE')?.({ tableId: stats.tableId, stats });
      fixture.handlers.get('HAND_COMPLETED')?.({ tableId: stats.tableId });
      vi.advanceTimersByTime(900_000);
    });
    expect(fixture.getStats).not.toHaveBeenCalled();
    expect(fixture.startSession).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('updates at the actual session minute boundary and cleans up on close/reopen', () => {
    const { rerender, unmount } = render(panel(true));
    expect(screen.getByText('0m')).toBeInTheDocument();
    const reads = fixture.getStats.mock.calls.length;
    act(() => vi.advanceTimersByTime(249));
    expect(fixture.getStats).toHaveBeenCalledTimes(reads);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('1m')).toBeInTheDocument();
    rerender(panel(false));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(190_000);
    rerender(panel(true));
    expect(screen.getByText('3m')).toBeInTheDocument();
    expect(fixture.startSession).not.toHaveBeenCalled();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sleeps while Safari is hidden and catches up once restored', () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get');
    const { unmount } = render(panel(true));
    hidden.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(3_730_000);
    hidden.mockReturnValue('visible');
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
