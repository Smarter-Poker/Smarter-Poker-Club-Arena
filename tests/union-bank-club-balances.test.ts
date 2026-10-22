import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnionClubBalances, pullableFrom } from '../src/services/unionClubBalances';

describe('Union Bank club balances', () => {
  it('parses each club row and drops malformed ones instead of reading them as 0', () => {
    const map = parseUnionClubBalances([
      { club_id: 'a', club_bank: '57738008.79', club_promo: '0', pull_floor: '100000' },
      { club_id: 'b', club_bank: null, club_promo: 0, pull_floor: 0 },
      { club_id: 7, club_bank: 1, club_promo: 0, pull_floor: 0 },
      null,
    ]);
    expect([...map.keys()]).toEqual(['a']);
    expect(map.get('a')).toEqual({ bank: 57738008.79, promo: 0, floor: 100000 });
    expect(parseUnionClubBalances(null).size).toBe(0);
    expect(parseUnionClubBalances({ success: false }).size).toBe(0);
  });

  it('never offers the opening grant floor as pullable, and the promo wallet has none', () => {
    expect(pullableFrom({ bank: 250000, promo: 40, floor: 100000 }, false)).toBe(150000);
    expect(pullableFrom({ bank: 90000, promo: 40, floor: 100000 }, false)).toBe(0);
    expect(pullableFrom({ bank: 250000, promo: 40, floor: 100000 }, true)).toBe(40);
  });

  it('is served only to the union owner or a union lead, read-only', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        'supabase/migrations/20261022032422_union_bank_reads_its_club_balances.sql'
      ),
      'utf8'
    );
    expect(sql).toContain('auth.uid()');
    expect(sql).toMatch(/u\.owner_id = v_uid/);
    expect(sql).toMatch(/ua\.role = 'union_lead'/);
    expect(sql).toContain('STABLE SECURITY DEFINER');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION .* FROM PUBLIC, anon, authenticated;/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});
