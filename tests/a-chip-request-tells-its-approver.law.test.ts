/**
 * LAW - A CHIP REQUEST TELLS ITS APPROVER
 *
 * Launch audit 2026-10-05. A new member joins a club with 0 chips and asks
 * for some from the cashier. fn_request_chips_core_20261004 wrote the
 * chip_requests row and returned; the approver was never told, and found out
 * only by opening the cashier. Migration 20261006022835 raises one
 * notification for the approver in the same transaction as the request.
 *
 * The unit suite has no database, so this pins what it can: the migration
 * exists, notifies after the insert through the platform's own
 * fn_raise_notification, asserts its own effect, and no later migration
 * redefines the function without the notification. Behaviour was executed
 * against a scratch PostgreSQL 16 and is recorded in docs/changelog.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = '20261006022835_a_chip_request_tells_its_approver.sql';
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

describe('a chip request tells its approver', () => {
  const sql = read(NAME);

  it('adds the notification after the insert, through fn_raise_notification', () => {
    expect(sql).toContain("c_anchor constant text := E'  RETURNING id INTO v_id;\\n';");
    expect(sql).toContain('PERFORM public.fn_raise_notification(');
    expect(sql).toContain("'chip_request'");
    expect(sql).toContain('replace(v_def, c_anchor, c_anchor ||');
  });

  it('does not notify an approver about their own request', () => {
    expect(sql).toContain('IF v_agent IS NOT NULL AND v_agent <> v_me THEN');
  });

  it('refuses a definition it was not written against, and asserts its effect', () => {
    expect(sql).toContain("md5(v_def) <> '236c0cecc1dd32f30f7b50e790f88b63'");
    expect(sql).toContain('the chip request still does not notify its approver');
    expect(sql).toMatch(/^-- @live-proof: .*fn_raise_notification/m);
  });

  it('is one transaction', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('no later migration redefines the request without the notification', () => {
    const later = files.filter((f) => f > NAME);
    for (const f of later) {
      const body = read(f);
      if (
        !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.fn_request_chips_core_20261004\b/i.test(
          body
        )
      ) {
        continue;
      }
      expect(body, `${f} redefines the chip request`).toContain('fn_raise_notification');
    }
  });
});
