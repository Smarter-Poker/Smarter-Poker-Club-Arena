/**
 * A SHORT ALL-IN NEVER OFFERS A RAISE (Dan 2026-10-22, binding).
 *
 * "RAISING, WHEN YOU CAN'T RAISE AND CAN 'ONLY CALL' SHOULD NEVER BE AN
 * OPTION, IT SHOULD ONLY GIVE YOU 'CALL OR FOLD'."
 *
 * The hand behind it: the hero bet 53.50, a short stack shoved 63.49 (a
 * 9.99 raise, under the 53.50 a full raise needs), the action came back, and
 * the bar opened a raise slider the engine would refuse.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { heroMayReopenBetting } from '../src/lib/raiseReopen';
import { ActionPanel } from '../src/components/table/ActionPanel';

const base = {
  currentBet: 63.49,
  heroBet: 53.5,
  raiseIncrement: 53.5,
  bigBlind: 1,
  isFixedLimit: false,
};

describe('the reopen rule the engine enforces', () => {
  it('a short all-in over the hero bet does not reopen it', () => {
    expect(heroMayReopenBetting({ ...base, heroLastAction: 'bet' })).toBe(false);
  });

  it('a full raise over the hero bet reopens it', () => {
    expect(
      heroMayReopenBetting({
        ...base,
        heroLastAction: 'bet',
        currentBet: 107,
        raiseIncrement: 53.5,
      })
    ).toBe(true);
  });

  it('a hero who has not acted this street keeps the raise (blind option included)', () => {
    expect(heroMayReopenBetting({ ...base, heroLastAction: null })).toBe(true);
  });

  it('a checker facing a full bet may raise; facing a short all-in under the blind may not', () => {
    expect(
      heroMayReopenBetting({
        ...base,
        heroLastAction: 'check',
        heroBet: 0,
        currentBet: 10,
        raiseIncrement: 10,
      })
    ).toBe(true);
    expect(
      heroMayReopenBetting({
        ...base,
        heroLastAction: 'check',
        heroBet: 0,
        currentBet: 0.5,
        raiseIncrement: 1,
      })
    ).toBe(false);
  });

  it('fixed limit reopens on half the street bet', () => {
    const fl = {
      ...base,
      isFixedLimit: true,
      fixedBetSize: 10,
      heroLastAction: 'bet',
      heroBet: 10,
    };
    expect(heroMayReopenBetting({ ...fl, currentBet: 14 })).toBe(false);
    expect(heroMayReopenBetting({ ...fl, currentBet: 15 })).toBe(true);
  });

  it('keeps the dealt hand minimum when the next tournament level is announced', () => {
    const hand = {
      heroLastAction: 'check',
      heroBet: 0,
      currentBet: 1000,
      raiseIncrement: 1000,
      bigBlind: 1200,
      isFixedLimit: false,
    };
    expect(heroMayReopenBetting(hand)).toBe(true);
    expect(heroMayReopenBetting({ ...hand, currentBet: 999 })).toBe(false);
    // A stale lower metadata blind cannot weaken a full-raise requirement.
    expect(heroMayReopenBetting({ ...hand, bigBlind: 800, currentBet: 999 })).toBe(false);
  });

  it.each([undefined, 0, -1, Number.NaN, Infinity, -Infinity])(
    'uses the legacy blind only when the published increment is unavailable or invalid (%s)',
    (raiseIncrement) => {
      const hand = {
        heroLastAction: 'check',
        heroBet: 0,
        currentBet: 1000,
        raiseIncrement: raiseIncrement as number,
        bigBlind: 1000,
        isFixedLimit: false,
      };
      expect(heroMayReopenBetting(hand)).toBe(true);
      expect(heroMayReopenBetting({ ...hand, currentBet: 999 })).toBe(false);
    }
  );
});

describe('the bar offers Fold and Call only', () => {
  it('draws no Raise or All In button when no wager is legal', () => {
    render(
      <ActionPanel
        canFold
        canCheck={false}
        canCall
        canRaise={false}
        canAllIn={false}
        callAmount={9.99}
        minRaise={117}
        maxRaise={166}
        allInTo={166}
        pot={243.97}
        bigBlind={1}
        smallBlind={0.5}
        currentBet={63.49}
        isMyTurn
        onAction={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Fold')).toBeTruthy();
    expect(screen.getByLabelText(/^Call /)).toBeTruthy();
    expect(screen.queryByLabelText(/Raise Panel|Bet Panel/)).toBeNull();
    expect(screen.queryByLabelText('All In')).toBeNull();
  });

  it('both TablePage wager gates read the reopen rule', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');
    expect(src.match(/heroMayReopenBetting\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/!wagersCapped && mayReopen/);
    expect(src).toMatch(/\(mayReopen \|\| allInTo <= serverCurrentBet \+ 0\.005\)/);
  });
});
