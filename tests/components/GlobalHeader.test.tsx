import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  isVipActive: false,
  notificationCount: 0,
  unreadMessages: 0,
  loadOnce: vi.fn(),
  setAvatarUrl: vi.fn(),
  setUnreadMessages: vi.fn(),
  clearUnreadNotifications: vi.fn().mockResolvedValue(true),
  clearUnreadMessages: vi.fn().mockResolvedValue(true),
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
    headerData.avatarUrl = '/avatars/test-user.png';
    headerData.notificationCount = 0;
    headerData.unreadMessages = 0;
    headerData.isVipActive = false;
    headerData.clearUnreadNotifications.mockClear();
    headerData.clearUnreadMessages.mockClear();
  });

  const photo = 'https://example.supabase.co/storage/v1/object/public/avatars/player/avatar.jpg';
  const sized =
    'https://example.supabase.co/storage/v1/render/image/public/avatars/player/avatar.jpg?width=128&height=128&resize=cover&quality=80';
  const headerPortrait = () =>
    screen
      .getByRole('button', { name: 'My Profile' })
      .querySelector('span > img') as HTMLImageElement;
  const header = () => (
    <MemoryRouter>
      <GlobalHeader />
    </MemoryRouter>
  );

  it('loads a retina-sized JPEG while preserving the existing portrait slot', () => {
    headerData.avatarUrl = photo;
    render(header());
    expect(headerPortrait()).toHaveAttribute('src', sized);
    expect(headerPortrait().parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    '/avatars/table/free_owl@2x.webp',
    'https://example.supabase.co/storage/v1/object/public/avatars/a.png',
    'https://example.supabase.co/storage/v1/object/public/avatars/a.gif',
    'https://example.supabase.co/storage/v1/object/public/avatars/a.webp',
    'https://example.supabase.co/storage/v1/object/sign/avatars/a.jpg?token=test',
    'https://example.com/a.jpg',
    'data:image/jpeg;base64,dGVzdA==',
  ])('preserves artwork and non-transformable URL %s', (url) => {
    headerData.avatarUrl = url;
    render(header());
    expect(headerPortrait()).toHaveAttribute('src', url);
  });

  it('uses the original on transform failure, then the existing fallback without a loop', () => {
    headerData.avatarUrl = photo;
    render(header());
    const portrait = headerPortrait();
    fireEvent.error(portrait);
    expect(portrait).toHaveAttribute('src', photo);
    fireEvent.error(portrait);
    expect(portrait.getAttribute('src')).toMatch(/default-avatar\.png$/);
    const fallback = portrait.getAttribute('src');
    const assignSource = vi.spyOn(portrait, 'src', 'set');
    fireEvent.error(portrait);
    expect(assignSource).not.toHaveBeenCalled();
    expect(portrait.getAttribute('src')).toBe(fallback);
    assignSource.mockRestore();
  });

  it('loads the new sized photo after a previous photo failed', () => {
    headerData.avatarUrl = photo;
    const { rerender } = render(header());
    fireEvent.error(headerPortrait());
    fireEvent.error(headerPortrait());
    headerData.avatarUrl = photo.replace('avatar.jpg', 'replacement.jpg');
    rerender(header());
    expect(headerPortrait()).toHaveAttribute('src', sized.replace('avatar.jpg', 'replacement.jpg'));
  });

  it('keeps the approved Smarter.Poker wordmark unobstructed', () => {
    render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );
    expect(screen.getByLabelText('Smarter.Poker Global Header')).toBeInTheDocument();
    expect(screen.queryByText('Club Arena')).not.toBeInTheDocument();
    expect(document.querySelector('img[src*="vault-iris-emblem"]')).not.toBeInTheDocument();
    const approvedArtwork = document.querySelector('img[src*="global-header-desktop.png"]');
    expect(approvedArtwork).toHaveAttribute(
      'src',
      expect.stringContaining('images/global-header/global-header-desktop.png')
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
    expect(screen.getByRole('button', { name: /Go Back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go To The Hub/i })).toBeInTheDocument();

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
    // "My Wallet" since 2026-09-04: the button opens /wallet, not the diamond
    // store tab, so it is no longer labelled as the "Diamond Wallet" store.
    expect(screen.getByRole('button', { name: /My Wallet/i })).toBeInTheDocument();
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

  it('leaves non-member VIP artwork unchanged and marks active memberships', () => {
    const { rerender } = render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: 'VIP Membership' })).toHaveAttribute(
      'data-vip-active',
      'false'
    );

    headerData.isVipActive = true;
    rerender(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: 'VIP Membership Active' })).toHaveAttribute(
      'data-vip-active',
      'true'
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
    expect(screen.getByRole('button', { name: /Go Back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go To The Hub/i })).toBeInTheDocument();
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
    const badge = within(notifications).getByLabelText('5 Unread Notifications');

    expect(badge).toHaveTextContent('5');
    expect(profile).not.toContainElement(badge);
    expect(within(profile).queryByLabelText(/Unread Notifications/i)).not.toBeInTheDocument();
  });

  it('acknowledges unread messages before leaving for Messenger', async () => {
    headerData.unreadMessages = 4;
    render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /^Messages$/i }));
    await waitFor(() => {
      expect(headerData.clearUnreadMessages).toHaveBeenCalledWith('test-user-123');
    });
  });

  it('acknowledges Unread Notifications before opening Notifications', async () => {
    headerData.notificationCount = 5;
    render(
      <MemoryRouter>
        <GlobalHeader />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('link', { name: /^Notifications$/i }));
    await waitFor(() => {
      expect(headerData.clearUnreadNotifications).toHaveBeenCalledWith('test-user-123');
    });
  });
});
