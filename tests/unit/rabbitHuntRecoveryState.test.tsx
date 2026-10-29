import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useRabbitHuntReveal } from '../../src/components/table/useRabbitHuntReveal';
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function Surface({ request, restore, user = 'a' }: any) {
  const state = useRabbitHuntReveal({ onReveal: request, onRestore: restore, userId: user });
  return (
    <>
      <button onClick={() => void state.reveal(42)} disabled={state.isRevealing}>
        Reveal
      </button>
      <output>
        {state.hasRevealed
          ? 'cards'
          : state.isSlow
            ? 'slow'
            : state.recoveryNeeded
              ? 'recover'
              : state.isRevealing
                ? 'pending'
                : 'idle'}
      </output>
    </>
  );
}
it('shows slow feedback, then preserves an unknown outcome for an explicit same-hand recovery', async () => {
  vi.useFakeTimers();
  let finish!: (v: unknown) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockResolvedValue({
      success: true,
      cards: [{ rank: 'A', suit: 's' }],
      source: 'already_revealed',
    });
  const view = render(<Surface request={request} />);
  fireEvent.click(view.getByRole('button'));
  expect(view.getByText('pending')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(view.getByText('slow')).toBeTruthy();
  await act(async () => {
    finish({ success: false, retryable: true });
  });
  expect(view.getByText('recover')).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole('button'));
  });
  expect(view.getByText('cards')).toBeTruthy();
  expect(request.mock.calls).toEqual([[42], [42]]);
});
it('restores without invoking the purchase and masks the previous user immediately', async () => {
  const request = vi.fn();
  const restore = vi.fn().mockResolvedValue({ success: true, cards: [{ rank: 'A', suit: 's' }] });
  const view = render(<Surface request={request} restore={restore} />);
  await waitFor(() => expect(view.getByText('cards')).toBeTruthy());
  expect(request).not.toHaveBeenCalled();
  view.rerender(<Surface request={request} user="b" />);
  expect(view.queryByText('cards')).toBeNull();
});
it('does not let a late receipt overwrite a new purchase or a replaced viewer', async () => {
  let finish!: (v: unknown) => void;
  const restore = () =>
    new Promise<any>((resolve) => {
      finish = resolve;
    });
  const request = vi.fn().mockResolvedValue({ success: false, error: 'Not Available' });
  const view = render(<Surface request={request} restore={restore} />);
  await act(async () => {
    fireEvent.click(view.getByRole('button'));
  });
  await act(async () => {
    finish({ success: true, cards: [{ rank: 'A', suit: 's' }] });
  });
  expect(view.queryByText('cards')).toBeNull();
});
