import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ToastProvider, useToast } from '../src/components/common/Toast';
import { holdInAppNavigation } from '../src/lib/navigationGuard';

const handlers = vi.hoisted(() => new Map<string, (payload: any) => void>());
vi.mock('../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (event: string, callback: (payload: any) => void) => {
    handlers.set(event, callback);
  },
}));
vi.mock('../src/lib/bbjHitOnce', () => ({ shouldAnnounceBbjHit: () => true }));
vi.mock('../src/services/SoundService', () => ({
  soundService: { isEnabled: () => false, playAchievement: vi.fn() },
  haptic: { medium: vi.fn() },
}));
vi.mock('../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
import { BBJHitAnnouncer } from '../src/components/bbj/BBJHitAnnouncer';
import { MilestoneToast } from '../src/components/common/MilestoneToast';

function Location() {
  return <output data-testid="destination">{useLocation().pathname}</output>;
}

afterEach(() => {
  vi.useRealTimers();
  handlers.clear();
});

describe('attention alert destinations', () => {
  it('custom-message setup supplies the scoped destination and preserves draft protection', () => {
    const source = readFileSync('src/components/navigation/HamburgerMenu.tsx', 'utf8');
    const reminder = source.slice(
      source.indexOf("toast.info(\n              'Finish Setting"),
      source.indexOf('.catch((error)')
    );
    expect(reminder).toContain('mayLeaveCurrentPage()');
    expect(reminder).toContain('navigate(');
    expect(reminder).toContain('`/clubs/${workspace.clubUUID}/welcome-message`');
    expect(reminder).toContain("'/welcome-messages'");
    expect(reminder).toContain('onClose()');
  });

  it('BBJ opens its exact table even without a mounted table bus consumer', () => {
    render(
      <MemoryRouter initialEntries={['/clubs/my-club']}>
        <BBJHitAnnouncer />
        <Location />
      </MemoryRouter>
    );
    act(() =>
      handlers.get('BBJ_HIT_GLOBAL')?.({
        tableId: 'hit-table',
        winnerName: 'Winner',
        amount: 100,
        tableName: 'Hit Table',
      })
    );
    expect(screen.getByTestId('destination').textContent).toBe('/clubs/my-club');
    fireEvent.click(screen.getByRole('button', { name: /Bad Beat Jackpot/ }));
    expect(screen.getByTestId('destination').textContent).toBe('/table/hit-table');
  });

  it('BBJ asks the existing draft guard before opening its table', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <BBJHitAnnouncer />
        <Location />
      </MemoryRouter>
    );
    act(() => handlers.get('BBJ_HIT_GLOBAL')?.({ tableId: 'hit-table', amount: 100 }));
    const release = holdInAppNavigation(() => false);
    try {
      fireEvent.click(screen.getByRole('button', { name: /Bad Beat Jackpot/ }));
      expect(screen.getByTestId('destination').textContent).toBe('/settings');
    } finally {
      release();
    }
  });

  it('achievement attention opens the achievements page on an explicit gesture', () => {
    render(
      <MemoryRouter>
        <MilestoneToast />
        <Location />
      </MemoryRouter>
    );
    act(() => handlers.get('MILESTONE_UNLOCKED')?.({ milestoneName: 'First Win' }));
    expect(screen.getByTestId('destination').textContent).toBe('/');
    fireEvent.keyDown(screen.getByRole('button', { name: /First Win/ }), { key: 'Enter' });
    expect(screen.getByTestId('destination').textContent).toBe('/achievements');
  });

  it('shared attention toasts activate by keyboard once and dismissal never navigates', () => {
    vi.useFakeTimers();
    const open = vi.fn();
    function Trigger() {
      const toast = useToast();
      return <button onClick={() => toast.info('Open Messages', undefined, open)}>Notify</button>;
    }
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText('Notify'));
    const alert = screen.getByRole('button', { name: 'Open Messages' });
    expect(alert.querySelector('button, [role="button"]')).toBeNull();
    fireEvent.keyDown(alert, { key: ' ' });
    fireEvent.click(alert);
    expect(open).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_001));
    fireEvent.click(screen.getByText('Notify'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Notification' }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
