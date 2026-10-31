import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ favorites: vi.fn(), allowance: vi.fn() }));
vi.mock('../../src/services/ThrowableFavoritesService', () => ({
  getThrowableFavorites: mocks.favorites,
}));
vi.mock('../../src/services/ThrowableService', () => ({
  throwableService: {
    getThrowablesByCategory: () => ({
      throws: [{ id: 'tomato', name: 'Tomato' }],
      sports: [{ id: 'football', name: 'Football' }],
      reactions: [{ id: 'heart', name: 'Heart' }],
      cheers: [{ id: 'confetti', name: 'Confetti' }],
      premium: [{ id: 'bomb', name: 'Bomb' }],
    }),
    getThrowAllowance: mocks.allowance,
  },
}));
vi.mock('../../src/components/table/ThrowableImage', () => ({
  ThrowableImage: () => null,
  preloadThrowableImages: vi.fn(),
}));
vi.mock('../../src/services/SoundService', () => ({ haptic: { light: vi.fn() } }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
import { ThrowableSelector } from '../../src/components/table/ThrowableSelector';
beforeEach(() => {
  mocks.allowance.mockResolvedValue({ freeThrowsRemaining: 30 });
  mocks.favorites.mockResolvedValue([{ id: 'heart', name: 'Heart' }]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('opens Favorites first, combines Party and Emoji, preserves VIP and opens notes', async () => {
  const notes = vi.fn();
  render(
    <ThrowableSelector
      userId="one"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onOpenNotes={notes}
      targetName="Opponent"
    />
  );
  await screen.findByTitle('Heart');
  const tabs = [...document.querySelectorAll('.throwable-selector__tabs button')];
  expect(tabs.map((x) => x.textContent)).toEqual([
    'Favorites',
    'Food',
    'Sports',
    'Reactions',
    'VIP',
  ]);
  expect(tabs[0]).toHaveClass('throwable-selector__tab--active');
  fireEvent.click(screen.getByRole('button', { name: 'Reactions' }));
  expect(screen.getByTitle('Heart')).toBeVisible();
  expect(screen.getByTitle('Confetti')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'VIP' }));
  expect(screen.getByTitle('Bomb')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  expect(notes).toHaveBeenCalledOnce();
});
it('never shows an old account ranking, and retries failures without blocking Notes', async () => {
  let resolve!: (items: unknown[]) => void;
  mocks.favorites
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    )
    .mockRejectedValueOnce(new Error('offline'));
  mocks.allowance.mockReturnValue(new Promise(() => {}));
  const notes = vi.fn();
  const view = render(
    <ThrowableSelector userId="old" onSelect={vi.fn()} onClose={vi.fn()} onOpenNotes={notes} />
  );
  view.rerender(
    <ThrowableSelector userId="new" onSelect={vi.fn()} onClose={vi.fn()} onOpenNotes={notes} />
  );
  await screen.findByRole('alert');
  await act(async () => resolve([{ id: 'bomb', name: 'Old Favorite' }]));
  expect(screen.queryByTitle('Old Favorite')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  expect(notes).toHaveBeenCalledOnce();
  mocks.favorites.mockResolvedValueOnce([{ id: 'heart', name: 'New Favorite' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByTitle('New Favorite')).toBeDisabled());
});
