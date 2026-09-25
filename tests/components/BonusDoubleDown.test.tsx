import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import BonusSetup, { bonusEntryStep } from '../../src/components/games/BonusSetup';
import { bonusTotal, type BonusBudget } from '../../src/utils/bonusGameBudget';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const initial: BonusBudget = {
  base: 200,
  doubled: false,
  denomination: null,
  award: { id: '00000000-0000-0000-0000-000000000077', entryDiamonds: 100, boostMultiplier: 2 },
};
function Entry({
  diamonds,
  change,
  answered = null,
  game = 'crash',
}: {
  diamonds: number;
  change: (budget: BonusBudget) => void;
  /** The award whose offer has already been answered, as the page remembers it. */
  answered?: string | null;
  game?: 'crash' | 'plinko';
}) {
  const [budget, setBudget] = useState(initial);
  const [answeredFor, setAnsweredFor] = useState<string | null>(answered);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Selected Entry">{bonusTotal(budget)}</output>
      <output aria-label="Current Route">
        {location.pathname}
        {location.search}
      </output>
      <output aria-label="Answered For">{answeredFor ?? ''}</output>
      <BonusSetup
        budget={budget}
        game={game}
        diamonds={diamonds}
        disabled={false}
        clubId="shark-club"
        // A page leaves through its own hold; this fixture has none to let go of.
        leave={navigate}
        offerAnswered={answeredFor === budget.award?.id}
        onOfferAnswered={setAnsweredFor}
        onChange={(next) => {
          change(next);
          setBudget(next);
        }}
      />
    </>
  );
}
function showOffer(
  diamonds: number,
  change = vi.fn(),
  props: Partial<Parameters<typeof Entry>[0]> = {}
) {
  render(
    <MemoryRouter>
      <Entry diamonds={diamonds} change={change} {...props} />
    </MemoryRouter>
  );
  const dialog = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
  return {
    dialog,
    change,
    reveal: () => fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!),
  };
}
/**
 * SCREEN ONE (Dan 2026-09-21, R9): after Play Game, the decision whether to
 * double the diamonds is its own step with two explicit choices. Nothing
 * dismisses it but a choice, the answer is remembered per award so a refresh
 * lands on the next step, and only then is the game's own setup offered.
 */
describe('the Double Your Diamonds step', () => {
  it('is the first step of an unanswered award and changes the entry only after an explicit choice', () => {
    const { dialog, change, reveal } = showOffer(500);
    expect(bonusEntryStep(initial, false)).toBe('offer');
    expect(screen.getByLabelText('Your Bonus Setup')).toHaveAttribute('data-bonus-step', 'offer');
    expect(dialog).toHaveTextContent('Add 100 Diamonds To Your 200 Diamond Bonus.');
    expect(dialog).toHaveTextContent('Extra Diamonds Are Used Only When You Start The Game.');
    expect(within(dialog).getByRole('button', { name: 'Add The Diamonds' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Play Without' })).toBeDisabled();
    expect(change).not.toHaveBeenCalled();
    reveal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add The Diamonds' }));
    expect(change).toHaveBeenCalledExactlyOnceWith({ ...initial, doubled: true });
    expect(screen.getByLabelText('Selected Entry')).toHaveTextContent('300');
    expect(screen.getByLabelText('Answered For')).toHaveTextContent(initial.award!.id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your Bonus Setup')).toHaveAttribute('data-bonus-step', 'setup');
  });
  it('is never dismissed by a timer, the overlay or Escape: two minutes idle and it is still asking', () => {
    vi.useFakeTimers();
    const { dialog, change, reveal } = showOffer(500);
    reveal();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Selected Entry')).toHaveTextContent('200');
  });
  it('lets a player play without, or buy the missing diamonds, without selecting a debit', () => {
    const { dialog, change, reveal } = showOffer(25);
    expect(dialog).toHaveTextContent('You Need 75 More Diamonds To Add Them.');
    reveal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Play Without' }));
    expect(change).toHaveBeenCalledExactlyOnceWith(initial);
    // The answer can be revisited from the setup, by the player's own tap.
    fireEvent.click(screen.getByRole('button', { name: 'Playing Without Extra Diamonds: Change' }));
    const reopened = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
    fireEvent.animationEnd(reopened.querySelector('[data-motion="keep"]')!);
    fireEvent.click(within(reopened).getByRole('button', { name: 'Buy More' }));
    expect(screen.getByLabelText('Current Route')).toHaveTextContent('/marketplace?tab=diamonds');
    expect(change).toHaveBeenCalledTimes(1);
  });
  it('skips straight to the setup when this award was already answered, as after a refresh', () => {
    render(
      <MemoryRouter>
        <Entry diamonds={500} change={vi.fn()} answered={initial.award!.id} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Your Bonus Setup')).toHaveAttribute('data-bonus-step', 'setup');
    expect(bonusEntryStep(initial, true)).toBe('setup');
  });
  it('asks again for a different award: an old answer never pre-answers a new one', () => {
    render(
      <MemoryRouter>
        <Entry diamonds={500} change={vi.fn()} answered="00000000-0000-0000-0000-000000000011" />
      </MemoryRouter>
    );
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
  });
  it('holds the Plinko selector back until the offer is answered, then offers it with nothing chosen', () => {
    const { dialog, reveal } = showOffer(500, vi.fn(), { game: 'plinko' });
    expect(screen.queryByRole('group', { name: 'Diamonds Per Drop' })).toBeNull();
    expect(screen.getByText('200 Diamonds To Drop. Answer The Offer First.')).toBeInTheDocument();
    reveal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Play Without' }));
    const selector = screen.getByRole('group', { name: 'Diamonds Per Drop' });
    expect(
      within(selector)
        .getAllByRole('button')
        .every((b) => b.getAttribute('aria-pressed') === 'false')
    ).toBe(true);
    expect(
      screen.getByText('Choose Your Diamonds Per Drop To Play 200 Diamonds.')
    ).toBeInTheDocument();
  });
});
