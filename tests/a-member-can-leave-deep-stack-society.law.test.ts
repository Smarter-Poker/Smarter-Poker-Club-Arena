/**
 * LAW - A MEMBER CAN LEAVE DEEP STACK SOCIETY
 *
 * Launch audit 2026-10-05. The club's delete guard
 * (trg_deep_stack_members_are_protected) refuses every club_members DELETE
 * that has not declared itself, and the authorized leave door never did, so
 * no member of the one public club could leave and no owner could remove one.
 * Migration 20261006041001 has the door declare for its own single-row
 * delete and restore the setting straight after.
 *
 * The unit suite has no database, so this pins the migration's shape and that
 * no later migration redefines the door without the declaration. Behaviour
 * was executed on a scratch PostgreSQL 16 (docs/changelog).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = '20261006041001_a_member_can_leave_deep_stack_society.sql';
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

describe('a member can leave deep stack society', () => {
  const sql = read(NAME);

  it('declares for the one delete and restores the setting after it', () => {
    const on = sql.indexOf("PERFORM set_config('app.deep_stack_teardown', 'on', true);");
    const del = sql.indexOf(
      'DELETE FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;',
      on
    );
    const back = sql.indexOf(
      "PERFORM set_config('app.deep_stack_teardown', v_teardown_before, true);",
      del
    );
    expect(on).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(on);
    expect(back).toBeGreaterThan(del);
  });

  it('does not touch the guard itself', () => {
    expect(sql).not.toMatch(/DROP\s+TRIGGER/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE[^;]*DISABLE\s+TRIGGER/i);
    expect(sql).not.toContain('fn_deep_stack_society_cannot_be_deleted_by_accident');
  });

  it('refuses a definition it was not written against, and asserts its effect', () => {
    expect(sql).toContain("md5(v_def) <> 'b7d38f85200e6b248c37cbc0df25ce4c'");
    expect(sql).toContain('the leave door still does not declare its delete');
    expect(sql).toMatch(/^-- @live-proof: .*app\.deep_stack_teardown/m);
  });

  it('is one transaction', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('no later migration redefines the leave without the declaration', () => {
    for (const f of files.filter((name) => name > NAME)) {
      const body = read(f);
      if (
        !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.fn_member_leave_to_treasury\b/i.test(body)
      ) {
        continue;
      }
      expect(body, `${f} redefines the club leave`).toContain('app.deep_stack_teardown');
    }
  });
});
