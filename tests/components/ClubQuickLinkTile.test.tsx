/**
 * ClubQuickLinkTile — the club-aware Cashier/Marketplace lobby tile.
 * Covers: tap-through to target club, empty-state handler, quick-switch
 * popover (open, select, balances, keyboard), and chunk prefetch on intent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const eqMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: eqMock })),
    })),
  },
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'test-user-123' } }),
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

beforeEach(() => {
  localStorage.clear();
  clearClubChipBalanceCache();
  eqMock.mockReset();
  preloadRouteMock.mockReset();
  eqMock.mockResolvedValue({ data: [], error: null });
});

describe('ClubQuickLinkTile', () => {
  it('shows the target club name on the tile and opens it on tap', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ClubQuickLinkTile
        tile={TILE}
        clubs={[A, B]}
        targetClub={A}
        menuTitle="Open Cashier For"
        onSelect={onSelect}
        onEmpty={vi.fn()}
      />
    );
    expect(screen.getByText('Alpha Club')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cashier for Alpha Club/ }));
    expect(onSelect).toHaveBeenCalledWith(A);
  });

  it('calls onEmpty when the user has no clubs', async () => {
    const user = userEvent.setup();
    const onEmpty = vi.fn();
    render(
      <ClubQuickLinkTile
        tile={TILE}
        clubs={[]}
        targetClub={null}
        menuTitle="Open Cashier For"
        onSelect={vi.fn()}
        onEmpty={onEmpty}
      />
    );
    await user.click(screen.getByRole('button', { name: /Cashier \(press 4\)/ }));
    expect(onEmpty).toHaveBeenCalledOnce();
  });

  it('hides the quick-switch button for single-club users', () => {
    render(
      <ClubQuickLinkTile
        tile={TILE}
        clubs={[A]}
        targetClub={A}
        menuTitle="Open Cashier For"
        onSelect={vi.fn()}
        onEmpty={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /Switch club/ })).not.toBeInTheDocument();
  });

  it('opens the popover, lists clubs with chip balances, and selects one', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    eqMock.mockResolvedValue({
      data: [
        { club_id: A.id, chip_balance: 1234 },
        { club_id: B.id, chip_balance: 50 },
      ],
      error: null,
    });
    render(
      <ClubQuickLinkTile
        tile={TILE}
        clubs={[A, B]}
        targetClub={A}
        menuTitle="Open Cashier For"
        onSelect={onSelect}
        onEmpty={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: /Switch club/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Bravo Club/ })).toBeInTheDocument();
    expect(await screen.findByText(`${(1234).toLocaleString()} chips`)).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Bravo Club/ }));
    expect(onSelect).toHaveBeenCalledWith(B);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the popover on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <ClubQuickLinkTile
        tile={TILE}
        clubs={[A, B]}
        targetClub={A}
        menuTitle="Open Cashier For"
        onSelect={vi.fn()}
        onEmpty={vi.fn()}
      />
    );
    const trigger = screen.getByRole('button', { name: /Switch club/ });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('navigates the popover with arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <ClubQuickLinkTile
        tile={TILE}
        clubs={[A, B]}
        targetClub={A}
        menuTitle="Open Cashier For"
        onSelect={vi.fn()}
        onEmpty={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: /Switch club/ }));
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Bravo Club/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Alpha Club/ })).toHaveFocus();
  });

  it('prefetches the destination chunk on pointer intent, once', async () => {
    const user = userEvent.setup();
    render(
      <ClubQuickLinkTile
        tile={TILE}
        clubs={[A]}
        targetClub={A}
        menuTitle="Open Cashier For"
        onSelect={vi.fn()}
        onEmpty={vi.fn()}
        preloadPath="/cashier"
      />
    );
    const tileBtn = screen.getByRole('button', { name: /Cashier for Alpha Club/ });
    await user.hover(tileBtn);
    await user.hover(tileBtn);
    expect(preloadRouteMock).toHaveBeenCalledTimes(1);
    expect(preloadRouteMock).toHaveBeenCalledWith('/cashier');
  });
});
