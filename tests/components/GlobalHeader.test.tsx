import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalHeader from '@/components/navigation/GlobalHeader';

// Mock dependencies
vi.mock('@/stores/useWalletStore', () => ({
  useWalletStore: () => ({
    loadBalances: vi.fn(),
    loadDiamonds: vi.fn(),
  }),
}));

vi.mock('@/stores/useHeaderDataStore', () => ({
  useHeaderDataStore: () => ({
    avatarUrl: null,
    notificationCount: 0,
    unreadMessages: 0,
    loadOnce: vi.fn(),
    setAvatarUrl: vi.fn(),
    setUnreadMessages: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({
    user: { id: 'test-user-123' },
  }),
}));

vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('@/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: vi.fn(),
}));

describe('GlobalHeader Component', () => {
  it('renders the brand text image', () => {
    render(
      <MemoryRouter>
        <GlobalHeader pageDepth={1} />
      </MemoryRouter>
    );
    const brandImage = screen.getByAltText('Smarter.Poker');
    expect(brandImage).toBeInTheDocument();
    expect(brandImage).toHaveAttribute('src', expect.stringContaining('brand-text-clean.png'));
  });

  // UPDATED: the header's left slot no longer carries a "Return to Hub"
  // button — GlobalHeader now renders only the hamburger at lobby depth and
  // adds the Back button on sub-pages (`isSubPage = pageDepth >= 2`).
  // Hub navigation moved to the right-hand orbs (/hub/*) and the hamburger
  // menu, so this test now pins the hamburger-only left slot at depth 1.
  it('renders only the hamburger (no Back button) on the lobby (pageDepth 1)', () => {
    render(
      <MemoryRouter>
        <GlobalHeader pageDepth={1} />
      </MemoryRouter>
    );
    const menuBtn = screen.getByRole('button', { name: /Open Menu/i });
    expect(menuBtn).toBeInTheDocument();

    const img = screen.getByAltText('Menu');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', expect.stringContaining('btn-hamburger-v4.png'));

    // Ensures we don't have the Go Back button at lobby depth
    expect(screen.queryByRole('button', { name: /Go back/i })).not.toBeInTheDocument();
    expect(screen.queryByAltText('Back')).not.toBeInTheDocument();
    // ...nor the removed Hub button
    expect(screen.queryByAltText('Hub')).not.toBeInTheDocument();
  });

  it('renders the Back button image when on a sub-page (pageDepth >= 2)', () => {
    render(
      <MemoryRouter>
        <GlobalHeader pageDepth={2} />
      </MemoryRouter>
    );
    const btn = screen.getByRole('button', { name: /Go back/i });
    expect(btn).toBeInTheDocument();

    const img = screen.getByAltText('Back');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', expect.stringContaining('btn-back.png'));

    // UPDATED: the hamburger stays alongside the Back button on sub-pages.
    expect(screen.getByRole('button', { name: /Open Menu/i })).toBeInTheDocument();
  });
});
