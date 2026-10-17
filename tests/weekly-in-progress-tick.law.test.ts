import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path: string) => readFileSync(path, 'utf8');
const fixture = 'scripts/ci/fixtures/weekly-in-progress-tick';
const [pin, chunkedPin] = JSON.parse(read(`${fixture}/replacements.json`));
const migration = read(
  'supabase/migrations/20261017121500_an_in_progress_close_is_visited_without_the_whole_scan.sql'
);
const chunkedMigration = read(
  'supabase/migrations/20261017132500_only_a_chunked_tick_owns_the_in_progress_fast_path.sql'
);
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('an in-progress close is visited without the whole scope scan', () => {
  it('changes exactly one segment of the complete qualified coordinator', () => {
    const before = read(`${fixture}/scope-before.sql`);
    const after = read(`${fixture}/scope-after.sql`);
    expect(md5(before)).toBe(pin.before);
    expect(md5(after)).toBe(pin.after);
    expect(before.split(pin.old)).toHaveLength(2);
    expect(after).toBe(before.replace(pin.old, pin.new));
    expect(after.replace(pin.new, pin.old)).toBe(before);
    expect(migration).toContain(pin.old);
    expect(migration).toContain(pin.new);
  });

  it('lets only a chunked job 272 tick own the fast path', () => {
    const after = read(`${fixture}/scope-after.sql`);
    const chunked = read(`${fixture}/scope-after-chunked.sql`);
    expect(chunkedPin.before).toBe(pin.after);
    expect(md5(chunked)).toBe(chunkedPin.after);
    expect(after.split(chunkedPin.old)).toHaveLength(2);
    expect(chunked).toBe(after.replace(chunkedPin.old, chunkedPin.new));
    expect(chunkedPin.new).toContain('AND v_chunked AS owned');
    expect(chunkedMigration).toContain(chunkedPin.old);
    expect(chunkedMigration).toContain(chunkedPin.new);
    expect(chunkedMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(chunkedMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(chunkedMigration.match(/^-- @live-proof: /gm)).toHaveLength(1);
    for (const guard of [
      'scheduler_owned',
      'history_replay',
      'preimage_authority_refused',
      'postimage_refused',
      'installed_authority_refused',
      'inventory_seal_changed',
    ]) {
      expect(chunkedMigration).toContain(`chunked_tick_owner_${guard}`);
    }
    expect(chunkedMigration).not.toMatch(/CREATE\s+INDEX|ALTER\s+FUNCTION|\bGRANT\b|\bREVOKE\b/i);
  });

  it('keeps the full scan for every tick it does not own', () => {
    expect(pin.new).toContain('FROM eligible e LEFT JOIN');
    expect(pin.new).toContain('WHERE NOT (SELECT t.owned FROM tick_owner t)');
    expect(pin.new).toContain("q.scope_kind='club' AND q.status='running'");
    expect(pin.new).toContain('WHERE o.in_progress AND (SELECT t.owned FROM tick_owner t)');
    expect(pin.new).toContain(
      "ORDER BY z.in_progress DESC,z.last_unfinished,z.last_visit NULLS FIRST,(z.kind='union') DESC,z.id"
    );
  });

  it('installs atomically with exact authority and preserves the sealed inventory', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration.match(/^-- @live-proof: /gm)).toHaveLength(1);
    for (const guard of [
      'operator_refused',
      'freeze_or_override_refused',
      'scheduler_owned',
      'history_replay',
      'inventory_seal_required',
      'preimage_authority_refused',
      'exact_replacement_refused',
      'postimage_refused',
      'installed_authority_refused',
      'inventory_seal_changed',
    ]) {
      expect(migration).toContain(`in_progress_tick_${guard}`);
    }
    expect(migration).not.toMatch(/CREATE\s+INDEX|ALTER\s+FUNCTION|\bGRANT\b|\bREVOKE\b/i);
    expect(migration).not.toMatch(
      /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(?:chip_ledger|union_accounting_runs|settlement_invoices|rakeback_periods|accounting_close_certificates)\b/i
    );
    const sealed = JSON.parse(read('scripts/ci/fixtures/inventory-proof-lifetime-sources.json'));
    const names = sealed.functions.map(
      (entry: { signature: string }) => entry.signature.split('(')[0]
    );
    expect(names).not.toContain('public.fn_process_weekly_accounting_scope');
  });

  it('executes native whole-function and installer proof in the required accounting parent', () => {
    const invocation =
      "print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-in-progress-tick-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))";
    expect(
      read('scripts/ci/test_launch_reset_floor.py')
        .split('\n')
        .filter((line) => line === invocation)
    ).toHaveLength(1);
    const driver = read('scripts/ci/test-weekly-in-progress-tick-postgres.py');
    expect(driver).toContain('owned_tick_scan_never_executed=True');
    expect(driver).toContain('unchunked_probe_reads_full_scan=True');
    expect(driver).toContain('production_financial_operation_qualified=False');
  });
});
