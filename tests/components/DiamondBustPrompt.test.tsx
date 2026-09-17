import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DiamondBustPrompt from '../../src/components/games/DiamondBustPrompt';

const state = vi.hoisted(() => ({
  user: { id: 'player-a' },
  entry: null as null | { bust_prompt: boolean; member_chips: number | null; diamonds: number },
  navigate: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../../src/hooks/useDiamondGamesEntry', () => ({
  useDiamondGamesEntry: () => ({ entry: state.entry }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
beforeEach(() => {
  sessionStorage.clear();
  state.user = { id: 'player-a' };
  state.entry = null;
  state.navigate.mockClear();
});

describe('Diamond Spins bust invitation', () => {
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
