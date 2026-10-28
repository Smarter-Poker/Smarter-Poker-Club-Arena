import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(p, 'utf8');
describe('deferred payout receipts reuse only pure payer work', () => {
  it('preserves every original live receipt predicate and metadata', () => {
    const sql = read(
      'supabase/migrations/20261027173150_deferred_payout_checks_reuse_validated_payers.sql'
    );
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION');
    const end = sql.lastIndexOf('$function$') + 10;
    const body = sql.slice(start, end).trim() + ';';
    const old = read('scripts/ci/fixtures/payout-receipt-payer-reuse/original-complete.sql')
      .trim()
      .replace(/\s*;$/, ';');
    expect(
      body.replaceAll(
        'deleted_reserve_certificate_payers(c.id)',
        'rakeback_certificate_payers(c.id)'
      )
    ).toBe(old);
    expect(body.match(/deleted_reserve_certificate_payers\(c.id\)/g)).toHaveLength(2);
    expect(sql).toContain('c2a3aedb97cf5782be7e9bc7a2a6e03b');
    expect(sql).toContain("p.proacl::text='{postgres=X/postgres}'");
  });
  it('runs real deferred-constraint and cache-fault regression in existing close workflow', () => {
    expect(read('.github/workflows/weekly-close-hour-guard.yml')).toContain(
      'python3 -B scripts/ci/test-payout-receipt-payer-reuse-postgres.py'
    );
    const native = read('scripts/ci/test-payout-receipt-payer-reuse-postgres.py');
    expect(native).toContain('SET CONSTRAINTS ALL IMMEDIATE');
    expect(native).toContain('cached-payers-do-not-cache-live-');
  });
});
