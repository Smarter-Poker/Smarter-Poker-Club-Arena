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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from '../helpers/sourceWindow';

const root = join(__dirname, '../..');

describe('a table_seats count names a column', () => {
  it('no client query selects * from table_seats', () => {
    const files = [
      'src/services/TableService.ts',
      'src/services/FriendSuggestionService.ts',
      'src/components/tournament/TournamentAutoSeat.tsx',
      'src/pages/TablePage.tsx',
    ];
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8');
      const cleaned = blankNonCode(src);
      let at = src.indexOf("from('table_seats')");
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
        const chain = src.slice(at, end);
        expect(chain, `${rel}: a table_seats query must name its columns`).not.toMatch(
          /select\(\s*'\*'/
        );
        at = src.indexOf("from('table_seats')", end);
      }
    }
  });
});
