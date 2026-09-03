/**
 * Crazy Pineapple: a human must be able to choose their own discard.
 *
 * The engine has had the full path since FIX 120 — a `pineapple_discard` stage,
 * PINEAPPLE_DISCARD_REQUIRED, performDiscard, a discard timer, and
 * GameServerAPI.submitDiscard. The CLIENT had none of it: `submitDiscard` had
 * zero call sites anywhere in src/, and nothing rendered on the stage.
 *
 * So on all 103 pineapple tables the discard timer expired every hand and the
 * engine's fallback threw away each human's LAST card, whatever the flop. It was
 * not even symmetric: horses run HorseLogic.decideDiscard and pick the
 * equity-maximising card. The bots played the variant correctly; the people
 * never got to play it at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PineappleDiscard from '../src/components/table/PineappleDiscard';

const cards = [
  { rank: 'A' as const, suit: 's' as const },
  { rank: 'K' as const, suit: 'h' as const },
  { rank: '2' as const, suit: 'd' as const },
];

describe('PineappleDiscard', () => {
  it('renders nothing outside the discard phase', () => {
    const { container } = render(
      <PineappleDiscard isOpen={false} cards={cards} onDiscard={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('refuses to render on anything other than exactly three cards', () => {
    const { container } = render(
      <PineappleDiscard isOpen cards={cards.slice(0, 2)} onDiscard={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('cannot submit until a card is chosen', () => {
    render(<PineappleDiscard isOpen cards={cards} onDiscard={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: /select a card/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits the index of the chosen card, not a fixed one', async () => {
    const onDiscard = vi.fn().mockResolvedValue(true);
    render(<PineappleDiscard isOpen cards={cards} onDiscard={onDiscard} />);

    // Pick the middle card. The old engine fallback always threw the LAST one,
    // so an implementation that ignores the selection would send 2.
    fireEvent.click(screen.getByLabelText('Discard Kh'));
    fireEvent.click(
      screen
        .getAllByRole('button', { name: /discard kh/i })
        .find((b) => b.classList.contains('pineapple-discard__confirm'))!
    );

    await waitFor(() => expect(onDiscard).toHaveBeenCalledTimes(1));
    expect(onDiscard).toHaveBeenCalledWith(1);
  });

  it('marks the chosen card and leaves the others as keeps', () => {
    render(<PineappleDiscard isOpen cards={cards} onDiscard={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Discard 2d'));
    expect(screen.getByLabelText('Discard 2d').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Discard As').getAttribute('aria-pressed')).toBe('false');
  });

  it('stays open and explains itself when the engine refuses', async () => {
    // Closing here would hand the choice back to the auto-discard, which is the
    // exact behaviour this component exists to remove.
    const onDiscard = vi.fn().mockResolvedValue(false);
    render(<PineappleDiscard isOpen cards={cards} onDiscard={onDiscard} />);

    fireEvent.click(screen.getByLabelText('Discard As'));
    fireEvent.click(
      screen
        .getAllByRole('button', { name: /discard as/i })
        .find((b) => b.classList.contains('pineapple-discard__confirm'))!
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByLabelText('Discard As')).toBeTruthy(); // still selectable
  });

  it('shows how long is left before the table discards for you', () => {
    render(
      <PineappleDiscard isOpen cards={cards} onDiscard={vi.fn()} deadline={Date.now() + 9_000} />
    );
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
  });
});
