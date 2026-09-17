import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DiamondBustPrompt from '../../src/components/games/DiamondBustPrompt';

const state = vi.hoisted(() => ({
  user: { id: 'player-a' },
  entry: null as null | { bust_prompt: boolean; member_chips: number | null; diamonds: number },
  navigate: vi.fn(),
  retainExit: false,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../../src/hooks/useDiamondGamesEntry', () => ({
  useDiamondGamesEntry: () => ({ entry: state.entry }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
  const { useRef } = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    // Model an exit that never completes: dismissal must remove the owning
    // Modal subtree even while its presence boundary retains animated children.
    AnimatePresence: ({ children }: { children: import('react').ReactNode }) => {
      const retained = useRef(children);
      if (children) retained.current = children;
      return state.retainExit ? retained.current : children;
    },
  };
});
beforeEach(() => {
  sessionStorage.clear();
  state.user = { id: 'player-a' };
  state.entry = null;
  state.navigate.mockClear();
  state.retainExit = false;
});

describe('Diamond Spins bust invitation', () => {
  it('removes a dismissed offer even when its exit animation cannot complete', () => {
    state.retainExit = true;
    state.entry = { bust_prompt: true, member_chips: 0, diamonds: 25 };
    const { rerender } = render(<DiamondBustPrompt clubId="club-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    expect(screen.queryByRole('dialog', { name: 'Diamond Spins' })).not.toBeInTheDocument();
    expect(document.querySelector('.ca-modal-portal')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<DiamondBustPrompt clubId="club-b" />);
    expect(screen.getByRole('dialog', { name: 'Diamond Spins' })).toBeInTheDocument();
  });

  it('removes a dismissed offer when session storage is unavailable', () => {
    state.retainExit = true;
    state.entry = { bust_prompt: true, member_chips: 0, diamonds: 25 };
    // happy-dom's concrete sessionStorage prototype can differ from the
    // global Storage constructor, so spy on the object that owns the method.
    const write = vi
      .spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage unavailable');
      });
    try {
      const { rerender } = render(<DiamondBustPrompt clubId="club-a" />);
      fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
      expect(write).toHaveBeenCalledWith('diamond-spins-bust:player-a:club-a', 'dismissed');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      rerender(<DiamondBustPrompt clubId="club-a" />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      write.mockRestore();
    }
  });

  it('requires confirmed zero chips, at least 25 diamonds, and server eligibility', () => {
    const { rerender } = render(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const entry of [
      { bust_prompt: true, member_chips: null, diamonds: 100 },
      { bust_prompt: true, member_chips: 0.01, diamonds: 100 },
      { bust_prompt: true, member_chips: 0, diamonds: 24 },
      { bust_prompt: false, member_chips: 0, diamonds: 100 },
    ]) {
      state.entry = entry;
      rerender(<DiamondBustPrompt clubId="club-a" />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
    state.entry = { bust_prompt: true, member_chips: 0, diamonds: 25 };
    rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.getByRole('dialog', { name: 'Diamond Spins' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Earn Diamonds Daily' }));
    expect(state.navigate).toHaveBeenCalledWith('/clubs/club-a/earn-diamonds');
  });
  it('dismisses per account and club, and permits a new invitation after chips are replenished', () => {
    state.entry = { bust_prompt: true, member_chips: 0, diamonds: 25 };
    const { rerender } = render(<DiamondBustPrompt clubId="club-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    state.user = { id: 'player-b' };
    rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    state.user = { id: 'player-a' };
    rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    state.entry = { bust_prompt: false, member_chips: 10, diamonds: 25 };
    rerender(<DiamondBustPrompt clubId="club-a" />);
    state.entry = { bust_prompt: true, member_chips: 0, diamonds: 25 };
    rerender(<DiamondBustPrompt clubId="club-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Play Diamond Spins' }));
    expect(state.navigate).toHaveBeenCalledWith('/clubs/club-a/wheel');
  });
});
