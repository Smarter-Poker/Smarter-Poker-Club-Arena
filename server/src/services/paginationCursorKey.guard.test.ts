/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY fetchAllRows CALL SITE PAGES BY THE KEY IT SAYS IT DOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fetchAllRows takes the cursor from `opts.idKey`, which DEFAULTS TO 'id'. If
 * the query orders and cursors on a different column and the caller forgets to
 * say so, the helper reads `row['id']` off the last row, finds undefined, logs
 * `<label>.missing_cursor_key` and returns `complete: false` — a PARTIAL
 * result that the caller may or may not notice.
 *
 * One call site had exactly that: HorseFleet.bankrolls pages club_members by
 * `user_id` and selected only (user_id, club_id, chip_balance). Every run past
 * the first page bailed, `bankrollsLoaded` stayed false, and the horse fleet
 * lost its bankroll awareness entirely. Found 2026-08-31 in the production
 * engine log.
 *
 * This pins the invariant rather than the one bug: for each fetchAllRows call
 * in the server, the column in `.order(...)` must equal the effective idKey.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('fetchAllRows cursor keys', () => {
  it('every call site orders by the column it cursors on', () => {
    const offenders: string[] = [];

    for (const file of walk(SERVER_SRC)) {
      const src = readFileSync(file, 'utf8');
      let from = 0;
      for (;;) {
        const at = src.indexOf('fetchAllRows<', from);
        if (at < 0) break;
        from = at + 1;

        // The call spans from here to its closing `);` — take a generous
        // window and read the two facts out of it.
        const end = src.indexOf('\n      );', at);
        const window = src.slice(at, end > at ? end : at + 4000);

        const orderCol = /\.order\(\s*['"]([A-Za-z0-9_]+)['"]/.exec(window)?.[1];
        // No .order in the window means this is not a keyset page we can judge.
        if (!orderCol) continue;

        const idKey = /idKey:\s*['"]([A-Za-z0-9_]+)['"]/.exec(window)?.[1] ?? 'id';
        const label = /label:\s*['"]([^'"]+)['"]/.exec(window)?.[1] ?? file;

        if (orderCol !== idKey) {
          offenders.push(`${label}: orders by "${orderCol}" but cursors on "${idKey}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
