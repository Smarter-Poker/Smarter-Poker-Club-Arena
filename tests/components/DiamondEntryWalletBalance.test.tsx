import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/hooks/useDiamondGamesEntry', () => ({
  useDiamondGamesEntry: () => ({
    entry: {
      available: true,
      diamonds: 12345,
      entry_diamonds: 100,
    },
  }),
}));
import DiamondsToChipsButton from '../../src/components/games/DiamondsToChipsButton';
describe('Diamond games wallet entry', () => {
  it('prints the actual whole Diamond balance in the wallet door and explanation', () => {
    render(<DiamondsToChipsButton clubId="club-a" onGo={vi.fn()} />);
    expect(screen.getByText('12,345')).toBeTruthy();
    expect(screen.getByText('12,345 Diamonds Ready To Play')).toBeTruthy();
    expect(screen.queryByText('12.3K')).toBeNull();
  });
});
