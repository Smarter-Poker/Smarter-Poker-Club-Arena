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

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from '../helpers/sourceWindow';

const root = join(__dirname, '../..');

/**
 * The same rule for `club_members` (2026-09-08): `is_bot` there is
 * `profiles.is_horse` mirrored by trigger, and the table is moving to
 * column-level grants that withhold it. Every client read names its
 * columns; the three membership counts select `user_id` (club_members has no
 * `id`).
 */
/* EVERY browser file, not a list (2026-10-05). The list above missed
   HorseOrchestrator.ts, which read horse_id in three places - and a list is
   exactly what goes stale. The withheld column itself is banned too: naming it
   in a select, a filter or an order is a 42501 once the grant is column-level. */
function browserFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) browserFiles(rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}
const SRC_FILES = browserFiles('src');
const TABLES: ReadonlyArray<readonly [string, string, string[]]> = [
  ['table_seats', 'horse_id', SRC_FILES],
  ['club_members', 'is_bot', SRC_FILES],
];

describe('a table_seats or club_members read names its columns', () => {
  it.each(TABLES)('no client query selects * from %s or names %s', (table, withheld, files) => {
    let reads = 0;
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8');
      if (!src.includes(`from('${table}')`)) continue;
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
        expect(
          chain,
          `${rel}: a browser may not read ${table}.${withheld} (horse identity is not readable)`
        ).not.toMatch(new RegExp(`\\b${withheld}\\b`));
        reads += 1;
        at = src.indexOf(anchor, end);
      }
    }
    // The scan saw the reads it guards; an empty walk would pass on nothing.
    expect(reads).toBeGreaterThan(5);
  });

  it('the admin fleet count goes through the admin RPC, not a filter on profiles.is_horse', () => {
    const raw = readFileSync(join(root, 'src/pages/admin/EngineDashboard.tsx'), 'utf8');
    expect(raw).toContain("supabase.rpc('fn_admin_horse_fleet_counts')");
    // The filter would be a string literal, so search the raw source too: the
    // blanked copy cannot see it and would pass on nothing.
    expect(raw).not.toMatch(/\.eq\(\s*'is_horse'/);
  });
});
