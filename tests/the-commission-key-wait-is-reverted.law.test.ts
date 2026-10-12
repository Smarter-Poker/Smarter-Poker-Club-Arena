/**
 * THE COMMISSION KEY WAIT IS REVERTED (2026-10-03).
 *
 * Pinned on migration 20261003232001_the_commission_key_wait_is_reverted.sql.
 * 20261003201157 made finishes wait for busy commission keys before their
 * lane and before the union credit; measured, the decided -> receipt p50 rose
 * from ~2.9 s to ~10.5 s and the in-finish waits remained. Both bodies return
 * to their exact pre-change md5s and the helper is dropped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261003232001_the_commission_key_wait_is_reverted.sql'),
  'utf8'
);

describe('the commission key wait is reverted', () => {
  it('is one transaction with a live proof', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
  });

  it('starts from the installed postimages and lands on the exact preimages', () => {
    expect(sql).toContain("IF md5(d) <> '489b37dd61b45a464a8f6ae8f6ce8972' THEN");
    expect(sql).toContain("IF md5(d) <> '166b754c14d82599ea15db319279e69c' THEN");
    expect(sql.match(/c64e049911fd99c1d784cdb042ca714b/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sql.match(/15acb041213e75e30cefdff37e04179b/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('drops the helper only after proving nothing calls it', () => {
    expect(
      sql.indexOf("RAISE EXCEPTION 'fn_ca_await_commission_keys_free still has a caller'")
    ).toBeLessThan(sql.indexOf('DROP FUNCTION public.fn_ca_await_commission_keys_free(uuid);'));
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\s/im);
  });
});
