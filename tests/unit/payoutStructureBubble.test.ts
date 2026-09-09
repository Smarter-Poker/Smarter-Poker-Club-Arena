/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND-FOR-HAND COUNTS THE PLACES THE PAYOUT PATH WOULD ACTUALLY HONOUR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The bubble-protection block in TournamentManagerEliminations used to parse
 * `payout_structure` itself:
 *
 *     try { payouts = JSON.parse(payouts); } catch { payouts = []; }
 *     if (Array.isArray(payouts)) payoutCount = payouts.length;
 *
 * Two failures in four lines. An unreadable column became `payoutCount = 0`
 * with no log and no alert - and since the only exit from hand-for-hand for a
 * running tournament is `playingNow <= payoutCount`, a column that went bad
 * mid-bubble left the event dealing in lock-step through the money to the
 * finish. And counting the length of "whatever parsed" disagreed with every
 * site that PAYS, all of which resolve through payoutStructure.ts and reject a
 * structure with no place 1 or percentages summing to zero.
 *
 * These pin the contract the bubble now relies on. They assert what the
 * function RETURNS, deliberately not how any caller is formatted - a guard test
 * in this repo has already been broken once by prettier rewrapping a signature.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parsePayoutStructure } from '../../server/src/tournament/payoutStructure.js';

const ELIMINATIONS = readFileSync(
  join(process.cwd(), 'server/src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const CASH_MIGRATION = readdirSync(join(process.cwd(), 'supabase/migrations'))
  .filter((name) => name.endsWith('_tournament_cash_settlement_has_one_atomic_authority.sql'))
  .sort()
  .at(-1);
const CASH_SQL = CASH_MIGRATION
  ? readFileSync(join(process.cwd(), 'supabase/migrations', CASH_MIGRATION), 'utf8')
  : '';
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('parsePayoutStructure: unusable is null, never an empty structure', () => {
  it('returns null for a string that is not JSON, so the caller can tell UNKNOWN from zero', () => {
    expect(parsePayoutStructure('{not json')).toBeNull();
  });

  it('returns null for an array with no place 1 - the payout path would not honour it either', () => {
    expect(
      parsePayoutStructure('[{"place":2,"percentage":60},{"place":3,"percentage":40}]')
    ).toBeNull();
  });

  it('returns null when every percentage is zero', () => {
    expect(parsePayoutStructure([{ place: 1, percentage: 0 }])).toBeNull();
  });

  it('rejects a zero terminal row and a fractional place instead of moving the bubble', () => {
    expect(
      parsePayoutStructure([
        { place: 1, percentage: 100 },
        { place: 2, percentage: 0 },
      ])
    ).toBeNull();
    expect(parsePayoutStructure([{ place: 1.5, percentage: 100 }])).toBeNull();
  });

  it('returns null for an empty array and for a non-array', () => {
    expect(parsePayoutStructure([])).toBeNull();
    expect(parsePayoutStructure({ place: 1, percentage: 100 })).toBeNull();
    expect(parsePayoutStructure(null)).toBeNull();
  });

  it('parses a stored structure and reports how many places are paid', () => {
    const parsed = parsePayoutStructure(
      '[{"place":1,"percentage":40},{"place":2,"percentage":25},{"place":3,"percentage":18},{"place":4,"percentage":10},{"place":5,"percentage":7}]'
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(5);
    expect(parsed![0]).toEqual({ place: 1, percentage: 40 });
  });

  it('accepts an already-parsed array identically to its string form', () => {
    const asArray = parsePayoutStructure([
      { place: 1, percentage: 70 },
      { place: 2, percentage: 30 },
    ]);
    const asString = parsePayoutStructure(
      '[{"place":1,"percentage":70},{"place":2,"percentage":30}]'
    );
    expect(asArray).toEqual(asString);
    expect(asArray!.length).toBe(2);
  });
});

describe('a gapped ladder uses its deepest paid place as the bubble threshold', () => {
  it('places the stone bubble after 5th, not after four structure rows', () => {
    const parsed = parsePayoutStructure([
      { place: 1, percentage: 40 },
      { place: 2, percentage: 25 },
      { place: 3, percentage: 20 },
      { place: 5, percentage: 15 },
    ]);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(4);
    expect(Math.max(...parsed!.map((p) => p.place)) + 1).toBe(6);
  });

  it('drives hand-for-hand and terminal Bubble Promise settlement from the deepest paid place', () => {
    const source = codeOnly(ELIMINATIONS);
    expect(source).toMatch(/function deepestCanonicalPaidPlace\(/);
    expect(source).toMatch(/payoutCount = deepestCanonicalPaidPlace\(paidPlaces\)/);
    expect(source).not.toMatch(/const payoutCount = paidPlaces\?\.length/);
    expect(source).not.toMatch(/Array\.isArray\(payouts\) \? payouts\.length : 0/);
    expect(CASH_SQL).toMatch(/SELECT max\(\(a->>'place'\)::integer\) \+ 1\s+INTO v_bubble_place/);
    expect(CASH_SQL).toContain(
      'Bubble protection is part of the tournament pool, not a house overlay.'
    );
  });
});
