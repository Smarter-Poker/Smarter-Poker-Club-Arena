/**
 * Dan 2026-08-30, two rulings from the live Sunday $200:
 *
 * 1. "A PLAYER NEVER NEEDS TO 'SHOW HIS CARDS' IN A TOURNAMENT, ANYTIME THERE
 *    IS AN ALL IN, ALL CARDS ARE ALWAYS SHOW[N]... YOU SHOULD NEVER SEE THE
 *    'SHOW CARDS' BUTTON ON AN ALL IN DURING A TOURNAMENT."
 * 2. "ONCE THE HAND IS COMPLETED, THE 0% 100% SHOULD DISAPPEAR AFTER HALF A
 *    SECOND, AND THE PLAYER WITH NO CHIPS INSTANTLY REMOVED... BUSTED PLAYERS
 *    ARE 'LINGERING' WAY TO LONG ON THE TABLE."
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceBetween } from '../helpers/sourceWindow';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLE = fs.readFileSync(path.join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
const DEALING = fs.readFileSync(
  path.join(ROOT, 'server/src/engine/ServerTableEngineDealing.ts'),
  'utf8'
);
const MANAGER = fs.readFileSync(
  path.join(ROOT, 'server/src/tournament/TournamentManager.ts'),
  'utf8'
);

describe('an all-in tournament showdown never offers the Show Hand button', () => {
  it('the showdown bar condition consults the all-in flag and isTournament', () => {
    const bar = sliceBetween(TABLE, "boardStage === 'showdown' &&", 'Show Hand');
    expect(bar).toMatch(/isTournament && handHadAllInRef\.current/);
  });

  it('the flag survives the post-hand hold and resets only at the next deal', () => {
    // Set on the first all_in_equity broadcast…
    const setSite = sliceBetween(TABLE, "eventType === 'all_in_equity'", 'return;');
    expect(setSite).toMatch(/handHadAllInRef\.current = true/);
    // …cleared where the NEW hand clears its predecessor's state.
    const clearSite = sliceBetween(TABLE, 'setAllInEquities([]);\n        handHadAllInRef', ';');
    expect(clearSite).toMatch(/handHadAllInRef\.current = false/);
  });
});

describe('the equity overlay gets half a second after the hand, no more', () => {
  it('HAND_COMPLETE arms a 500ms clear of the all-in equities', () => {
    const block = sliceBetween(TABLE, 'DISAPPEAR AFTER HALF A SECOND', 'handCompleteResetAtRef');
    expect(block).toMatch(/setTimeout\(\(\) => \{\s*setAllInEquities\(\[\]\);\s*\}, 500\)/);
  });
});

describe('a busted tournament seat is vacated the moment the hand settles', () => {
  it('the dealing loop vacates stack-0 seats with the rebuy race guard', () => {
    const block = sliceBetween(DEALING, 'BUSTED PLAYERS DO NOT LINGER', 'catch (vacateThrew)');
    expect(block).toMatch(/\.is\('left_at', null\)/);
    expect(block).toMatch(/\.lte\('stack', 0\)/);
  });

  it('the seating sweep never hands a zero-chip playing entrant a free stack', () => {
    // The old fallback seated chips<=0 'playing' entrants with startingChips —
    // unreachable while busted players kept their seats, a chip mint the
    // moment they do not.
    const block = sliceBetween(
      MANAGER,
      "A ZERO-CHIP 'playing' ENTRANT IS NOT SEATABLE",
      'const playerChips'
    );
    expect(block).toMatch(/continue;/);
    const chips = sliceBetween(MANAGER, 'const playerChips', ';');
    expect(chips).not.toMatch(/<= 0\s*\?\s*startingChips/);
  });
});
