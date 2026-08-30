import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalHeader from '@/components/navigation/GlobalHeader';

// Mock dependencies
vi.mock('@/stores/useWalletStore', () => ({
  useWalletStore: () => ({
    loadBalances: vi.fn(),
    loadDiamonds: vi.fn(),
  }),
}));

const headerData = vi.hoisted(() => ({
  avatarUrl: '/avatars/test-user.png',
  notificationCount: 0,
  unreadMessages: 0,
  loadOnce: vi.fn(),
  setAvatarUrl: vi.fn(),
  setUnreadMessages: vi.fn(),
}));

vi.mock('@/stores/useHeaderDataStore', () => ({
  useHeaderDataStore: () => headerData,
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
  beforeEach(() => {
    headerData.notificationCount = 0;
    headerData.unreadMessages = 0;
  });

  it('renders the brand text image', () => {
    render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );
    const brandImage = screen.getByAltText('Smarter.Poker');
    expect(brandImage).toBeInTheDocument();
    expect(brandImage).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/brand.png')
    );
  });

  /*
   * UPDATED 2026-08-19: these tests previously asserted that Back was hidden at
   * lobby depth and that Hub did not exist at all. Dan asked for the opposite —
   * "the club arena needs a back button and hub button inside the global
   * header" — so GlobalHeader now renders the hamburger, Back and Hub
   * unconditionally and the `pageDepth` prop is gone (both real callers,
   * AppLayout and HomePage, already render <GlobalHeader /> with no props).
   * Depth-conditional assertions would now pin the exact behaviour that was
   * reported as a bug, so they are replaced with unconditional ones.
   */
  it('always renders the hamburger, Back and Hub in the left slot', () => {
    render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /Open Menu/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to the Hub/i })).toBeInTheDocument();

    expect(screen.getByAltText('Menu')).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/menu.png')
    );
    expect(screen.getByAltText('Back')).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/back.png')
    );
    expect(screen.getByAltText('Hub')).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/hub.png')
    );
  });

  it('renders every approved right-side control in the supplied order', () => {
    render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /My Profile/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Diamond Wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /VIP Member/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Messages/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Notifications/i })).toBeInTheDocument();

    expect(document.querySelector('img[src="/avatars/test-user.png"]')).toBeInTheDocument();

    expect(screen.getByAltText('Wallet')).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/wallet.png')
    );
    expect(screen.getByAltText('VIP Member')).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/vip.png')
    );
    expect(screen.getByAltText('Messages')).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/messenger.png')
    );
    expect(screen.getByAltText('Notifications')).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/notifications.png')
    );
  });

  it('renders the same left slot regardless of route depth', () => {
    // The reported bug was that a deeper route changed which escape hatches
    // existed. Rendering at a nested path must produce the identical three.
    render(
      <MemoryRouter initialEntries={['/clubs/abc/tables/xyz']}>
        <GlobalHeader />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /Open Menu/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to the Hub/i })).toBeInTheDocument();
  });

  it('keeps the notification count inside Notifications and out of Profile', () => {
    headerData.notificationCount = 5;
    render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );

    const notifications = screen.getByRole('link', { name: /^Notifications$/i });
    const profile = screen.getByRole('button', { name: /My Profile/i });
    const badge = within(notifications).getByLabelText('5 unread notifications');

    expect(badge).toHaveTextContent('5');
    expect(profile).not.toContainElement(badge);
    expect(within(profile).queryByLabelText(/unread notifications/i)).not.toBeInTheDocument();
  });
});
