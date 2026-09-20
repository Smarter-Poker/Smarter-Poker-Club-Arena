/**
 * Diamond Mines reads like the leading Mines tables (Dan 2026-09-19): the
 * board says what it is worth now above the stake and what the next tile adds,
 * a picked tile turns over to show its gem, the mine that ends a round blasts,
 * and on a loss or a cash-out the whole board turns over in a ripple so every
 * mine and gem is seen. Reduced motion collapses the motion, never the reveal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MinesGrid, {
  cascadeDelay,
  minesReadouts,
  signedChips,
} from '../../src/components/games/MinesGrid';

afterEach(cleanup);
const PRIZES = [2.17, 5.33, 15.2];
const readout = (label: RegExp | string) => screen.getByText(label).nextElementSibling;

describe('the two readouts a Mines player weighs', () => {
  it('reads zero profit at 1.00x and the first tile gain before the round starts', () => {
    render(
      <MinesGrid
        picked={[]}
        mines={null}
        phase="idle"
        busy
        onPick={() => {}}
        prizes={PRIZES}
        betChips={1}
      />
    );
    expect(readout('Total Profit (1.00x)')).toHaveTextContent('0.00 Chips');
    expect(readout('Profit On Next Tile')).toHaveTextContent('+1.17 Chips');
  });
  it('reads the cash-out value above the stake and the next tile gain during play', () => {
    render(
      <MinesGrid
        picked={[2, 4]}
        mines={null}
        phase="open"
        busy={false}
        onPick={() => {}}
        prizes={PRIZES}
        betChips={1}
      />
    );
    expect(readout('Total Profit (5.33x)')).toHaveTextContent('+4.33 Chips');
    expect(readout('Total Profit (5.33x)')).toHaveAttribute('data-sign', 'gain');
    expect(readout('Profit On Next Tile')).toHaveTextContent('+9.87 Chips');
  });
  it('reads the guaranteed chips kept against the stake after a mine', () => {
    render(
      <MinesGrid
        picked={[2, 7]}
        mines={[7, 19]}
        phase="lost"
        busy={false}
        onPick={() => {}}
        prizes={PRIZES}
        betChips={1}
        payoutChips={0.1}
      />
    );
    expect(readout('Total Profit (0.10x)')).toHaveTextContent('-0.90 Chips');
    expect(readout('Total Profit (0.10x)')).toHaveAttribute('data-sign', 'loss');
    expect(readout('Profit On Next Tile')).toHaveTextContent('Round Over');
  });
  it('reads the booked chips after a cash-out and the limit at the last safe pick', () => {
    render(
      <MinesGrid
        picked={[2]}
        mines={[7, 19]}
        phase="cashed"
        busy={false}
        onPick={() => {}}
        prizes={PRIZES}
        betChips={1}
        payoutChips={2.17}
      />
    );
    expect(readout('Total Profit (2.17x)')).toHaveTextContent('+1.17 Chips');
    expect(readout('Profit On Next Tile')).toHaveTextContent('Win Booked');
    expect(minesReadouts({ phase: 'open', picks: 3, prizes: PRIZES, betChips: 1 }).nextProfit).toBe(
      'Limit Reached'
    );
    expect(signedChips(0)).toBe('0.00 Chips');
    expect(signedChips(-0.004)).toBe('0.00 Chips');
    expect(signedChips(12.345)).toBe('+12.35 Chips');
  });
  it('shows no readout without a prize ladder and stake, as a replay mounts it', () => {
    render(<MinesGrid picked={[]} mines={null} phase="idle" busy onPick={() => {}} />);
    expect(screen.queryByText(/Total Profit/)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(25);
  });
});

describe('tiles turn over', () => {
  it('flips the picked tile to its gem and leaves the rest sealed', () => {
    render(<MinesGrid picked={[6]} mines={null} phase="open" busy={false} onPick={() => {}} />);
    const gem = screen.getByRole('button', { name: 'Tile 7, Gem' });
    expect(gem).toHaveAttribute('data-flip', 'true');
    expect(gem).toHaveAttribute('data-cascade', 'false');
    expect(gem.querySelector('svg')).toBeTruthy();
    const sealed = screen.getByRole('button', { name: 'Tile 8' });
    expect(sealed).toHaveAttribute('data-flip', 'false');
    expect(sealed).toHaveAttribute('data-revealed', 'false');
    expect(sealed).toBeEnabled();
  });
  it('cascades the whole board from the mine that ended it, blasting that mine', () => {
    const onSettled = vi.fn();
    render(
      <MinesGrid
        roundId="r"
        picked={[2, 12]}
        mines={[12, 24]}
        phase="lost"
        busy={false}
        onPick={() => {}}
        onSettled={onSettled}
      />
    );
    const tiles = screen.getAllByRole('button');
    expect(tiles.every((tile) => tile.getAttribute('data-revealed') === 'true')).toBe(true);
    expect(screen.getAllByRole('button', { name: /, Mine$/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /, Gem$/ })).toHaveLength(23);
    const hit = screen.getByRole('button', { name: 'Tile 13, Mine' });
    expect(hit).toHaveAttribute('data-hit', 'true');
    expect(hit).toHaveAttribute('data-cascade', 'false');
    expect(hit).toHaveAttribute('data-flip', 'false');
    // The gem the player already turned over stays put; only the rest of the board turns.
    const shown = screen.getByRole('button', { name: 'Tile 3, Gem' });
    expect(shown).toHaveAttribute('data-cascade', 'false');
    expect(shown).toHaveAttribute('data-flip', 'false');
    expect(screen.getByRole('button', { name: 'Tile 14, Gem' })).toHaveAttribute(
      'data-flip',
      'true'
    );
    const delay = (name: string) =>
      parseFloat(screen.getByRole('button', { name }).style.animationDelay);
    // The ripple: the tile beside the mine turns before the far corner does.
    expect(screen.getByRole('button', { name: 'Tile 14, Gem' })).toHaveAttribute(
      'data-cascade',
      'true'
    );
    expect(delay('Tile 14, Gem')).toBe(70);
    expect(delay('Tile 25, Mine')).toBe(280);
    expect(delay('Tile 1, Gem')).toBe(280);
    expect(delay('Tile 25, Mine')).toBeGreaterThan(delay('Tile 14, Gem'));
    expect(cascadeDelay(0, 24, 70)).toBe(560);
    // Completion waits for the board itself, not for any single tile turning.
    fireEvent.animationEnd(hit);
    expect(onSettled).not.toHaveBeenCalled();
    fireEvent.animationEnd(screen.getByLabelText('Diamond Mines Board'));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('A Mine Ended The Round. Every Mine And Gem Is Revealed.')
    ).toBeTruthy();
  });
  it('cascades the whole board after a cash-out too, dimming nothing the player picked', () => {
    render(
      <MinesGrid
        roundId="r"
        picked={[0, 1]}
        mines={[7, 19, 23]}
        phase="cashed"
        busy={false}
        onPick={() => {}}
      />
    );
    expect(screen.getAllByRole('button', { name: /, Mine$/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Tile \d+$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Tile 2, Gem' })).toHaveAttribute(
      'data-picked',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Tile 8, Mine' })).toHaveAttribute(
      'data-picked',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Tile 8, Mine' })).toHaveAttribute(
      'data-hit',
      'false'
    );
    expect(screen.getByText('Win Booked. Every Mine And Gem Is Revealed.')).toBeTruthy();
    expect(screen.getAllByRole('button').every((tile) => tile.hasAttribute('disabled'))).toBe(true);
  });
  it('collapses the flip, the cascade and the blast under reduced motion in the stylesheet', () => {
    const css = readFileSync(
      join(__dirname, '../../src/components/games/MinesGrid.module.css'),
      'utf8'
    );
    expect(css).toContain("[data-flip='true']");
    expect(css).toContain("[data-hit='true']");
    expect(css).toContain('@keyframes tile-flip');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain(".tile[data-flip='true']");
    expect(reduced).toContain(".tile[data-hit='true']");
    expect(reduced).toMatch(/animation: none;/);
    expect(css).not.toContain(':hover');
    expect(css).not.toContain('—');
  });
});
