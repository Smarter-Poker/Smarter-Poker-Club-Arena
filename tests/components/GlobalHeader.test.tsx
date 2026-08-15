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
  it('renders the SMARTER.POKER brand text', () => {
    render(
      <MemoryRouter>
        <GlobalHeader pageDepth={1} />
      </MemoryRouter>
    );
    expect(screen.getByText('SMARTER.POKER')).toBeInTheDocument();
  });

  it('renders the BrainIcon button when on the lobby (pageDepth 1)', () => {
    render(
      <MemoryRouter>
        <GlobalHeader pageDepth={1} />
      </MemoryRouter>
    );
    const btn = screen.getByRole('button', { name: /Back To Hub/i });
    expect(btn).toBeInTheDocument();
    // Ensures we don't have the Go Back button
    expect(screen.queryByRole('button', { name: /Go Back/i })).not.toBeInTheDocument();
  });

  it('renders the Back Arrow button when on a sub-page (pageDepth >= 2)', () => {
    render(
      <MemoryRouter>
        <GlobalHeader pageDepth={2} />
      </MemoryRouter>
    );
    const btn = screen.getByRole('button', { name: /Go Back/i });
    expect(btn).toBeInTheDocument();
  });
});
