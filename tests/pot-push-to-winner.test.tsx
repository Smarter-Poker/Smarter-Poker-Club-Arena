/**
 * Dan 2026-08-19, bug list item 6: "pot-push animation to the winner after
 * every hand showing chip amounts, not auto-advancing."
 *
 * Two defects, both of them silent:
 *
 *  1. The POT ITSELF never moved. `.pot-display--collect` and its
 *     --collect-dx / --collect-dy custom properties have been in the stylesheet
 *     since it was written, documented as "set by JS". Nothing in the codebase
 *     ever set them, so that animation had never run once - the pot number
 *     simply blinked out of existence at the end of every hand.
 *
 *  2. The chip fan mislabelled itself. A pot shipped to one winner is a fan of
 *     3-8 chips and EVERY chip carried a label of its own 1/Nth share, so a
 *     1,000 pot showed eight chips each reading "125".
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import PotDisplay from '../src/components/table/PotDisplay';
import {
  createChipToPotEvent,
  createPotToWinnerEvent,
} from '../src/components/table/ChipAnimation';

describe('PotDisplay pot push', () => {
  it('does not animate between hands', () => {
    const { container } = render(<PotDisplay mainPot={1000} />);
    const el = container.querySelector('.pot-display')!;
    expect(el.className).not.toContain('pot-display--collect');
    expect((el as HTMLElement).style.getPropertyValue('--collect-dx')).toBe('');
  });

  it('slides toward the winner, carrying the amount with it', () => {
    const { container } = render(<PotDisplay mainPot={1000} collectTo={{ dx: -120, dy: 260 }} />);
    const el = container.querySelector('.pot-display')! as HTMLElement;
    expect(el.className).toContain('pot-display--collect');
    expect(el.style.getPropertyValue('--collect-dx')).toBe('-120px');
    expect(el.style.getPropertyValue('--collect-dy')).toBe('260px');
    // The pot total is still on screen while it travels - that is the point.
    expect(container.textContent).toContain('1,000');
  });

  it('carries the direction of the seat it is pushed to', () => {
    const up = render(<PotDisplay mainPot={50} collectTo={{ dx: 0, dy: -200 }} />);
    expect(
      (up.container.querySelector('.pot-display') as HTMLElement).style.getPropertyValue(
        '--collect-dy'
      )
    ).toBe('-200px');
  });
});

describe('pot-to-winner chip fan', () => {
  const POT = 1000;
  const fan = createPotToWinnerEvent({ x: 100, y: 100 }, { x: 300, y: 400 }, POT);

  it('sends a fan of several chips', () => {
    expect(fan.length).toBeGreaterThanOrEqual(3);
    expect(fan.length).toBeLessThanOrEqual(8);
  });

  it('labels exactly ONE chip', () => {
    expect(fan.filter((c) => c.showLabel).length).toBe(1);
    expect(fan[0].showLabel).toBe(true);
  });

  it('that label reads the WHOLE amount shipped, not a share of it', () => {
    expect(fan[0].labelAmount).toBe(POT);
    // The chip's own value is still a share - that is what sizes and colours it.
    expect(fan[0].amount).toBeLessThan(POT);
  });

  it('every other chip is unlabelled', () => {
    for (const c of fan.slice(1)) expect(c.showLabel).toBe(false);
  });

  it('the chips still add up to the pot', () => {
    const total = fan.reduce((sum, c) => sum + c.amount, 0);
    expect(Math.abs(total - POT)).toBeLessThanOrEqual(fan.length); // rounding only
  });

  it('a split pot ships each winner their own share', () => {
    const half = createPotToWinnerEvent({ x: 0, y: 0 }, { x: 10, y: 10 }, POT / 2);
    expect(half[0].labelAmount).toBe(POT / 2);
  });
});

describe('bet-to-pot chip fan (same labelling rule)', () => {
  const BET = 100;
  const fan = createChipToPotEvent({ x: 10, y: 400 }, { x: 200, y: 200 }, BET);

  it('labels exactly one chip', () => {
    expect(fan.filter((c) => c.showLabel).length).toBe(1);
  });

  it('that label names the BET, not a quarter of it', () => {
    expect(fan[0].labelAmount).toBe(BET);
  });

  it('still splits the bet across the chips it draws', () => {
    const total = fan.reduce((sum, c) => sum + c.amount, 0);
    expect(Math.abs(total - BET)).toBeLessThanOrEqual(fan.length);
  });
});

/**
 * AUDIT 2026-08-25 — every flight id has to be unique, across fans.
 *
 * Both builders used to key on `Date.now()` plus the index WITHIN one fan, and
 * both callers build several fans inside a single tick: TablePage pushes one
 * fan per blind posted (so this collided on every hand that was dealt) and one
 * fan per winner of a split pot. Two flights sharing an id is not cosmetic -
 * `ChipAnimationManager` renders the list with `key={anim.id}`, and TablePage
 * reaps a landed flight with `prev.filter((a) => a.id !== id)`, so the first
 * chip to arrive deleted the other seat's chip out of the air.
 *
 * Asserted across fans built in the same millisecond, which is the case that
 * was broken; a single fan's ids were always distinct.
 */
describe('chip flights never share an id', () => {
  it('two fans built in the same tick are all distinct', () => {
    const sb = createChipToPotEvent({ x: 10, y: 400 }, { x: 200, y: 200 }, 1);
    const bb = createChipToPotEvent({ x: 40, y: 400 }, { x: 200, y: 200 }, 2);
    const ids = [...sb, ...bb].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a split pot does not collide two winners flights', () => {
    const a = createPotToWinnerEvent({ x: 0, y: 0 }, { x: 10, y: 10 }, 500);
    const b = createPotToWinnerEvent({ x: 0, y: 0 }, { x: 90, y: 10 }, 500);
    const ids = [...a, ...b].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('and a pot fan never collides with a bet fan', () => {
    const ids = [
      ...createChipToPotEvent({ x: 0, y: 0 }, { x: 1, y: 1 }, 25),
      ...createPotToWinnerEvent({ x: 0, y: 0 }, { x: 1, y: 1 }, 25),
    ].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a new hand must not inherit a pot mid-push', () => {
  it('collectTo=null renders a normal, fully visible pot', () => {
    const { container } = render(<PotDisplay mainPot={250} collectTo={null} />);
    const el = container.querySelector('.pot-display')!;
    expect(el.className).not.toContain('pot-display--collect');
    expect(container.textContent).toContain('250');
  });
});
