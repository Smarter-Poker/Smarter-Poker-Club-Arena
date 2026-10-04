/**
 * A FINISHED HAND'S CARDS LEAVE THE FELT (Dan 2026-10-04)
 *
 * "CARDS FROM THE HAND WHEN THE MAINTENANCE BREAK STILL SHOW DURING THE
 *  BREAK. THEY SHOULD NOT BE DISPLAYED WHEN ON BREAK OR WHEN THE HAND IS
 *  OVER."
 *
 * The post-hand reset wiped the board, the pot and the winner and never
 * touched anybody's hole cards; only the NEXT deal replaced them. When no next
 * hand came - the hourly break parks every table at a hand boundary - the last
 * hand sat on the felt and on the tab pill for the whole break.
 *
 * The other half of this law is the older, louder one (2026-08-26): "hero can
 * NEVER EVER EVER lose access to seeing their hole cards". So what is hidden
 * is one IDENTIFIED finished hand, and the pins below are mostly about the
 * ways that could go wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const PAGE = strip(readFileSync(resolve(root, 'src/pages/TablePage.tsx'), 'utf8'));

describe('the reset that ends a hand records which hand ended', () => {
  it('names the hand when HAND_COMPLETE lands, not when the (movable) reset finally runs', () => {
    const at = PAGE.indexOf('const feltHandNumber = tableStateRef.current.handNumber ?? 0;');
    const fn = PAGE.indexOf('handCompleteResetFnRef.current = () => {');
    expect(at).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(at);
    // Read OUTSIDE the reset closure, so it is the hand HAND_COMPLETE named.
    expect(PAGE.slice(at, fn)).not.toMatch(/=> \{/);
    const body = PAGE.slice(fn, PAGE.indexOf('setStackHoldReleased(true);', fn));
    expect(body).toMatch(
      /if \(completedHandNumber > 0\) \{\s*setFinishedHand\(\{ handNumber: completedHandNumber, heroSig: completedHeroSig \}\);/
    );
    // Nothing else may ever mark a hand finished.
    expect(PAGE.match(/setFinishedHand\(/g)).toHaveLength(1);
  });

  it('an event about another hand than the one on the felt marks nothing', () => {
    // A replayed or late hand_complete must never name the LIVE hand finished.
    expect(PAGE).toMatch(
      /const completedHandNumber =\s*eventHandNumber > 0 && feltHandNumber > 0 && eventHandNumber !== feltHandNumber\s*\? 0\s*: feltHandNumber;/
    );
    expect(PAGE).toMatch(/\?\.hand_number\) \|\| 0;/);
  });

  it('never clears the cards in state: the recovery reads and the snapshot merge keep what they had', () => {
    const fn = PAGE.indexOf('handCompleteResetFnRef.current = () => {');
    const end = PAGE.indexOf('setStackHoldReleased(true);', fn);
    expect(PAGE.slice(fn, end)).not.toMatch(/holeCards/);
  });
});

describe('a hand is hidden only while it is provably the finished one', () => {
  it('the table test is the hand number; the hero test is the hand number AND their own cards', () => {
    expect(PAGE).toMatch(
      /const tableHandIsOver =\s*finishedHand !== null && \(tableState\.handNumber \?\? 0\) === finishedHand\.handNumber;/
    );
    expect(PAGE).toMatch(
      /const heroHandIsOver = tableHandIsOver && heroHoleSigNow === finishedHand!\.heroSig;/
    );
  });

  it('the break hides cards only on a parked felt with nothing in the middle and nobody being paid', () => {
    // `currentPlayerSeat === 0` alone is not "parked": it is 0 between every
    // two actions, through every runout and for the whole result hold, and the
    // countdown starts at :55 whether or not this table's hand has finished.
    const at = PAGE.indexOf('const breakHidesCards =');
    const rule = PAGE.slice(at, PAGE.indexOf(';', at));
    expect(rule).toMatch(/maintenanceBreak\.active/);
    expect(rule).toMatch(/maintenanceBreak\.phase !== 'last_hand'/);
    expect(rule).toMatch(/tableState\.currentPlayerSeat === 0/);
    expect(rule).toMatch(/\(tableState\.pot \|\| 0\) === 0/);
    expect(rule).toMatch(/tableState\.communityCards\.length === 0/);
    expect(rule).toMatch(/winnerInfo\.playerIds\.length === 0/);
  });
});

describe('both surfaces obey it', () => {
  it('a seat is handed no cards for a finished hand or a parked break', () => {
    expect(PAGE).toMatch(
      /\(breakHidesCards \|\| \(displayPlayer\.isHero \? heroHandIsOver : tableHandIsOver\)\)\s*\) \{\s*displayPlayer = \{\s*\.\.\.displayPlayer,\s*holeCards: \[\],\s*showCards: false,/
    );
    // ...and that is the player the seat is given.
    const gate = PAGE.indexOf('displayPlayer.isHero ? heroHandIsOver : tableHandIsOver');
    const seat = PAGE.indexOf('player={displayPlayer}');
    expect(seat).toBeGreaterThan(gate);
  });

  it('the tab pill reports no cards for a finished hand or a parked break', () => {
    const at = PAGE.indexOf('const heroTabCards = useMemo(');
    const memo = PAGE.slice(at, PAGE.indexOf(']);', at));
    expect(memo).toMatch(/if \(heroHandIsOver \|\| breakHidesCards\) return '';/);
    expect(memo).toMatch(/heroHandIsOver,\s*breakHidesCards,/);
  });
});

describe('the whole seat lets go of the hand, not only its two cards', () => {
  it('no fan of card backs, no all-in pose and no hand label outlive it', () => {
    expect(PAGE).toMatch(/const feltShowsNoHand = tableHandIsOver \|\| breakHidesCards;/);
    expect(PAGE).toMatch(
      /handInPlay=\{\s*\(tableState\.isHandInProgress \|\| \(tableState\.handNumber \?\? 0\) > 0\) &&\s*!feltShowsNoHand\s*\}/
    );
    expect(PAGE).toMatch(
      /status: displayPlayer\.status === 'all_in' \? 'active' : displayPlayer\.status,/
    );
    expect(PAGE).toMatch(
      /handStrength=\{\s*displayPlayer\?\.isHero && !heroHandIsOver && !breakHidesCards\s*\? heroHandStrength\s*: null\s*\}/
    );
  });
});
