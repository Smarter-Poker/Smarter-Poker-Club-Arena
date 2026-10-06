/**
 * LAW - A SEATED MEMBER LEAVES THE TABLE BEFORE THE CLUB
 *
 * Launch audit 2026-10-05. fn_member_leave_to_treasury emptied the member's
 * club wallet into the treasury and deleted the membership without looking at
 * the felt, so a member could leave the club with a live stack that then had
 * no wallet to cash out into. Migration 20261006024809 refuses the leave, in
 * the function every door calls, while the member holds a live seat funded
 * from that club.
 *
 * The unit suite has no database, so this pins what it can: the migration
 * exists, refuses before the chips move, asserts its own effect, and no later
 * migration redefines the function without the refusal. Behaviour was
 * executed against a scratch PostgreSQL 16 and is recorded in docs/changelog.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = '20261006024809_a_seated_member_leaves_the_table_before_the_club.sql';
const REFUSAL = 'Leave Your Seat At The Table First';
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

describe('a seated member leaves the table before the club', () => {
  const sql = read(NAME);

  it('refuses on a live seat funded from this club, before the chips move', () => {
    expect(sql).toContain('ts.user_id = p_user_id');
    expect(sql).toContain('ts.club_id = p_club_id');
    expect(sql).toContain('ts.left_at IS NULL');
    expect(sql).toContain(REFUSAL);
    // The block is placed in front of the chip return, not after it.
    expect(sql).toContain("c_anchor constant text := E'  IF v_chips > 0 THEN\\n';");
    expect(sql).toContain('$block$ || c_anchor);');
  });

  it('refuses a definition it was not written against, and asserts its effect', () => {
    expect(sql).toContain("md5(v_def) <> '0fb993c0459d542d262d7fa8a8e857db'");
    expect(sql).toContain('a seated member can still leave the club');
    expect(sql).toMatch(/^-- @live-proof: .*Leave Your Seat At The Table First/m);
  });

  it('is one transaction', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('no later migration redefines the leave without the refusal', () => {
    for (const f of files.filter((name) => name > NAME)) {
      const body = read(f);
      if (
        !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.fn_member_leave_to_treasury\b/i.test(body)
      ) {
        continue;
      }
      expect(body, `${f} redefines the club leave`).toContain(REFUSAL);
    }
  });
});
