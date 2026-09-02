/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHAT THE "ALL" TAB SHOWS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-25, answering an audit that asked him to decide:
 *
 *   "WE DON'T HAVE MIXED CASH GAMES, AND THE CAP IS 10 FOR MTT ONLY.
 *    SPINS AND HEADS UP (SNG) SHOULD NEVER BE ON THE ALL LIST."
 *
 * Three rules. Each one had already been broken once by a change that looked
 * local, and each failure is silent on screen — a missing row does not throw,
 * and nobody counts the lobby. So they are pinned here.
 *
 * 1. EVERY CASH TABLE. The list used to be assembled from three explicit
 *    buckets (cashKind === HOLDEM / OMAHA / LIMIT), which dropped whatever
 *    landed in MIXED. MIXED is not a game this platform runs; it is the
 *    fallback cashKind() returns for a variant it does not recognise, and on
 *    2026-08-25 production was running five `pineapple` tables that matched
 *    none of its tests. Those five were on no tab in the app at all: not on
 *    ALL, and there is no Mixed tab. Any future variant would vanish the same
 *    way.
 *
 * 2. THE CAP IS 10, AND IT IS THE MTT CAP. Each cash bucket was capped at 10
 *    too, so a club with 42 NLH tables showed ten of them with nothing on
 *    screen saying so.
 *
 * 3. SPINS AND HEADS UP NEVER APPEAR HERE. They have their own tabs, they are
 *    seat-first rather than browse-first, and a Spin has no lobby — tapping
 *    one commits the buy-in.
 *
 * These read the source rather than rendering it because the rules live in one
 * `useMemo` inside a 3,200-line page component; a source assertion that names
 * the rule is worth more here than a render test that would need the whole
 * club-loading machinery stood up to reach the same three lines.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sliceBlockAfter } from '../helpers/sourceWindow';

const src = readFileSync(path.resolve(__dirname, '../..', 'src/pages/ClubHomePage.tsx'), 'utf8');

/** The ALL branch of the lobbyEntries memo. */
const allBranch = (() => {
  const start = src.indexOf("if (gameType === 'ALL') {");
  expect(start, 'the ALL branch of lobbyEntries has moved or been renamed').toBeGreaterThan(-1);
  expect(
    src.indexOf('return [...selectedTourns, ...cash];', start),
    'the ALL branch no longer ends by returning tournaments then cash'
  ).toBeGreaterThan(start);
  return sliceBlockAfter(src, "if (gameType === 'ALL') {");
})();

describe('the ALL tab shows every cash game', () => {
  it('does not filter cash by cashKind', () => {
    expect(
      /cash\.filter\([^)]*cashKind/.test(allBranch),
      'cash is being bucketed by cashKind again, which silently drops the MIXED bucket'
    ).toBe(false);
  });

  it('does not cap cash', () => {
    // Only ONE slice in this branch, and it is the tournament one.
    const slices = allBranch.match(/\.slice\(/g) || [];
    expect(slices.length, 'a second .slice() in the ALL branch means cash is capped again').toBe(1);
    expect(allBranch).toMatch(/selectedTourns[\s\S]{0,200}?\.slice\(0, ALL_TAB_MTT_CAP\)/);
  });

  it('passes the whole cash list through', () => {
    expect(allBranch).toContain('return [...selectedTourns, ...cash];');
  });
});

describe('the ALL tab caps tournaments at ten, and only tournaments', () => {
  it('uses the named cap', () => {
    expect(src).toContain('const ALL_TAB_MTT_CAP = 10;');
    expect(allBranch).toContain('.slice(0, ALL_TAB_MTT_CAP)');
  });
});

describe('Spins and Heads Up are never on the ALL list', () => {
  it('keeps only mtt entries from the tournament side', () => {
    expect(allBranch).toContain("const isMtt = (e: LobbyEntry) => e.kind === 'mtt';");
    expect(allBranch).toMatch(/\.filter\(\(t\) => isMtt\(t\) && isLateRegOrStarting\(t\)\)/);
  });

  it('never names spin or sng as something to include', () => {
    expect(/kind === 'spin'/.test(allBranch)).toBe(false);
    expect(/kind === 'sng'/.test(allBranch)).toBe(false);
  });
});

describe('cashKind classifies every variant the platform deals', () => {
  /* GameVariant in database.types.ts is the whole set. Each must reach a real
     bucket, because MIXED has no tab and is only reachable from ALL. */
  const cashKindBody = (() => {
    const start = src.indexOf('function cashKind(');
    const end = src.indexOf("return 'MIXED';", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  })();

  it.each([
    ['nlh', 'nlh'],
    ['short_deck', 'short'],
    ['pineapple', 'pineapple'],
    ['plo4 / plo5 / plo6 / plo8', 'plo'],
  ])('%s is classified before the MIXED fallback', (_variant, needle) => {
    expect(cashKindBody).toContain(`v.includes('${needle}')`);
  });
});

describe('the game bar does not offer a control that does nothing', () => {
  it('opens the sheet in sort-only mode on ALL', () => {
    expect(src).toContain("sortOnly={gameType === 'ALL'}");
  });

  it('labels the button Sort on ALL', () => {
    expect(src).toContain("aria-label={gameType === 'ALL' ? 'Sort' : 'Filters And Sort'}");
    expect(src).toContain("<span>{gameType === 'ALL' ? 'Sort' : 'Filters'}</span>");
  });

  it('the sheet hides the type tabs and every filter section in that mode', () => {
    const sheet = readFileSync(
      path.resolve(__dirname, '../..', 'src/components/lobby/AdvancedFilters.tsx'),
      'utf8'
    );
    expect(sheet).toContain('sortOnly?: boolean;');
    expect(sheet).toContain('{!sortOnly && (');
    expect(sheet).toContain('{!sortOnly && spec && (');
    // Sort By itself must NOT be behind the flag — it is the whole point.
    expect(sheet).toMatch(/\{sortOptions && onSortChange && \(/);
  });
});
