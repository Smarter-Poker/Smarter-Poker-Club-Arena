/**
 * THE MEMBER-COUNT FAMILY, CLOSED OUT.
 *
 * A club-scoped count taken off club_members is RLS-filtered: it answers "how
 * many of these rows may YOU enumerate", not "how many members does this club
 * have". Measured against a 588-member club as a real non-member: 0.
 *
 * Six call sites had it. Three were fixed in #867/#875/#880. These are the last
 * four, and one of them was worse than a display bug:
 *
 *   HorseOrchestrator WROTE that filtered number into clubs.member_count - a
 *   SHARED column - from a module imported by UnionDetailPage, a browser page.
 *   There is no trigger on club_members maintaining that column, and its value
 *   feeds ClubsService.getLiveMemberCount, ClubHomePage's fallback, AND the
 *   union total via trg_union_totals_follow_club_counts. One visit by a
 *   non-member would have poisoned the number for everyone and cascaded it up.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceStatement } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const HORSE = read('src/services/HorseOrchestrator.ts');
const CLUBS = read('src/services/ClubsService.ts');
const UNION = read('src/services/UnionService.ts');
const ADMIN = read('src/pages/AdminDashboardPage.tsx');

/** A club-scoped exact count off club_members. The shape that is always wrong. */
const CLUB_SCOPED_COUNT =
  /from\('club_members'\)[\s\S]{0,220}?count: 'exact'[\s\S]{0,220}?\.(eq|in)\('club_id'/;

describe('nothing writes a private view into a shared column', () => {
  it('HorseOrchestrator never manufactures club memberships', () => {
    expect(HORSE).not.toContain('ensureHorsesInBothClubs');
    expect(HORSE).not.toMatch(/from\(['"]club_members['"]\)\s*\.(?:insert|upsert)/);
  });

  it('and no longer counts club_members directly', () => {
    expect(HORSE).not.toMatch(CLUB_SCOPED_COUNT);
  });

  it('does not write a membership-derived count into the shared club row', () => {
    expect(HORSE).not.toMatch(/from\(['"]clubs['"]\)\s*\.update\(\{\s*member_count:/);
  });

  it('that guard would have caught the old code', () => {
    const OLD = [
      '        const { count } = await supabase',
      "          .from('club_members')",
      "          .select('user_id', { count: 'exact', head: true })",
      "          .eq('club_id', await resolveClubUUID(clubId));",
    ].join('\n');
    expect(OLD).toMatch(CLUB_SCOPED_COUNT);
  });
});

describe('getLiveMemberCount no longer pays for a source that cannot win', () => {
  it('has no direct club_members count left', () => {
    expect(CLUBS).not.toMatch(CLUB_SCOPED_COUNT);
  });

  it('still keeps the authoritative RPC source', () => {
    // Removing source C is only safe because source A is genuinely SECDEF now.
    expect(CLUBS).toMatch(/rpc\('fn_get_club_member_count'/);
  });

  it('still returns the max across the remaining sources', () => {
    expect(CLUBS).toMatch(/Math\.max\(\.\.\.candidates\)/);
  });
});

describe('the union total is the union, not the viewer', () => {
  it('sums the batch RPC instead of counting the table', () => {
    expect(UNION).toMatch(/rpc\('fn_batch_club_member_counts'/);
    expect(UNION).not.toMatch(CLUB_SCOPED_COUNT);
  });

  it('sums without de-duplicating, matching unions.member_count', () => {
    expect(UNION).toMatch(/Number\(row\.member_count \?\? 0\)/);
  });
});

describe('the admin dashboard stops paying for counts it discards', () => {
  it('asks for no exact count on either query', () => {
    const block = sliceStatement(ADMIN, 'const [{ data: members }');
    expect(block).not.toMatch(/count: 'exact'/);
  });

  it('reads lengths, which is what it always actually used', () => {
    expect(ADMIN).toMatch(/mems\.length/);
    expect(ADMIN).toMatch(/!anns \|\| anns\.length === 0/);
  });

  it('no longer compares an array to the number 0', () => {
    // `data === 0` was unreachable; the length check was doing all the work.
    expect(ADMIN).not.toMatch(/annCount as any\) === 0/);
  });
});
