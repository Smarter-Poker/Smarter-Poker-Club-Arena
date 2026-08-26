/**
 * THREE RLS-FILTERED COUNTS OF ONE TABLE IS THREE WRONG ANSWERS, NOT ONE SLOW ONE.
 *
 * MembershipService.getMemberCounts scanned club_members three times - total,
 * active, pending - and all three were subject to RLS, so all three returned 0
 * to anyone who is not a member of the club. Measured as the club owner, who
 * can see all 588 rows:
 *
 *   three direct counts ........ 174.50 ms
 *   fn_club_member_counts .......  0.63 ms
 *
 * A 2026-08-24 note on that code had already spotted the cost and made the three
 * calls parallel. That was right, and it fixed neither the scan count nor the
 * correctness - which is worth remembering: making a wrong answer arrive faster
 * is not progress.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const SVC = read('src/services/MembershipService.ts');
const MIGRATION = read('supabase/migrations/20260825470000_fn_club_member_counts_one_scan.sql');

describe('getMemberCounts asks once, and asks correctly', () => {
  it('uses the single-scan SECURITY DEFINER RPC', () => {
    expect(SVC).toMatch(/rpc\('fn_club_member_counts'/);
  });

  it('no longer counts club_members directly by club_id', () => {
    /**
     * Verified to catch the code it replaced - see the sibling assertion below,
     * which runs the same regex against the old source and requires a match.
     */
    const DIRECT = /from\('club_members'\)[\s\S]{0,160}?count: 'exact'[\s\S]{0,160}?eq\('club_id'/;
    expect(SVC).not.toMatch(DIRECT);
  });

  it('that guard would have caught the old code', () => {
    // A guard that only passes against the new code proves nothing.
    const DIRECT = /from\('club_members'\)[\s\S]{0,160}?count: 'exact'[\s\S]{0,160}?eq\('club_id'/;
    const OLD = [
      '        supabase',
      "          .from('club_members')",
      "          .select('*', { count: 'exact', head: true })",
      "          .eq('club_id', resolvedId),",
    ].join('\n');
    expect(OLD).toMatch(DIRECT);
  });

  it('coerces every bigint the RPC returns', () => {
    for (const f of ['total', 'active', 'pending']) {
      expect(SVC).toContain(`Number(row.${f})`);
    }
  });

  it('still returns zeros rather than NaN when the row is missing', () => {
    // getMemberCounts is called on the club-home path; a null here used to be a
    // count of 0, and must not become NaN rendered into the UI.
    expect(SVC).toMatch(/row\?\.total == null \? 0 :/);
  });
});

describe('the migration proves itself before it lands', () => {
  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(MIGRATION).toMatch(/SECURITY DEFINER/);
    expect(MIGRATION).toMatch(/SET search_path TO 'public', 'extensions'/);
  });

  it('computes all three from ONE scan', () => {
    /**
     * Sliced to the FUNCTION BODY. Counting `FROM club_members` across the whole
     * file counts the assertion block's own queries too - which is how this test
     * first failed, on its own arithmetic rather than on the migration.
     */
    const body = MIGRATION.slice(
      MIGRATION.indexOf('AS $function$'),
      MIGRATION.indexOf('$function$;')
    );
    expect((body.match(/FILTER \(WHERE/g) || []).length).toBe(2);
    expect((body.match(/FROM club_members/g) || []).length).toBe(1);
  });

  it('refuses to land if it invents a fourth definition of "active"', () => {
    expect(MIGRATION).toMatch(/disagrees with fn_get_club_member_count/);
  });

  it('refuses to land if a subset exceeds the total', () => {
    expect(MIGRATION).toMatch(/total smaller than one of its own subsets/);
  });

  it('is not reachable by anon', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_club_member_counts\(uuid\) FROM anon;/
    );
  });
});
