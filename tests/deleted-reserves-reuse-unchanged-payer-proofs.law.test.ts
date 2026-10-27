import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const text = (p: string) => readFileSync(p, 'utf8');
const sql = text(
  'supabase/migrations/20261027142050_deleted_reserves_reuse_unchanged_payer_proofs.sql'
);
describe('deleted reserves retain original authority while reusing unchanged output', () => {
  it('changes only the original split-validator call', () => {
    const old = text(
      'scripts/ci/fixtures/deleted-reserve-reuse/deleted_wallet_published_rakeback_reserve.sql'
    )
      .trimEnd()
      .replace(/\$function\$\s*;$/, '$function$;');
    const start = sql.indexOf(
      'CREATE OR REPLACE FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve('
    );
    const end = sql.indexOf('$function$;', start) + 12;
    expect(sql.slice(start, end).trimEnd()).toBe(
      old.replace(
        'smarter_private.rakeback_certificate_payers(c.id)',
        'smarter_private.deleted_reserve_certificate_payers(c.id)'
      )
    );
    expect(sql).toContain('FOR SHARE NOWAIT');
    expect(sql).toContain('deleted_wallet_reserve_pending_payout_conflict');
  });
  it('binds original output to every actual rowversion and drops it at commit', () => {
    for (const s of [
      'c.ctid,c.xmin::text',
      'g.tableoid::text',
      'g.ctid::text',
      'g.xmin::text',
      'count(*)::text',
      'ON COMMIT DROP',
      'smarter_private.rakeback_certificate_payers(p_calculation)',
      'pg_get_userbyid(c.relowner)',
    ])
      expect(sql).toContain(s);
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION smarter_private.rakeback_certificate_payers'
    );
    expect(sql).toContain('FROM PUBLIC,anon,authenticated,service_role');
    expect(sql).toContain('SET search_path=pg_catalog,public,pg_temp');
    for (const n of ['pg_class', 'pg_attribute', 'pg_trigger', 'pg_rewrite'])
      expect(sql).toContain('pg_catalog.' + n);
  });
  it('executes native original owners, invalidation and concurrent lock proof in the accounting shard', () => {
    expect(text('scripts/dev/test-agent-accounting-statements.sh')).toContain(
      'test-deleted-reserve-reuse-postgres.py'
    );
    const n = text('scripts/ci/test-deleted-reserve-reuse-postgres.py');
    for (const s of [
      'actual-deleted-agent-R2-reserves-all-payers-then-R3-pays',
      'same-tx-certificate-source-update',
      'same-tx-payer-row-update',
      'payer-row-delete',
      'payer-row-insert',
      'warm-payer-proof-never-bypasses-actual-concurrent-NOWAIT-period-lock',
      'actual-original-validator-executes-once',
    ])
      expect(n).toContain(s);
  });
});
