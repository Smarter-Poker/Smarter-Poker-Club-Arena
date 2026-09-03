/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A NUMBER ON A SCREEN IS MEASURED, NOT INVENTED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every pin here is a figure that shipped to a player or an operator and was
 * not a measurement of anything:
 *
 *   * "Total Rake" on the admin dashboard was `0.05 * hands_played` — a
 *     constant times a hand count, rounded to two decimals so it looked
 *     computed. The real ledger (`rake_records`, 1.68M rows) was never read.
 *   * "Total Hands" and "Active Players" were reduced in the browser from an
 *     unordered `.limit(5000)` against a 5,919-row table, so they could differ
 *     between two refreshes a second apart.
 *   * Diamond activity — on the player's own VIP page AND on the admin
 *     dashboard — read `diamond_ledger`, a table with zero rows and no writer.
 *     Both surfaces rendered permanent emptiness as fact.
 *   * "Live Players Now" filtered `.is('horse_id', null)`: a CLAUDE.md 10.5
 *     exclusion that also happened to filter nothing, because that column is
 *     populated on no rows.
 *
 * These are source-level pins because the fault was never in the arithmetic —
 * it was in WHICH TABLE was asked and HOW MUCH of it was read. A rendering
 * test cannot see that; reading the query can.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const ANALYTICS = 'src/pages/admin/AnalyticsDashboard.tsx';
const VIP_PAGE = 'src/pages/VIPPage.tsx';
const FRIEND_SUGGESTIONS = 'src/services/FriendSuggestionService.ts';

/** Source with block and line comments removed, so prose about a retired bug
 *  never satisfies (or trips) a pin meant for live code. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('LAW: diamonds are read from the ledger that has rows', () => {
  // diamond_ledger: 0 rows, no writer. diamond_transactions: the live one.
  for (const file of [VIP_PAGE, ANALYTICS]) {
    it(`${file} does not query diamond_ledger`, () => {
      expect(code(file)).not.toContain('diamond_ledger');
    });

    it(`${file} queries diamond_transactions instead`, () => {
      expect(code(file)).toContain('diamond_transactions');
    });

    it(`${file} reads type alongside transaction_type`, () => {
      /* transaction_type is NULL on ~774 of ~1,540 rows; those carry their
         kind in the older `type` column. Reading only transaction_type
         renders every account's Welcome Bonus as a blank adjustment. */
      const source = code(file);
      expect(source).toContain('transaction_type');
      expect(source).toMatch(/\btype\b/);
    });
  }
});

describe('LAW: platform totals are aggregated in the database', () => {
  const source = code(ANALYTICS);

  it('never fabricates rake from a hand count', () => {
    // The literal shape of the old bug: 0.05 * hands_played.
    expect(source).not.toMatch(/0\.05\s*\*/);
    expect(source).not.toMatch(/-0\.05/);
  });

  it('asks the admin aggregate RPC rather than reducing rows in the browser', () => {
    expect(source).toContain('fn_admin_platform_aggregates');
  });

  it('no longer pulls 5000-row slices to add up', () => {
    // An unordered limit(5000) over 5,919 rows is a sample, not a total.
    expect(source).not.toContain('limit(5000)');
  });

  it('surfaces a failed aggregate instead of rendering zeros', () => {
    // Zero is a claim about the business. An error is not.
    expect(source).toMatch(/if \(error\) throw error/);
  });
});

describe('LAW: horses count where players count (CLAUDE.md 10.5)', () => {
  it('the live-player count does not filter horses out', () => {
    expect(code(ANALYTICS)).not.toContain("is('horse_id', null)");
  });

  it('friend suggestions do not exclude horses', () => {
    /* The exact filter that shipped, under a comment reasoning that horses
       "are not people" — the same assumption that cost 39 tournaments their
       rake attribution on 2026-08-27. */
    expect(code(FRIEND_SUGGESTIONS)).not.toContain("eq('profiles.is_horse', false)");
  });

  it('does not carry is_horse into the browser either', () => {
    /* SUPERSEDED IN THE SAME BRANCH. This asserted the opposite — that
       `is_horse` STAYS in the select, because 10.5 permits the flag as
       identification data. That reading is right for STAFF surfaces and wrong
       here: Dan, 2026-09-02, "HUMAN USERS CAN NEVER KNOW THAT THIS IS A
       'HORSE' AND NOT A 'HUMAN'." Friend suggestions are player-facing, so
       the column would label every suggestion in the response body even with
       the filter gone. The full boundary is pinned in
       tests/a-horse-is-indistinguishable-from-a-human.law.test.ts. */
    expect(code(FRIEND_SUGGESTIONS)).not.toContain('is_horse');
  });
});
