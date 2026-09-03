/**
 * ═══ THE DEAD TABLE'S NAME FOLLOWED YOU AROUND THE APP (2026-08-29) ════════
 *
 * Observed on production: left a table, landed on /clubs/club-jaqk, and the
 * browser tab still read "NLH Micro .10/.20 | Smarter Poker".
 *
 * `useTableEnvironment` set the title and deliberately did NOT restore it,
 * on the stated grounds that "MultiTablePage's YOUR TURN badge effect owns
 * the restore". That premise is false. The badge effect restores only a title
 * IT badged, and it only badges while the tab is hidden AND a real turn is
 * live — so in the ordinary case nothing restores anything. Club Arena's
 * lobby routes set no title of their own, so the stale name persisted into
 * every subsequent page and into any bookmark made from one.
 *
 * The fix has to coexist with the badge effect rather than fight it, so the
 * restore is conditional: put the title back ONLY if it is still the exact
 * string we wrote. These beats pin both halves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '../../src/hooks/useTableEnvironment.ts'), 'utf8');

/** The title effect's body, isolated so neighbouring effects cannot satisfy these. */
const titleEffect = (() => {
  const start = src.indexOf('const ours = name ?');
  const end = src.indexOf('}, [tableId, displayName, isActive]);');
  return start >= 0 && end > start ? src.slice(start, end) : '';
})();

describe('the table title is handed back when the table goes away', () => {
  it('the title effect has a cleanup at all', () => {
    expect(
      titleEffect.length > 0,
      'the title effect changed shape — re-point this test before trusting it'
    ).toBe(true);
    expect(
      /return \(\) => \{/.test(titleEffect),
      'no cleanup: the dead table name follows the player around the app again'
    ).toBe(true);
  });

  it('captures the previous title BEFORE overwriting it', () => {
    expect(titleEffect.indexOf('const previous = document.title;')).toBeGreaterThan(-1);
    expect(
      titleEffect.indexOf('const previous = document.title;'),
      'the previous title is captured after it was already overwritten — it would restore our own string'
    ).toBeLessThan(titleEffect.indexOf('document.title = ours;'));
  });

  it('restores ONLY when still the last writer — so it cannot fight the badge effect', () => {
    expect(
      /if \(document\.title === ours\) document\.title = previous;/.test(titleEffect),
      'the restore is unconditional — it would clobber the YOUR TURN badge (or another table, ' +
        'or a route that set its own title) on unmount'
    ).toBe(true);
  });
});

describe('the restore rule, as logic', () => {
  /** Exactly what the cleanup does. */
  const restore = (current: string, ours: string, previous: string) =>
    current === ours ? previous : current;

  it('hands the lobby its title back when nothing else has written', () => {
    expect(
      restore(
        'NLH Micro .10/.20 | Smarter Poker',
        'NLH Micro .10/.20 | Smarter Poker',
        'Home | Smarter Poker'
      )
    ).toBe('Home | Smarter Poker');
  });

  it('leaves a badged title alone', () => {
    expect(
      restore(
        'YOUR TURN - nlh 0.1/0.2',
        'NLH Micro .10/.20 | Smarter Poker',
        'Home | Smarter Poker'
      )
    ).toBe('YOUR TURN - nlh 0.1/0.2');
  });

  it('leaves another table’s title alone', () => {
    expect(
      restore(
        'PLO5 1.00/2.00 | Smarter Poker',
        'NLH Micro .10/.20 | Smarter Poker',
        'Home | Smarter Poker'
      )
    ).toBe('PLO5 1.00/2.00 | Smarter Poker');
  });
});
