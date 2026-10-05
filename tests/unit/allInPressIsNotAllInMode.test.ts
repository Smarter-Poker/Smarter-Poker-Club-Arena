/**
 * AN ALL IN PRESS DOES NOT PROVE THE HERO IS ALL IN (2026-10-04)
 *
 * Since the engine plays an ALL IN press as a CALL where only a call is legal
 * (server AnAllInPressCountsAsACall.law), the button can no longer switch the
 * table into all-in mode or count a preflop raise on its own: the vignette and
 * dimmed stack stayed up over a player with chips behind until their next
 * turn, and a call was counted as a raise. Both now follow the engine's echo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const PAGE = strip(readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8'));

describe('the ALL IN button', () => {
  const start = PAGE.indexOf("        case 'allin':\n          if (heroStack <= 0) return;");
  const press = PAGE.slice(start, PAGE.indexOf('break;', start));

  it('sends the action without declaring all-in mode itself', () => {
    expect(start).toBeGreaterThan(-1);
    expect(press).toMatch(/submitActionWithToast\(/);
    expect(press).not.toMatch(/setIsAllInMode\(/);
  });

  it('does not count a preflop raise from the button; a sized raise still does', () => {
    expect(PAGE).toMatch(/if \(action === 'raise'\) heroPfrThisHandRef\.current = true;/);
    expect(PAGE).not.toMatch(/action === 'allin'\) heroPfrThisHandRef\.current = true/);
  });

  it('the optimistic all_in label does not count a preflop raise; only bet or raise does', () => {
    expect(PAGE).toMatch(
      /if \(act === 'bet' \|\| act === 'raise'\) heroPfrThisHandRef\.current = true;/
    );
    expect(PAGE).not.toMatch(/if \(act !== 'call'\) heroPfrThisHandRef\.current = true;/);
  });

  it("the hero's own all_in echo preflop is what counts the shove as a raise", () => {
    expect(PAGE).toMatch(
      /if \(actionSeat === st\.heroSeat && st\.boardStage === 'preflop'\) \{\s*heroPfrThisHandRef\.current = true;/
    );
  });

  it('a finished hand does not keep the showing lift', () => {
    expect(PAGE).toMatch(/!feltShowsNoHand &&\s*player\?\.holeCards\?\.length &&/);
  });

  it("the engine's own echo is what turns all-in mode on", () => {
    expect(PAGE).toMatch(/if \(!heroStillHasAction\) setIsAllInMode\(true\);/);
  });
});
