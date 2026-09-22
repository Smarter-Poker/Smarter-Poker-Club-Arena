/**
 * THE PANELS THAT HOLD A CARD PICK (owner ruling 2026-09-21, R15).
 *
 * A pick is won on the wheel and made in a popup, so between the two it has to
 * sit somewhere a player can find it: a persistent card on the wheel page, and
 * the end-of-run summary. Both are pinned here, and so is the order the
 * summary's one plate offers things in - the cards first, because they are a
 * tap away on this page and their diamonds are not paid until they are made,
 * then the bonus games, which are a round on another page.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WheelCardQueue,
  WheelRunSummary,
  type WheelRunSummaryData,
} from '../../src/components/wheel/WheelRunPanels';
import type { WheelBonusAward, WheelCardAward } from '../../src/services/DiamondWheelService';

vi.mock('../../src/components/common/Modal', () => ({
  Modal: ({ children, ariaLabel }: { children: React.ReactNode; ariaLabel: string }) => (
    <div role="dialog" aria-label={ariaLabel}>
      {children}
    </div>
  ),
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    children,
    title,
    plates,
  }: {
    children: React.ReactNode;
    title: string;
    plates?: {
      secondary?: { label: string; onClick: () => void };
      primary?: { label: string; onClick: () => void };
    };
  }) => (
    <div>
      <h2>{title}</h2>
      {children}
      {plates?.secondary && (
        <button type="button" onClick={plates.secondary.onClick}>
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button type="button" onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      )}
    </div>
  ),
}));

const card = (id: string, risk = 100): WheelCardAward => ({
  id,
  spin_id: `spin-${id}`,
  risk_diamonds: risk,
});
const game: WheelBonusAward = {
  id: 'award-mines',
  game: 'mines',
  base_diamonds: 100,
  boost_multiplier: 1,
  entry_diamonds: 100,
};
const summary = (over: Partial<WheelRunSummaryData> = {}): WheelRunSummaryData => ({
  total: 5,
  done: 5,
  why: null,
  prizes: [],
  games: [],
  cards: [],
  ...over,
});

afterEach(cleanup);

describe('the waiting card pick', () => {
  it('names one pick, its risk, and opens nothing by itself', () => {
    const onPick = vi.fn();
    render(<WheelCardQueue awards={[card('a')]} onPick={onPick} />);
    expect(screen.getByText('You Have A Diamond Card Pick Waiting')).toBeInTheDocument();
    expect(screen.getByText('Diamond Cards, 100 Diamonds Risked')).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pick A Card' }));
    expect(onPick).toHaveBeenCalledWith(card('a'));
  });

  it('counts them when there is more than one, and offers the oldest', () => {
    const onPick = vi.fn();
    render(<WheelCardQueue awards={[card('a'), card('b', 2500)]} onPick={onPick} />);
    expect(screen.getByText('You Have 2 Diamond Card Picks Waiting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pick A Card' }));
    expect(onPick).toHaveBeenCalledWith(card('a'));
  });

  it('is nothing at all with no picks waiting, and is held while the wheel is busy', () => {
    const { container } = render(<WheelCardQueue awards={[]} onPick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    render(<WheelCardQueue awards={[card('a')]} disabled onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Pick A Card' })).toBeDisabled();
  });
});

describe('the end-of-run summary', () => {
  it('lists the picks and offers them before the games', () => {
    const onPick = vi.fn();
    const onPlay = vi.fn();
    render(
      <WheelRunSummary
        summary={summary({ cards: [card('a'), card('b', 250)], games: [game] })}
        onPlay={onPlay}
        onPickCard={onPick}
        onClose={vi.fn()}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Run Complete' });
    expect(within(dialog).getByText('2 Diamond Card Picks To Make')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('list', { name: 'Diamond Card Picks Won This Run' }).children
    ).toHaveLength(2);
    expect(within(dialog).getByText('1 Bonus Game To Play')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pick A Card' }));
    expect(onPick).toHaveBeenCalledWith(card('a'));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('turns into Play Game once every card is turned over', () => {
    const onPlay = vi.fn();
    render(
      <WheelRunSummary
        summary={summary({ cards: [], games: [game] })}
        onPlay={onPlay}
        onPickCard={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Pick A Card' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play Game' }));
    expect(onPlay).toHaveBeenCalledWith(game);
  });

  it('is one Continue when a run left nothing to finish', () => {
    const onClose = vi.fn();
    render(
      <WheelRunSummary
        summary={summary()}
        onPlay={vi.fn()}
        onPickCard={vi.fn()}
        onClose={onClose}
      />
    );
    expect(screen.queryByRole('button', { name: 'Pick A Card' })).toBeNull();
    expect(screen.queryByText(/Diamond Card Pick/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
