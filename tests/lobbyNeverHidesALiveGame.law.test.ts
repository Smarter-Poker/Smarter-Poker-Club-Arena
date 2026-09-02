/**
 * A LIVE GAME MUST NEVER BE TRUNCATED AWAY (Dan, 2026-09-02).
 *
 * Dan: "why do we only have a hand full of games running in the midway union
 * and zero cash games running in deep stack society?"
 *
 * Deep Stack Society was dealing 676 cash hands a quarter-hour when he asked,
 * across 51 running tables with 203 players seated. The lobby showed none of
 * them, because every cash-lobby read is `order(created_at desc).limit(200)`
 * and DSS carries 1,058 open cash tables: only 10 of the 51 running ones fell
 * inside the 200 fetched. Every filter tab then ran client-side over that
 * truncated list, so PLO, NLH and the rest each read "0/x OPEN" down the page
 * while the club was busy.
 *
 * Midway Union has 73 open cash tables, comfortably inside the cap, which is
 * exactly why its lobby looked honest and DSS's did not.
 *
 * `tables.current_players` is maintained exactly - verified against
 * table_seats on 2026-09-02, 0 discrepancies across all 1,131 open tables - so
 * ordering by it is sound, and it means the cap can only ever trim EMPTY
 * tables. That is the property these pins protect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const svc = readFileSync(join(process.cwd(), 'src/services/TableService.ts'), 'utf8');
const page = readFileSync(join(process.cwd(), 'src/pages/ClubHomePage.tsx'), 'utf8');

/** The body of one method, from its signature to the next `async ` at method depth. */
const methodBody = (src: string, signature: string) => {
  const at = src.indexOf(signature);
  expect(at, `${signature} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  async ', at + signature.length);
  return src.slice(at, next === -1 ? src.length : next);
};

describe('every cash-lobby read puts occupied tables first', () => {
  for (const sig of ['async getClubTables(', 'async getUnionTables(']) {
    it(`${sig.replace('async ', '').replace('(', '')} orders by current_players before created_at`, () => {
      const body = methodBody(svc, sig);
      const byPlayers = body.indexOf("order('current_players', { ascending: false })");
      const byDate = body.indexOf("order('created_at', { ascending: false })");
      expect(byPlayers, 'must order by occupancy').toBeGreaterThan(-1);
      expect(byDate, 'created_at stays as the tiebreak').toBeGreaterThan(-1);
      // Ordering is applied in call order, so occupancy must come FIRST.
      expect(byPlayers).toBeLessThan(byDate);
    });
  }

  it('the club lobby page does the same - it filters client-side over what it fetched', () => {
    const at = page.indexOf("const tableQuery = supabase");
    expect(at).toBeGreaterThan(-1);
    const block = page.slice(at, page.indexOf('.limit(QUERY_LIMITS.LIST);', at));
    const byPlayers = block.indexOf("order('current_players', { ascending: false })");
    const byDate = block.indexOf("order('created_at', { ascending: false })");
    expect(byPlayers).toBeGreaterThan(-1);
    expect(byDate).toBeGreaterThan(-1);
    expect(byPlayers).toBeLessThan(byDate);
  });

  it('still caps the read - the fix is the ORDER, not an unbounded fetch', () => {
    // Removing the cap would trade a hidden game for a 1,058-row payload on
    // every lobby paint. The cap is fine once it can only trim empties.
    expect(methodBody(svc, 'async getClubTables(')).toContain('.limit(QUERY_LIMITS.LIST)');
    expect(methodBody(svc, 'async getUnionTables(')).toContain('.limit(QUERY_LIMITS.LIST)');
  });
});
