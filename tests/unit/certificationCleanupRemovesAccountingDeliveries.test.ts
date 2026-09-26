import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every post-deploy certificate since 2026-09-26 05:34 UTC failed at
 * provisioning: cleanup_reserved_certification_account stopped at the
 * notifications delete because accounting_invoice_deliveries (20260914113214)
 * references the invoice notification delivered to the reserved identity, and
 * accounting_conversations references its profile. This pins the repaired
 * order: the delivery record and the conversation mapping go before the
 * notifications, everything 20260906022000 established stays in place.
 */
const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260926071711_certification_cleanup_removes_accounting_invoice_deliveries_.sql'
  ),
  'utf8'
);
const previous = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260906022000_reserved_cleanup_archives_audit_testimony.sql'
  ),
  'utf8'
);

const body = (source: string): string => source.slice(source.indexOf('BEGIN;'));

describe('reserved certification cleanup removes accounting deliveries', () => {
  it('keeps the database change in one transaction with a bounded lock wait', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(migration).toContain("SET LOCAL lock_timeout = '4s';");
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
  });

  it('removes the delivery record and the conversation mapping before the notifications', () => {
    const deliveries = migration.indexOf('DELETE FROM public.accounting_invoice_deliveries');
    const conversations = migration.indexOf('DELETE FROM public.accounting_conversations');
    const notifications = migration.indexOf(
      'DELETE FROM public.notifications WHERE user_id = p_user_id OR actor_id = p_user_id;'
    );
    const maintenance = migration.indexOf("'app.ledger_maintenance'");
    expect(maintenance).toBeGreaterThan(-1);
    expect(deliveries).toBeGreaterThan(maintenance);
    expect(conversations).toBeGreaterThan(deliveries);
    expect(notifications).toBeGreaterThan(conversations);
    expect(migration).toMatch(
      /DELETE FROM public\.accounting_invoice_deliveries\s+WHERE recipient_id = p_user_id\s+OR notification_id IN \(\s+SELECT id FROM public\.notifications WHERE user_id = p_user_id OR actor_id = p_user_id\s+\);/
    );
    expect(migration).toMatch(
      /DELETE FROM public\.accounting_conversations\s+WHERE recipient_id = p_user_id OR sender_id = p_user_id;/
    );
    // The audience-immutable social conversation is not touched.
    expect(migration).not.toContain('DELETE FROM public.social_conversations');
    expect(migration).not.toContain('DELETE FROM public.social_messages');
  });

  it('is the previous order plus exactly those two deletes and a new maintenance marker', () => {
    const expected = body(previous)
      .replace(
        "'certification-cleanup:20260906022000:' || p_user_id::text",
        "'certification-cleanup:20260926071711:' || p_user_id::text"
      )
      .replace(
        'BEGIN;\n\nCREATE OR REPLACE FUNCTION',
        "BEGIN;\n\nSET LOCAL lock_timeout = '4s';\n\nCREATE OR REPLACE FUNCTION"
      );
    const actual = body(migration)
      .replace(
        / {2}-- [^\n]*\n(?=( {2}-- [^\n]*\n)* {2}DELETE FROM public\.accounting_invoice_deliveries)/g,
        ''
      )
      .replace(
        / {2}DELETE FROM public\.accounting_invoice_deliveries[\s\S]*?;\n {2}DELETE FROM public\.accounting_conversations[\s\S]*?;\n/,
        ''
      );
    expect(actual).toBe(expected);
  });

  it('does not expose the cleanup to browser roles', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)'
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;'
    );
  });
});
