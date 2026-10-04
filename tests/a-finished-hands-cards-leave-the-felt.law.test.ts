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
    const at = PAGE.indexOf('const completedHandNumber = tableStateRef.current.handNumber ?? 0;');
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

  it('the break hides cards only once the tables are parked, and never while a seat is on the clock', () => {
    const at = PAGE.indexOf('const breakHidesCards =');
    const rule = PAGE.slice(at, PAGE.indexOf(';', at));
    expect(rule).toMatch(/maintenanceBreak\.active/);
    expect(rule).toMatch(/maintenanceBreak\.phase !== 'last_hand'/);
    expect(rule).toMatch(/tableState\.currentPlayerSeat === 0/);
  });
});

describe('both surfaces obey it', () => {
  it('a seat is handed no cards for a finished hand or a parked break', () => {
    expect(PAGE).toMatch(
      /\(breakHidesCards \|\| \(displayPlayer\.isHero \? heroHandIsOver : tableHandIsOver\)\)\s*\) \{\s*displayPlayer = \{ \.\.\.displayPlayer, holeCards: \[\], showCards: false \};/
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
