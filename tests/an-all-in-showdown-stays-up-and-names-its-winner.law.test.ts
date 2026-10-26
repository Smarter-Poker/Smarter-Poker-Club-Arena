/**
 * LAW (Dan 2026-10-24): "WHEN PLAYERS ARE ALL IN, ON THE RIVER, KEEP THE CARDS
 * SHOWN FOR 2 MORE SECONDS, AND PROPERLY DISPLAY AND ANNOUCE THE WINNING HANDS
 * BETTER..."
 *
 * 1. An all-in showdown holds HAND_COMPLETION.ALL_IN_SHOWDOWN_EXTRA_MS (2000)
 *    longer, after the winner is announced. The engine and the client each
 *    decide "all-in showdown" from the same fact and pass it to the same
 *    handCompletionHoldMs, so the felt and the engine stay equal; the beaten
 *    hands' muck waits the same two seconds.
 * 2. The board's band names WHO won ("Danimal Wins"), every tabled hand names
 *    itself at its seat, the winner's seat reads gold, and the band is a
 *    polite live region so the result is announced, not only painted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HAND_COMPLETION, handCompletionHoldMs } from '../src/config/handCompletionSpec';
import {
  isAllInShowdown,
  showdownHandNamesFrom,
  showdownWinnerLine,
} from '../src/lib/showdownPresentation';
import { isAllInShowdown as engineIsAllInShowdown } from '../server/src/engine/presentation/handEventFrames';

const read = (p: string) => readFileSync(p, 'utf8');

describe('an all-in showdown stays on the felt two seconds longer', () => {
  it('is two seconds', () => {
    expect(HAND_COMPLETION.ALL_IN_SHOWDOWN_EXTRA_MS).toBe(2000);
  });

  it('adds exactly two seconds to a showdown, heads-up or multiway', () => {
    for (const hands of [2, 3, 6, 9]) {
      const base = handCompletionHoldMs({ wentToShowdown: true, showdownHands: hands });
      const allIn = handCompletionHoldMs({
        wentToShowdown: true,
        showdownHands: hands,
        allInShowdown: true,
      });
      expect(allIn - base).toBe(2000);
    }
  });

  it('adds the two seconds on a run-it-multiple hand too', () => {
    const base = handCompletionHoldMs({ wentToShowdown: true, ritRuns: 2, ritStreetsPerRun: 1 });
    const allIn = handCompletionHoldMs({
      wentToShowdown: true,
      ritRuns: 2,
      ritStreetsPerRun: 1,
      allInShowdown: true,
    });
    expect(allIn - base).toBe(2000);
  });

  it('never touches a fold win or a Bad Beat Jackpot', () => {
    expect(handCompletionHoldMs({ wentToShowdown: false, allInShowdown: true })).toBe(
      handCompletionHoldMs({ wentToShowdown: false })
    );
    expect(handCompletionHoldMs({ wentToShowdown: true, bbjHit: true, allInShowdown: true })).toBe(
      HAND_COMPLETION.BBJ_CELEBRATION_MS
    );
  });

  it('is decided the same way by the engine and the client', () => {
    const shown = ['a', 'b'];
    expect(
      engineIsAllInShowdown(
        [{ userId: 'a' }, { userId: 'b' }],
        [
          { user_id: 'a', is_all_in: true },
          { user_id: 'b', is_all_in: false },
        ]
      )
    ).toBe(true);
    expect(
      isAllInShowdown(shown, [
        { id: 'a', status: 'all_in' },
        { id: 'b', status: 'active' },
      ])
    ).toBe(true);
    // Nobody all-in: an ordinary showdown keeps its ordinary pace.
    expect(
      engineIsAllInShowdown(
        [{ userId: 'a' }, { userId: 'b' }],
        [
          { user_id: 'a', is_all_in: false },
          { user_id: 'b', is_all_in: false },
        ]
      )
    ).toBe(false);
    expect(isAllInShowdown(shown, [{ id: 'a', status: 'active' }, null])).toBe(false);
    // An all-in player who did not reach showdown does not count.
    expect(isAllInShowdown(shown, [{ id: 'c', status: 'all_in' }])).toBe(false);
    // One hand is not a showdown.
    expect(isAllInShowdown(['a'], [{ id: 'a', status: 'all_in' }])).toBe(false);
    expect(engineIsAllInShowdown([{ userId: 'a' }], [{ user_id: 'a', is_all_in: true }])).toBe(
      false
    );
  });

  it('is wired into the engine hold', () => {
    const events = read('server/src/engine/ServerTableEngineHandEvents.ts');
    expect(events).toMatch(
      /this\.currentHandShowdownResults = normalizeShowdownResults\(\(event as any\)\.results\);[\s\S]{0,400}this\.currentHandAllInShowdown = isAllInShowdown\(/
    );
    const dealing = read('server/src/engine/ServerTableEngineDealing.ts');
    expect(dealing).toMatch(/allInShowdown: this\.currentHandAllInShowdown,/);
    expect(dealing).toMatch(/this\.currentHandAllInShowdown = false;/);
    const runout = read('server/src/engine/ServerTableEngineRunout.ts');
    expect(runout).toMatch(/this\.currentHandAllInShowdown = ritOrdered\.length >= 2;/);
  });

  it('is wired into the client hold and holds the beaten hands up as long', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/allInShowdown: handShowdownRef\.current\.allIn,/);
    expect(page).toMatch(
      /allIn: isAllInShowdown\([\s\S]{0,200}tableStateRef\.current\.players\s*\)/
    );
    expect(page).toMatch(
      /const muckBase =\s*\(2400 \+\s*\(handShowdownRef\.current\.allIn \? HAND_COMPLETION\.ALL_IN_SHOWDOWN_EXTRA_MS : 0\)\) \*/
    );
    expect(page).toMatch(
      /handShowdownRef\.current = \{ wentToShowdown: false, hands: 2, allIn: false \};/
    );
  });
});

describe('the winning hand is displayed and announced', () => {
  it('names who won', () => {
    expect(showdownWinnerLine(['Danimal'])).toBe('Danimal Wins');
    expect(showdownWinnerLine(['Danimal', 'Ace'])).toBe('Danimal And Ace Split The Pot');
    expect(showdownWinnerLine(['A', 'B', 'C'])).toBe('3 Players Split The Pot');
    expect(showdownWinnerLine(['', '  '])).toBe('');
    expect(showdownWinnerLine([])).toBe('');
    for (const line of [showdownWinnerLine(['A']), showdownWinnerLine(['A', 'B'])]) {
      expect(line).not.toMatch(/—|\$/);
    }
  });

  it('names every tabled hand and keeps a mucked hand private', () => {
    expect(
      showdownHandNamesFrom([
        { user_id: 'a', hand_name: 'Flush', mucked: false },
        { user_id: 'b', hand_name: 'Two Pair' },
        { user_id: 'c', hand_name: '', mucked: true },
        { user_id: 'd', hand_name: 'Pair', mucked: true },
      ])
    ).toEqual({ a: 'Flush', b: 'Two Pair' });
    expect(showdownHandNamesFrom(undefined)).toEqual({});
  });

  it('prints the winner on the band, as a live region', () => {
    const cc = read('src/components/table/CommunityCards.tsx');
    expect(cc).toMatch(
      /<div className="community-cards__hand-name" role="status" aria-live="polite">\s*\{winningPlayerLabel && \(/
    );
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/winningPlayerLabel=\{[\s\S]{0,300}showdownWinnerLine\(/);
  });

  it('names the beaten hands at their seats and paints the winner gold', () => {
    const seat = read('src/components/table/SeatSlot.tsx');
    expect(seat).toContain('className="seat__hand-name seat__hand-name--winner"');
    expect(seat).toMatch(/!isWinner &&\s*shownHandName &&\s*!isMuckedShowdown &&\s*!isMucking &&/);
    expect(seat).toMatch(/prev\.shownHandName !== next\.shownHandName/);
    const css = read('src/components/table/SeatSlot.css');
    expect(css).toMatch(/\.seat__hand-name--winner \{/);
    expect(css).toMatch(/\.seat__hand-name--shown \{/);
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/setShowdownHandNames\(showdownHandNamesFrom\(sdResultsForCount\)\)/);
    expect(page).toMatch(/shownHandName=\{[\s\S]{0,200}showdownHandNames\[player\.id\]/);
  });
  it('captures the all-in fact and holds Lightning before settlement releases its pool reservations', () => {
    const host = read('server/src/lightning/LightningHandHost.ts');
    expect(host).toContain(
      'this.allInShowdown = isAllInShowdown(this.showdown, this.hc?.getState().players)'
    );
    // 2026-10-26: the hold covers EVERY showdown (two or more hands shown),
    // not only all-in ones, and still carries the all-in fact into the same
    // shared hold - so an all-in showdown keeps exactly its two extra seconds.
    const hold = host.indexOf('if (this.showdown.length >= 2) {');
    const settle = host.indexOf('await this.settle(state, rake, bbj)', hold);
    expect(hold).toBeGreaterThan(0);
    expect(settle).toBeGreaterThan(hold);
    expect(host.slice(hold, settle)).toContain('handCompletionHoldMs({');
    expect(host.slice(hold, settle)).toContain('allInShowdown: this.allInShowdown');
  });
});
