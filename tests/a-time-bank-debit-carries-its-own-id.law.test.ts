/**
 * A TIME BANK DEBIT CARRIES ITS OWN ID AND A RECEIPT (2026-09-28).
 * Pins supabase/migrations/20260928152513_a_time_bank_debit_carries_its_own_id_and_a_receipt.sql.
 * The receipt must be written in the debit's own transaction, after the same
 * per-user lock, so asking again by id is exactly-once.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20260928152513_a_time_bank_debit_carries_its_own_id_and_a_receipt.sql',
  'utf8'
);
const fnStart = sql.indexOf('CREATE FUNCTION public.fn_consume_time_bank_once(');
const fn = sql.slice(fnStart, sql.indexOf('$function$;', fnStart));

describe('the keyed time bank debit', () => {
  it('is one transaction with a lock timeout and a guarded pre-image', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("'7832bfb717daaeb625372bdd3ccc7d60'");
    expect(sql.indexOf('DO $pre$')).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql).toContain('DO $post$');
  });

  it('takes the per-user lock, then reads the receipt, then debits, then records the receipt', () => {
    expect(fnStart).toBeGreaterThan(0);
    const lock = fn.indexOf("pg_advisory_xact_lock(hashtextextended('time_bank:' || p_user_id::text, 0))");
    const read = fn.indexOf('FROM smarter_private.time_bank_debit_receipts WHERE debit_id = p_debit_id');
    const debit = fn.indexOf('public.fn_consume_time_bank(p_user_id, p_seconds)');
    const write = fn.indexOf('INSERT INTO smarter_private.time_bank_debit_receipts');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(debit);
    expect(debit).toBeLessThan(write);
    expect(fn).toContain('TIME_BANK_DEBIT_ID_REUSED');
    expect(fn).toContain("auth.role() IS DISTINCT FROM 'service_role'");
  });

  it('is engine-only and its receipts are append-only', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_consume_time_bank_once(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_consume_time_bank_once(uuid, integer, uuid) TO service_role;'
    );
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON smarter_private.time_bank_debit_receipts');
    expect(sql).toContain('BEFORE TRUNCATE ON smarter_private.time_bank_debit_receipts');
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_consume_time_bank\(/);
  });
});
