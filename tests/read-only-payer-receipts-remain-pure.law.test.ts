import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(p, 'utf8');
describe('read-only payer receipts retain their original pure reader', () => {
  it('adds only an authoritative readonly fallback before all unchanged write-cache code', () => {
    const sql = read(
      'supabase/migrations/20261027174253_read_only_receipts_keep_the_original_payer_reader.sql'
    );
    const begin = sql.indexOf('CREATE OR REPLACE FUNCTION');
    const end = sql.lastIndexOf('$function$') + 10;
    const body = sql.slice(begin, end).trim() + ';';
    const old = read('scripts/ci/fixtures/payout-receipt-payer-reuse/original-cache-helper.sql')
      .trim()
      .replace(/\s*;$/, ';');
    const a = body.indexOf(' -- Reports retain the original pure-reader contract');
    const b = body.indexOf(' -- Re-read physical row versions', a);
    expect(body.slice(0, a) + body.slice(b)).toBe(old);
    const branch = body.slice(a, b);
    expect(branch).toContain("current_setting('transaction_read_only')::boolean");
    expect(branch).toContain('smarter_private.rakeback_certificate_payers(p_calculation)');
    expect(branch).not.toMatch(/INSERT|UPDATE|CREATE TEMP|REVOKE/);
  });
  it('supersedes old immutable proof through existing mapping while retaining every authority', () => {
    const aliases = JSON.parse(read('scripts/ci/applied-migration-aliases.json'));
    expect(aliases.superseded).toContainEqual(
      expect.objectContaining({
        file: 'supabase/migrations/20261027142050_deleted_reserves_reuse_unchanged_payer_proofs.sql',
        by: '20261027174253',
      })
    );
    const header = read(
      'supabase/migrations/20261027174253_read_only_receipts_keep_the_original_payer_reader.sql'
    ).split('\n')[0];
    for (const h of [
      '51fd3608c78f2f700c277fb9287bca3b',
      '2673336b266659907cb9a787d9847a18',
      '89b7297462b6cd4ba6bf145c7d5fa261',
      '516cd5a271fd21f4b2fe6f98e503dc75',
    ])
      expect(header).toContain(h);
    expect(read('.github/workflows/weekly-close-hour-guard.yml')).toContain(
      'python3 -B scripts/ci/test-readonly-payer-receipts-postgres.py'
    );
  });
});
