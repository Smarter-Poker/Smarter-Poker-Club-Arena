/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A KNOCKOUT PAYS EVERY WINNER OF THE POT, AND SAYS THE EXACT AMOUNT
 *  (knockout audit 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two display defects found by reading production against the code:
 *
 * 1. SPLIT KNOCKOUTS. Since the 2026-08-31 ruling `fn_collect_bounty` splits a
 *    tied pot's bounty by claim weight and reports `shares`, one row per
 *    winner. The engine kept broadcasting the TOTAL under ONE `knockerUserId`,
 *    so the client flew the whole bounty to one of the two winners and drew
 *    nothing at the other; in a PKO it put the whole `addedToHead` on one
 *    badge. 55 split knockouts in production between 08-30 and 09-04, every
 *    one animated wrong. Fixed by sending `shares` and reading them through
 *    ONE helper (`bountyWinnersOf`) that the glove, the money and the head
 *    badge all ask.
 *
 * 2. THE "+N" FLOAT ROUNDED CENTS AWAY. `spawnPotWinFloat` labelled with
 *    `Math.round(amount)` for anything >= 1, so a 7.50 bounty floated up as
 *    "+8" beside a seat delta that said "+7.50". 401 of 7,508 bounties (5.3%)
 *    carried cents. Dan 2026-08-29: "THERE CAN NEVER BE 'ROUNDING' IT MUST
 *    ALWAYS BE DOWN TO THE CENT." Fixed with `formatChipAward`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { bountyWinnersOf } from '../../src/utils/bountyBroadcast';
import { formatChipAward } from '../../src/utils/format';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('bountyWinnersOf: every winner of the pot that took the head', () => {
  it('reads the ordinary single-winner broadcast exactly as before', () => {
    expect(
      bountyWinnersOf({
        knockerUserId: 'k1',
        knockerName: 'Ann',
        amount: 15,
        addedToHead: 7.5,
      })
    ).toEqual([{ userId: 'k1', name: 'Ann', amount: 15, addedToHead: 7.5 }]);
  });

  it('prefers shares over the flat fields on a split knockout', () => {
    const winners = bountyWinnersOf({
      knockerUserId: 'k1',
      knockerName: 'Ann',
      amount: 15,
      addedToHead: 7.5,
      shares: [
        { userId: 'k1', name: 'Ann', amount: 7.5, addedToHead: 3.75 },
        { userId: 'k2', name: 'Bob', amount: 7.5, addedToHead: 3.75 },
      ],
    });
    expect(winners).toHaveLength(2);
    expect(winners.map((w) => w.userId)).toEqual(['k1', 'k2']);
    // The shares sum to the flat total: nobody is paid twice and nobody is
    // left out.
    expect(winners.reduce((s, w) => s + w.amount, 0)).toBe(15);
    expect(winners.reduce((s, w) => s + w.addedToHead, 0)).toBe(7.5);
  });

  it('accepts the raw fn_collect_bounty share shape too (user_id / cash / to_head)', () => {
    const winners = bountyWinnersOf({
      shares: [
        { user_id: 'k1', cash: 4, to_head: 2 },
        { user_id: 'k2', cash: 4, to_head: 2 },
      ],
    });
    expect(winners).toEqual([
      { userId: 'k1', name: 'Player', amount: 4, addedToHead: 2 },
      { userId: 'k2', name: 'Player', amount: 4, addedToHead: 2 },
    ]);
  });

  it('a one-row shares list is NOT a split: the flat fields stay authoritative', () => {
    expect(
      bountyWinnersOf({
        knockerUserId: 'k1',
        amount: 15,
        addedToHead: 0,
        shares: [{ userId: 'k1', amount: 15, addedToHead: 0 }],
      })
    ).toEqual([{ userId: 'k1', name: 'Player', amount: 15, addedToHead: 0 }]);
  });

  it('drops a share with no user id, and returns nobody when there is no knocker', () => {
    expect(bountyWinnersOf({ shares: [{ amount: 5 }, { userId: 'k2', amount: 5 }] })).toEqual([]);
    expect(bountyWinnersOf({ amount: 15 })).toEqual([]);
    expect(bountyWinnersOf(null)).toEqual([]);
  });

  it('a missing or garbage amount is zero, never NaN', () => {
    const [w] = bountyWinnersOf({ knockerUserId: 'k1', amount: 'lots' });
    expect(w.amount).toBe(0);
    expect(w.addedToHead).toBe(0);
  });
});

describe('formatChipAward: the "+N" that rides with money arriving at a seat', () => {
  it('whole chips read as whole chips, with separators', () => {
    expect(formatChipAward(1234)).toBe('+1,234');
    expect(formatChipAward(5)).toBe('+5');
    expect(formatChipAward(0)).toBe('+0');
  });

  it('cents are kept, to exactly two places', () => {
    expect(formatChipAward(7.5)).toBe('+7.50');
    expect(formatChipAward(0.25)).toBe('+0.25');
    expect(formatChipAward(1234.5)).toBe('+1,234.50');
    expect(formatChipAward(12.34)).toBe('+12.34');
  });

  it('engine float noise below a cent is snapped, not shown', () => {
    expect(formatChipAward(12.500000000001)).toBe('+12.50');
    expect(formatChipAward(17.955)).toBe('+17.96');
    expect(formatChipAward(3.0000000004)).toBe('+3');
  });

  it('never rounds a real fraction to a whole chip (the bug this replaces)', () => {
    // The old label: '+' + Math.round(7.5) = '+8'. That is a lie about money.
    expect(formatChipAward(7.5)).not.toBe('+8');
    expect(formatChipAward(2.49)).toBe('+2.49');
  });
});

describe('the wiring: the engine sends shares and TablePage reads them', () => {
  const ENGINE = code(read('server/src/tournament/TournamentManagerEliminations.ts'));
  const TABLE = code(read('src/pages/TablePage.tsx'));

  it('fn_collect_bounty shares are typed and put on the wire', () => {
    expect(ENGINE).toMatch(/shares\?: Array<\{ user_id: string; cash: number; to_head: number \}>/);
    // Present only on a split: one row per winner, each with their own name.
    expect(ENGINE).toMatch(/shareRows\.length > 1\s*\?\s*shareRows\.map/);
    expect(ENGINE).toMatch(/await this\.broadcast\('bounty_collected', \{[\s\S]*?\n\s*shares,/);
  });

  it('the dead avatar lookup is gone from the knockout broadcast', () => {
    // One `profiles` query per knockout for a field nothing has read since
    // the full-screen overlay was deleted on 2026-08-28.
    expect(ENGINE).not.toContain('eliminatedAvatar');
    expect(ENGINE).not.toContain("select('avatar_url:arena_avatar_url')");
  });

  it('TablePage resolves winners through bountyWinnersOf for the glove, the money and the badge', () => {
    expect(TABLE).toContain("import { bountyWinnersOf } from '../utils/bountyBroadcast'");
    expect(TABLE).toContain('const koWinners = bountyWinnersOf(b)');
    expect(TABLE).toContain('const koIsHero = koWinners.some((w) => w.userId === userId)');
    expect(TABLE).toContain('for (const w of koWinners)');
    expect(TABLE).toContain('const headWinners = bountyWinnersOf(b)');
    // The flat fields must not be read directly for money or heads any more.
    expect(TABLE).not.toMatch(/const koAmount = Number\(b\.amount\)/);
    expect(TABLE).not.toMatch(
      /next\[b\.knockerUserId\] = \(next\[b\.knockerUserId\] \|\| 0\) \+ Number\(b\.addedToHead\)/
    );
  });

  /**
   * MOVED 2026-09-20, NOT WEAKENED. The label still goes through one formatter
   * and still keeps every cent at a chip table; what changed is that the
   * formatter is now told which UNIT the table pays in, because at a Diamond
   * table the two-place branch below prints a fraction of a Diamond that the
   * bounty bank cannot pay. `formatAwardAtUnit` RETURNS `formatChipAward`
   * unchanged at the chip unit - asserted by construction in
   * `tests/unit/aDiamondEventIsPricedInDiamonds.test.ts` - so the chip contract
   * this test was written about is identical, one call deeper.
   */
  it('the pot-win float label is one unit-bearing formatter, never Math.round', () => {
    expect(TABLE).toContain("import { formatAwardAtUnit, formatChipAward } from '../utils/format'");
    expect(TABLE).toContain('const label = formatAwardAtUnit(amount, feltUnitCentsRef.current)');
    // And the unit is read, not guessed: the ref follows the table's own arena.
    expect(TABLE).toContain('const feltUnitCents = arenaAssetUnitCents(tableState.arenaAsset)');
    expect(TABLE).toContain('feltUnitCentsRef.current = feltUnitCents');
    expect(TABLE).not.toMatch(/'\+' \+ \(amount >= 1 \? Math\.round\(amount\)/);
  });

  it('a player who leaves and comes back can be knocked out again', () => {
    // koSeenRef used to be released only on table change. The release is a
    // TRANSITION (absent, then present), guarded against an ordinary roster
    // update and against a reconnect that rebuilds the roster from empty.
    expect(TABLE).toContain('const rosterIdsRef = useRef<Set<string>>(new Set())');
    expect(TABLE).toMatch(
      /if \(prevRoster\.size > 0\) \{[\s\S]*?if \(!prevRoster\.has\(id\)\) koSeenRef\.current\.delete\(id\);/
    );
  });
});
