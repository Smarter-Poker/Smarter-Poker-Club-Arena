/**
 * A seat count names a column, never `*`.
 *
 * `table_seats` is moving to column-level grants so that `horse_id` - the
 * flag that says which seats are horses - is not readable by a player
 * (docs/laws.d/horse-identity-is-not-readable.md). PostgREST expands
 * `select=*` to every column the row has, so a `select('*', { count, head })`
 * asks for the one column the grant withholds and fails with 42501 - and the
 * two counts in TableService run on every tournament leave and every cash-out.
 * A count needs one column. `id` is always granted.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from '../helpers/sourceWindow';

/* memberCount is a pure src/utils module, so it is exercised rather than
   grepped: the count it issues must name a column. */
const selectSpy = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: (...args: unknown[]) => {
        selectSpy(...args);
        return {
          eq: () => ({ in: async () => ({ count: 3, error: null }) }),
        };
      },
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { getUserActiveClubCount } from '../../src/utils/memberCount';

const root = join(__dirname, '../..');

/**
 * The same rule for `club_members` (2026-09-08): `is_bot` there is
 * `profiles.is_horse` mirrored by trigger, and the table is moving to
 * column-level grants that withhold it. Every client read names its
 * columns; the three membership counts select `user_id` (club_members has no
 * `id`).
 */
const TABLES: ReadonlyArray<readonly [string, string[]]> = [
  [
    'table_seats',
    [
      'src/services/TableService.ts',
      'src/services/FriendSuggestionService.ts',
      'src/components/tournament/TournamentAutoSeat.tsx',
      'src/pages/TablePage.tsx',
    ],
  ],
  [
    'club_members',
    [
      'src/pages/UnionDashboardPage.tsx',
      'src/services/ClubsService.ts',
      'src/services/MembershipService.ts',
      'src/components/admin/ClubMemberManagement.tsx',
      'src/pages/AgentDashboardPage.tsx',
      'src/pages/CashierTradePage.tsx',
    ],
  ],
];

describe('a table_seats or club_members read names its columns', () => {
  it.each(TABLES)('no client query selects * from %s', (table, files) => {
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8');
      const cleaned = blankNonCode(src);
      const anchor = `from('${table}')`;
      let at = src.indexOf(anchor);
      while (at >= 0) {
        // The statement this query is: forward to the first ';' at depth 0.
        let depth = 0;
        let end = cleaned.length;
        for (let i = at; i < cleaned.length; i++) {
          const c = cleaned[i];
          if (c === '{' || c === '(' || c === '[') depth++;
          else if (c === '}' || c === ')' || c === ']') depth--;
          else if (c === ';' && depth <= 0) {
            end = i + 1;
            break;
          }
        }
        // Comments stripped, strings kept: a comment explaining the rule must
        // not trip it, and the `'*'` it forbids is a string.
        const chain = src
          .slice(at, end)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        expect(chain, `${rel}: a ${table} query must name its columns`).not.toMatch(
          /select\(\s*'\*'/
        );
        expect(chain, `${rel}: a ${table} query must name its columns`).not.toMatch(
          /select\(\s*\)/
        );
        at = src.indexOf(anchor, end);
      }
    }
  });

  it('the admin fleet count goes through the admin RPC, not a filter on profiles.is_horse', () => {
    const raw = readFileSync(join(root, 'src/pages/admin/EngineDashboard.tsx'), 'utf8');
    expect(raw).toContain("supabase.rpc('fn_admin_horse_fleet_counts')");
    // The filter would be a string literal, so search the raw source too: the
    // blanked copy cannot see it and would pass on nothing.
    expect(raw).not.toMatch(/\.eq\(\s*'is_horse'/);
  });

  it('getUserActiveClubCount counts user_id, not * (club_members has no id)', async () => {
    await expect(getUserActiveClubCount('u1')).resolves.toBe(3);
    expect(selectSpy).toHaveBeenCalledWith('user_id', { count: 'exact', head: true });
  });
});
