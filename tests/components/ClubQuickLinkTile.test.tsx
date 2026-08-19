/**
 * ClubQuickLinkTile — the club-aware Cashier/Marketplace lobby tile.
 * Covers: tap-through to target club, empty-state handler, quick-switch
 * popover (open, select, per-club balances, keyboard), chunk prefetch on
 * intent, and the long-press latch regression.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const inMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ in: inMock })) })),
    })),
  },
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'test-user-123' } }),
}));

vi.mock('@/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: vi.fn(),
  useMasterBusSubscriptions: vi.fn(),
}));

const preloadRouteMock = vi.fn();
vi.mock('@/utils/ChunkPreloader', () => ({
  preloadRoute: (path: string) => preloadRouteMock(path),
  preloadCriticalChunks: vi.fn(),
}));

import ClubQuickLinkTile from '@/components/home/ClubQuickLinkTile';
import { clearClubChipBalanceCache } from '@/utils/clubQuickLink';

const TILE = {
  img: 'images/tiles/cashier.webp',
  alt: 'Cashier',
  route: null,
  shortcutKey: '4',
};

const A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha Club' };
const B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Bravo Club' };

function renderTile(props: Record<string, unknown> = {}) {
  const merged = {
    tile: TILE,
    clubs: [A, B],
    targetClub: A,
    menuTitle: 'Open Cashier For',
    onSelect: vi.fn(),
    onEmpty: vi.fn(),
    ...props,
  };
  return { ...render(<ClubQuickLinkTile {...(merged as never)} />), props: merged };
}

beforeEach(() => {
  localStorage.clear();
  clearClubChipBalanceCache();
  inMock.mockReset();
  preloadRouteMock.mockReset();
  inMock.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ClubQuickLinkTile', () => {
  it('shows the target club name on the tile and opens it on tap', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderTile({ onSelect });
    expect(screen.getByText('Alpha Club')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cashier for Alpha Club/ }));
    expect(onSelect).toHaveBeenCalledWith(A);
  });

  it('calls onEmpty when the user has no clubs', async () => {
    const user = userEvent.setup();
    const onEmpty = vi.fn();
    renderTile({ clubs: [], targetClub: null, onEmpty });
    await user.click(screen.getByRole('button', { name: /Cashier \(press 4\)/ }));
    expect(onEmpty).toHaveBeenCalledOnce();
  });

  it('hides the quick-switch button for single-club users', () => {
    renderTile({ clubs: [A] });
    expect(screen.queryByRole('button', { name: /Switch club/ })).not.toBeInTheDocument();
  });

  it('opens the popover, lists clubs with chip balances, and selects one', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    inMock.mockResolvedValue({
      data: [
        { club_id: A.id, chip_balance: 1234 },
        { club_id: B.id, chip_balance: 50 },
      ],
      error: null,
    });
    renderTile({ onSelect });
    await user.click(screen.getByRole('button', { name: /Switch club/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(await screen.findByText(`${(1234).toLocaleString()} chips`)).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Bravo Club/ }));
    expect(onSelect).toHaveBeenCalledWith(B);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the popover on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderTile();
    const trigger = screen.getByRole('button', { name: /Switch club/ });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('navigates the popover with arrow keys', async () => {
    const user = userEvent.setup();
    renderTile();
    await user.click(screen.getByRole('button', { name: /Switch club/ }));
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Bravo Club/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toHaveFocus();
  });

  it('prefetches the destination chunk on pointer intent, once', async () => {
    const user = userEvent.setup();
    renderTile({ clubs: [A], preloadPath: '/cashier' });
    const tileBtn = screen.getByRole('button', { name: /Cashier for Alpha Club/ });
    await user.hover(tileBtn);
    await user.hover(tileBtn);
    expect(preloadRouteMock).toHaveBeenCalledTimes(1);
    expect(preloadRouteMock).toHaveBeenCalledWith('/cashier');
  });

  it('opens the popover on a long press', async () => {
    vi.useFakeTimers();
    renderTile();
    const tileBtn = screen.getByRole('button', { name: /Cashier for Alpha Club/ });
    fireEvent.pointerDown(tileBtn);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await act(async () => {}); // flush the balance fetch
  });

  it('does not open the popover when the press is cancelled early', () => {
    vi.useFakeTimers();
    renderTile();
    const tileBtn = screen.getByRole('button', { name: /Cashier for Alpha Club/ });
    fireEvent.pointerDown(tileBtn);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerCancel(tileBtn);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  // REGRESSION: dismissing a long-press popover without the click landing back
  // on the tile used to leave the latch set, swallowing the NEXT tile tap.
  it('does not swallow the next tile tap after a long-press popover is dismissed', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    renderTile({ onSelect });
    const tileBtn = screen.getByRole('button', { name: /Cashier for Alpha Club/ });

    fireEvent.pointerDown(tileBtn);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(tileBtn);
    expect(onSelect).toHaveBeenCalledWith(A);
  });

  it('marks the tile as a popup trigger only when switching is possible', () => {
    const { unmount } = renderTile({ clubs: [A] });
    expect(screen.getByRole('button', { name: /Cashier for Alpha Club/ })).not.toHaveAttribute(
      'aria-haspopup'
    );
    unmount();
    renderTile();
    expect(screen.getByRole('button', { name: /Cashier for Alpha Club/ })).toHaveAttribute(
      'aria-haspopup',
      'menu'
    );
  });
});
