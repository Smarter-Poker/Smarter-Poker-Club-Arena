/**
 * EVERY MINES TILE WORKS FROM A KEYBOARD AND SAYS WHAT IT TURNED OVER
 * (review 2026-09-22).
 *
 * The tiles are buttons, but a picked tile, and the whole board while a pick
 * was out, carried the disabled attribute. A browser drops focus from a
 * control the moment it is disabled, so every pick threw a keyboard or screen
 * reader player back to the top of the page. Tiles a round can still reach now
 * stay focusable and refuse the press instead; only a board with no round in
 * play is taken out of the tab order. The board's name was on an element with
 * no role, so assistive technology never read it. And nothing said what a pick
 * turned over: the profit readouts changed, and a mine rebuilt the whole board
 * (the reveal restarts on a fresh element), so the tile's outcome was never
 * announced. A polite status beside the board now says it, and it outlives the
 * reveal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import MinesGrid from '../../src/components/games/MinesGrid';

afterEach(cleanup);
const PRIZES = [1.2, 1.5, 1.9];
type Props = Parameters<typeof MinesGrid>[0];
const board = (props: Partial<Props>) => (
  <MinesGrid
    roundId="r"
    picked={[]}
    mines={null}
    phase="open"
    busy={false}
    onPick={() => {}}
    prizes={PRIZES}
    betChips={1}
    {...props}
  />
);

describe('a keyboard and screen reader player on the Mines board', () => {
  it('finds the board as a named group of 25 tile buttons', () => {
    render(board({}));
    const group = screen.getByRole('group', { name: 'Diamond Mines Board' });
    const tiles = within(group).getAllByRole('button');
    expect(tiles).toHaveLength(25);
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual(
      Array.from({ length: 25 }, (_, cell) => `Tile ${cell + 1}`)
    );
  });

  it('keeps the tile it picked focusable while the pick is out and after it lands', () => {
    const onPick = vi.fn();
    const view = render(board({ onPick }));
    const tile = screen.getByRole('button', { name: 'Tile 9' });
    tile.focus();
    fireEvent.click(tile);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(8);
    // The pick is out: every tile refuses a press, and none drops focus.
    view.rerender(board({ onPick, busy: true }));
    for (const each of screen.getAllByRole('button')) {
      expect(each).not.toHaveAttribute('disabled');
      expect(each).toHaveAttribute('aria-disabled', 'true');
    }
    expect(document.activeElement).toBe(tile);
    fireEvent.click(screen.getByRole('button', { name: 'Tile 10' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    // It landed on a gem: the same tile, still focused, now says so and cannot be picked twice.
    view.rerender(board({ onPick, picked: [8] }));
    const gem = screen.getByRole('button', { name: 'Tile 9, Gem' });
    expect(gem).toBe(tile);
    expect(document.activeElement).toBe(gem);
    expect(gem).not.toHaveAttribute('disabled');
    expect(gem).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(gem);
    expect(onPick).toHaveBeenCalledTimes(1);
    // Every other tile is live again.
    const next = screen.getByRole('button', { name: 'Tile 10' });
    expect(next).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(next);
    expect(onPick).toHaveBeenLastCalledWith(9);
  });

  it('takes a board with no round in play out of the tab order', () => {
    const view = render(board({ phase: 'idle', busy: true }));
    expect(screen.getAllByRole('button').every((tile) => tile.hasAttribute('disabled'))).toBe(true);
    view.rerender(board({ phase: 'lost', picked: [7], mines: [5, 7, 16, 23, 24] }));
    expect(screen.getAllByRole('button').every((tile) => tile.hasAttribute('disabled'))).toBe(true);
  });

  it('announces what each pick turned over, through the reveal that rebuilds the board', () => {
    const view = render(board({}));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');
    view.rerender(board({ picked: [8] }));
    expect(screen.getByRole('status')).toHaveTextContent('Tile 9 Is A Gem.');
    view.rerender(board({ picked: [8, 12] }));
    expect(screen.getByRole('status')).toHaveTextContent('Tile 13 Is A Gem.');
    // A mine ends the round and the board is rebuilt for the reveal; the
    // announcement is the same live element, so it is read out.
    view.rerender(board({ phase: 'lost', picked: [8, 12, 7], mines: [5, 7, 16, 23, 24] }));
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Tile 8 Is A Mine.');
    // A new round starts with nothing to announce.
    view.rerender(board({ roundId: 'next', picked: [] }));
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('');
  });
});
