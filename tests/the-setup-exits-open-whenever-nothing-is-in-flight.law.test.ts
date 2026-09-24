/**
 * THE SETUP'S EXITS OPEN WHENEVER NOTHING IS IN FLIGHT (review 2026-09-22).
 *
 * Owner rules: never trap the player on a page that cannot progress, while
 * money in flight holds the page; a won game starts itself. The exit guard
 * (useLiveBonusGuard) holds a won game that could start so that it can start
 * itself, and BonusSetup's own exits navigated straight into it. On Donkey
 * Cross, Mines, Plinko and Crash the Double Down offer's Buy More, shown to a
 * player short of the diamonds to double, answered "Finish Your Bonus Game
 * Before Leaving." and opened nothing; so did Buy More and Earn Diamonds under
 * the award.
 *
 * The setup now cannot navigate by itself. Every exit leaves through the page's
 * leave(to), which lets go of the hold and navigates, and the setup never calls
 * it while disabled. Every page disables the setup while a start, a replay or a
 * re-send is out and takes it off screen while a round is on the board, so no
 * exit is ever taken with money in flight. Behaviour: DiamondChoiceExits and
 * BonusSetupExits under tests/components.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
/** Source without comments: history may be explained, never counted. */
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const SETUP = 'src/components/games/BonusSetup.tsx';
/** Every page that renders the shared setup. */
const PAGES = readdirSync(join(ROOT, 'src/pages'))
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => `src/pages/${f}`)
  .filter((p) => code(p).includes('<BonusSetup'));
/** The setup element as a page renders it. */
const setupElement = (src: string) => {
  const from = src.indexOf('<BonusSetup');
  return src.slice(from, src.indexOf('/>', from));
};

describe('the setup exits open whenever nothing is in flight', () => {
  it('is rendered by the three games a wheel award opens', () => {
    expect([...PAGES].sort()).toEqual([
      'src/pages/DiamondChoicePage.tsx',
      'src/pages/DiamondCrashPage.tsx',
      'src/pages/DiamondPlinkoPage.tsx',
    ]);
  });

  it('cannot navigate by itself: every exit leaves through the page, and never while disabled', () => {
    const setup = code(SETUP);
    expect(setup).not.toMatch(/useNavigate|navigate\(/);
    // Required, so a page that renders the setup cannot leave it out.
    expect(setup).toMatch(/\n\s*leave: \(to: string\) => void;/);
    expect(setup).toMatch(/if \(!disabled\) leave\(to\);/);
    for (const to of [
      '`/clubs/${clubId}/wheel`',
      "'/marketplace?tab=diamonds'",
      '`/clubs/${clubId}/earn-diamonds`',
    ])
      expect(setup).toContain(`exit(${to})`);
    expect(setup).toContain("onBuyMore={() => exit('/marketplace?tab=diamonds')}");
  });

  it.each(PAGES)(
    '%s lets go of its hold before it leaves, and only when nothing is in flight',
    (page) => {
      const src = code(page);
      expect(src).toMatch(/const releaseGuard = useLiveBonusGuard\(/);
      // Never with a start, a replay or a cash-out out, even one the page has
      // not drawn yet: the ref is set before the request leaves.
      expect(src).toMatch(/if \(busyRef\.current\) return;\s*releaseGuard\(\);\s*navigate\(to\);/);
      const setup = setupElement(src);
      expect(setup).toMatch(/\bleave=\{/);
      // Disabled while a replay or a lost answer is settling and while a refused
      // ticket's wager is being sent again.
      expect(setup).toMatch(/disabled=\{[^}]*\buncertain\b[^}]*\brestartOwed\b[^}]*\}/);
      // Rendered on a condition: never while a round is on the board.
      expect(src).toMatch(/setup=\{\s*![\w.]+ &&[\s\S]{0,120}<BonusSetup/);
    }
  );
});
