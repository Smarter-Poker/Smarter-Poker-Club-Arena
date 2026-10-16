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
  const funded = { bust_prompt: false, member_chips: 100, diamonds: 25 };
  const empty = { bust_prompt: true, member_chips: 0, diamonds: 25 };
  function bust() {
    state.entry = funded;
    const view = render(<DiamondBustPrompt clubId="club-a" />);
    state.entry = empty;
    view.rerender(<DiamondBustPrompt clubId="club-a" />);
    return view;
  }

  it('never opens just because a club page opens, even for an eligible empty wallet', () => {
    state.entry = empty;
    const view = render(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens after a confirmed funded-to-empty transition and dismisses despite a stalled exit', () => {
    state.retainExit = true;
    const view = bust();
    expect(screen.getByRole('dialog', { name: 'Diamond Spins' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('.ca-modal-portal')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
    view.rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<DiamondBustPrompt clubId="club-b" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('removes a dismissed offer when session storage is unavailable', () => {
    state.retainExit = true;
    state.entry = { bust_prompt: true, member_chips: 0, diamonds: 25 };
    // Happy DOM binds Storage methods on first access; Node's native Storage
    // has different ownership. Inject the same fault at the global read used
    // by the component, independent of either implementation's method binding.
    const storage = sessionStorage;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
    const write = vi.fn(() => {
      throw new Error('Storage unavailable');
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.getItem(key),
        setItem: write,
        removeItem: (key: string) => storage.removeItem(key),
        clear: () => storage.clear(),
        key: (index: number) => storage.key(index),
        get length() {
          return storage.length;
        },
      } satisfies Storage,
    });
    try {
      const { rerender } = bust();
      fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
      expect(write).toHaveBeenCalledWith('diamond-spins-bust:player-a:club-a', 'dismissed');
      expect(write.mock.results[0].type).toBe('throw');
      expect(storage.getItem('diamond-spins-bust:player-a:club-a')).toBeNull();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      rerender(<DiamondBustPrompt clubId="club-a" />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    }
  });

  it('recognizes a real bust after chips were already committed to an active seat', () => {
    state.entry = { ...empty, bust_prompt: false };
    const view = render(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    state.entry = empty;
    view.rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.getByRole('dialog', { name: 'Diamond Spins' })).toBeInTheDocument();
  });

  it('never inherits a shortage from another account or club', () => {
    const view = bust();
    state.user = { id: 'player-b' };
    view.rerender(<DiamondBustPrompt clubId="club-a" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<DiamondBustPrompt clubId="club-b" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires confirmed zero chips, sufficient diamonds and current server eligibility', () => {
    state.entry = funded;
    const view = render(<DiamondBustPrompt clubId="club-a" />);
    for (const entry of [
      { bust_prompt: true, member_chips: null, diamonds: 100 },
      { bust_prompt: true, member_chips: 1, diamonds: 100 },
      { bust_prompt: true, member_chips: 0, diamonds: 24 },
      { bust_prompt: false, member_chips: 0, diamonds: 100 },
    ]) {
      state.entry = entry;
      view.rerender(<DiamondBustPrompt clubId="club-a" />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
  });

  it('allows a new real shortage after replenishment and preserves the Diamond Spins route', () => {
    const view = bust();
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    state.entry = funded;
    view.rerender(<DiamondBustPrompt clubId="club-a" />);
    state.entry = empty;
    view.rerender(<DiamondBustPrompt clubId="club-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Play Diamond Spins' }));
    expect(state.navigate).toHaveBeenCalledWith('/clubs/club-a/wheel');
  });
});
