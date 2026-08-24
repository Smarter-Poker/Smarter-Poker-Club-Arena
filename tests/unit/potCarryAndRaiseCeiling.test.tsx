/**
 * Two ways the table showed the player a number that was not true.
 *
 * 1. THE POT PILL CARRIED THE PREVIOUS HAND'S POT.
 *    PotDisplay keeps the last non-zero pot so the amount stays readable while
 *    the pot slides to the winner. That ref was only ever assigned, and the
 *    component stays mounted for the life of the table, so it never expired.
 *    The failing shape is the commonest hand in poker: a big pot, then a hand
 *    that folds around preflop. Preflop the blinds are still in FRONT of the
 *    seats, so mainPot === streetBets and the collected pot is 0 for the whole
 *    hand - which is exactly the branch that falls back to the carried value.
 *    The pill announced the old pot sliding to someone who won the blinds.
 *
 * 2. A RAISE-TO WAS CLAMPED AGAINST CHIPS BEHIND.
 *    The engine's `raise` carries an absolute raise-TO. The submit path clamped
 *    it with Math.min(amount, heroStack) - chips behind - so a hero with chips
 *    already in front silently raised less than the button said, and when
 *    nearly committed could be clamped BELOW the min-raise, which the engine
 *    rejects outright while the clock keeps running.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PotDisplay from '../../src/components/table/PotDisplay';

describe('the pot pill never shows a previous hand amount', () => {
  it('drops the carried amount as soon as the hand number changes', () => {
    // Hand 7 collects 5000: mainPot 5000 with nothing in front.
    const { rerender, container } = render(
      <PotDisplay mainPot={5000} streetBets={0} handNumber={7} />
    );
    expect(container.textContent).toContain('5,000');

    // Hand 8 folds around preflop. Blinds are still in front, so the COLLECTED
    // pot is zero all hand, and the push sets collectTo - the carried branch.
    rerender(
      <PotDisplay mainPot={15} streetBets={15} handNumber={8} collectTo={{ dx: 40, dy: -60 }} />
    );

    // Assert the aria-label, not the digits. The visible number goes through
    // <AnimatedNumber>, which TWEENS from its previous value - so on the first
    // frame it still reads 5,000 whatever the true pot is, and asserting the
    // text would be measuring an animation rather than the value. The label is
    // rendered straight from displayPot and is what a screen reader announces.
    const pill = container.querySelector('.pot-display');
    expect(
      pill?.getAttribute('aria-label'),
      'the pot is carrying the previous hand amount into this hand'
    ).toContain('Pot: 0');
  });

  it('still carries the amount WITHIN a hand, which is what the ref is for', () => {
    const { rerender, container } = render(
      <PotDisplay mainPot={5000} streetBets={0} handNumber={7} />
    );
    // Same hand: the snapshot zeroes the pot as the push begins. The amount must
    // survive, or the pot travels to the winner reading nothing.
    rerender(
      <PotDisplay mainPot={0} streetBets={0} handNumber={7} collectTo={{ dx: 40, dy: -60 }} />
    );
    const pill = container.querySelector('.pot-display');
    expect(
      pill?.getAttribute('aria-label'),
      'the pot lost its amount mid-push, so it travels to the winner reading nothing'
    ).toContain('Pot: 5,000');
  });
});

describe('a raise-to is clamped against the raise-to ceiling', () => {
  const SRC = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

  it('never clamps the raise amount against chips behind', () => {
    // heroStack is chips BEHIND; a raise carries an absolute raise-TO. Both are
    // `number`, so Math.min compiles and silently truncates.
    //
    // Comments stripped first: the fix documents the old expression by name, and
    // scanning raw source flagged that explanation as the bug it describes.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(
      code.includes('Math.min(amount, heroStack)'),
      'the raise is being clamped against chips behind, not the raise-to ceiling'
    ).toBe(false);
  });

  it('clamps against stack plus what hero already has in front this street', () => {
    expect(SRC).toMatch(/const heroAllInTo = heroStack \+ heroBet;/);
    expect(SRC).toMatch(/Math\.min\(amount, heroAllInTo\)/);
  });
});
