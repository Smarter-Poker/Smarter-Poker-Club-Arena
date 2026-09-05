/**
 * The member-detail chip scan is bounded by the player.
 *
 * ca_club_member_detail's txn CTE used to read every chip_transactions row in
 * the club and narrow to the player only inside its FILTER clauses. Called
 * once per (result row x club) by fn_search_players for a staff viewer, that
 * was the 6.8-second owner player search (docs/changelog/
 * 2026-09-05-member-detail-txn-scan-bounded-by-player.md).
 *
 * This reads the NEWEST migration that defines the function, so a later
 * redefinition that drops the predicate goes red here rather than in a
 * club owner's search box.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations');
const DEFINES = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ca_club_member_detail\s*\(/i;

function newestDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const sql = readFileSync(join(MIGRATIONS, files[i]), 'utf8');
    if (DEFINES.test(sql)) return { file: files[i], sql };
  }
  throw new Error('no migration defines public.ca_club_member_detail');
}

function txnCte(sql: string): string {
  const start = sql.indexOf('txn AS MATERIALIZED');
  expect(start, 'ca_club_member_detail has a txn CTE').toBeGreaterThan(-1);
  const end = sql.indexOf('SELECT jsonb_build_object', start);
  expect(end, 'txn CTE is followed by the output object').toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('ca_club_member_detail: the chip_transactions scan is bounded by the player', () => {
  const def = newestDefinition();

  it('is defined no earlier than the migration that added the bound', () => {
    expect(def.file >= '20260905062510_member_detail_txn_scan_is_bounded_by_the_player.sql').toBe(
      true
    );
  });

  it('carries the player predicate in the WHERE, not only in the FILTERs', () => {
    const cte = txnCte(def.sql);
    const where = cte.slice(cte.indexOf('WHERE'));
    expect(where).toContain('ct.club_id = p_club_id');
    expect(where).toMatch(
      /\(\s*ct\.to_user_id\s*=\s*p_user_id\s+OR\s+ct\.from_user_id\s*=\s*p_user_id\s*\)/
    );
  });

  it('still reads chip_transactions and keeps both sums on the same user columns', () => {
    const cte = txnCte(def.sql);
    expect(cte).toContain('FROM public.chip_transactions ct');
    expect(cte).toMatch(/FILTER\s*\(WHERE ct\.to_user_id = p_user_id/);
    expect(cte).toMatch(/FILTER\s*\(WHERE ct\.from_user_id = p_user_id/);
  });
});
