/**
 * A COMPLETE READ IS ORDERED BY SOMETHING UNIQUE.
 *
 * fetchAllRows pages with `.range()`, and `.range()` only partitions a result
 * set when the ordering is TOTAL. An ORDER BY on a column with ties leaves the
 * tied rows in no defined order, so Postgres may resolve them differently for
 * each window and rows are skipped or repeated between pages - silently, since
 * the loop's only exit condition is a short page.
 *
 * Measured 2026-09-05 on /friends: `friendships` paged by `created_at` alone,
 * 1,309 accepted rows across 485 distinct timestamps, largest tie group 214.
 * The page rendered 1,274 friends. A different 35 disappeared on each load and
 * nothing reported it.
 *
 * The rule is cheap: whatever a paged read sorts by, it ends with a unique
 * column. This pins the readers that page over user-owned rows, where a
 * missing row is a missing person.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchAllRows } from '../src/utils/fetchAllRows';

const ROOT = join(__dirname, '..');

/**
 * Files whose paged reads represent people or their money, where a lost row is
 * a lost person or an unexplained diamond.
 *
 * `useDiamondLedger` joined the list on 2026-09-05, the same day and from the
 * same defect class: the wallet's Receive pane was given real pagination, and
 * the diamond ledger carries the tie problem in a sharper form than /friends
 * did. Measured on production - the longest ledger is 390 credits, 41 of them
 * share a timestamp, the largest tie group is 29 (LARGER THAN A PAGE), and two
 * of those rows sit exactly on a page seam. Ordering by `created_at` alone
 * would serve one twice and drop another, and the dropped one is a diamond the
 * player was paid and can no longer see.
 *
 * Added here rather than pinned again in a new law: one rule, one place.
 */
const PAGED_PEOPLE_READERS = ['src/pages/FriendsPage.tsx', 'src/hooks/useDiamondLedger.ts'];

/**
 * Blank out comments, PRESERVING EVERY BYTE OFFSET so the lookback window below
 * still lands where it should.
 *
 * Needed because this law reads for `.range(` and the files it guards explain
 * themselves: every corrected query here carries a comment saying ".range()
 * LOSES ROWS", and the diamond ledger's header says it three more times. Match
 * that prose and the law reports a violation in the very sentence recording the
 * fix - which is the same false positive the route gate produced, and it is the
 * dangerous direction to get wrong twice: an agent who "fixes" a comment-driven
 * failure by narrowing the matcher again re-exempts the real code.
 */
const blankComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

describe('a paged read ends its ordering with a unique column', () => {
  for (const file of PAGED_PEOPLE_READERS) {
    it(`${file} never pages on a tie-prone sort alone`, () => {
      const source = blankComments(readFileSync(join(ROOT, file), 'utf8'));

      /* Every `.range(` is the tail of a paged query. Walk back to the ordering
         that produced it and require a unique tiebreaker.

         Matched on the CALL, not on one spelling of its arguments. This read
         `/\.range\(from, to\)/` until 2026-09-05, which silently exempted every
         paged query that computed its window inline - `.range(from, from + N -
         1)` is the same query and the same hazard, and a law that only sees one
         way of writing it passes the other by default. */
      const ranges = [...source.matchAll(/\.range\(/g)];
      expect(ranges.length, 'no paged reads found - has this file moved?').toBeGreaterThan(0);

      for (const match of ranges) {
        const preceding = source.slice(Math.max(0, match.index! - 900), match.index!);
        const lastOrder = preceding.lastIndexOf('.order(');
        expect(lastOrder, `a .range() with no .order() before it in ${file}`).toBeGreaterThan(-1);

        const ordering = preceding.slice(lastOrder);
        expect(
          /\.order\('id'/.test(ordering),
          `a paged read in ${file} sorts without a unique tiebreaker; ` +
            "end the ordering with .order('id', ...)"
        ).toBe(true);
      }
    });
  }
});

/**
 * The other half, behaviourally. `fetchAllRows` is pure and importable, so this
 * runs it rather than reading it: a text pin on a utils module can only say a
 * line is present, which is how the stale-seat prune sat broken while
 * "covered" (scripts/ci/report-source-grep-tests.mjs).
 *
 * What these prove is WHY the ordering rule above has to exist at the call
 * site: the pager concatenates exactly what each window returns and cannot
 * know that two windows overlapped. It has no way to notice a lost row, so
 * nothing downstream will either.
 */
describe('fetchAllRows concatenates windows and cannot rescue a partial order', () => {
  const collect = <T>(pages: T[][]) => {
    const seen: Array<[number, number]> = [];
    return {
      seen,
      query: (from: number, to: number) => {
        seen.push([from, to]);
        return Promise.resolve({ data: pages[seen.length - 1] ?? [], error: null });
      },
    };
  };

  it('reads page after page and stops on the first short one', async () => {
    const { query, seen } = collect([[1, 2, 3], [4, 5, 6], [7]]);
    await expect(fetchAllRows<number>(query, { pageSize: 3 })).resolves.toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(seen).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
  });

  it('an exactly-full last page still costs one more request', async () => {
    const { query } = collect([[1, 2], [3, 4], []]);
    await expect(fetchAllRows<number>(query, { pageSize: 2 })).resolves.toEqual([1, 2, 3, 4]);
  });

  it('returns a row twice, and a row not at all, exactly as the windows gave them', async () => {
    /* This is the shape a non-unique ORDER BY produces: the second window
       re-serves a tied row the first already gave (2) and never serves another
       (3). The pager reports success with 3 unique rows out of 4 - which is
       precisely what /friends did at 1,273 of 1,309, silently. Only a total
       order at the call site prevents it. */
    const { query } = collect([[1, 2], [2, 4], []]);
    const rows = await fetchAllRows<number>(query, { pageSize: 2 });
    expect(rows).toEqual([1, 2, 2, 4]);
    expect(new Set(rows).size).toBe(3);
    expect(rows).not.toContain(3);
  });

  it('refuses to hand back a partial set when a page fails', async () => {
    let call = 0;
    const query = () => {
      call += 1;
      return Promise.resolve(
        call === 1 ? { data: [1, 2], error: null } : { data: null, error: { message: 'boom' } }
      );
    };
    await expect(fetchAllRows<number>(query, { pageSize: 2, label: 'probe' })).rejects.toThrow(
      /probe: page 1 failed - boom/
    );
  });
});
