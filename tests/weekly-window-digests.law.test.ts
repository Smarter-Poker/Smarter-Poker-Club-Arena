import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path: string) => readFileSync(path, 'utf8');
const fixture = 'scripts/ci/fixtures/weekly-window-digests';
const pins = JSON.parse(read(`${fixture}/replacement.json`));
const migration = read(
  'supabase/migrations/20261016214904_weekly_close_fingerprints_read_each_window_digest_once.sql'
);
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('weekly close fingerprints read each proved window digest once', () => {
  it('changes only the exact fingerprint expression in both complete source owners', () => {
    expect(pins.functions).toHaveLength(2);
    expect(pins.functions.map((entry: { before_md5: string }) => entry.before_md5)).toEqual([
      '0a4e7a1bc6b05634ebb0d87e6cc05501',
      'b2e3fd77ed627e13476e440bf7aa5322',
    ]);
    expect(pins.functions.map((entry: { after_md5: string }) => entry.after_md5)).toEqual([
      '98470df5bb0e684508cc2fc8a105e9a6',
      '79ea1825fc78b42b0928bac70b5ac4f6',
    ]);
    for (const entry of pins.functions) {
      const before = read(`${fixture}/${entry.before_file}`);
      const after = read(`${fixture}/${entry.after_file}`);
      expect(md5(before)).toBe(entry.before_md5);
      expect(md5(after)).toBe(entry.after_md5);
      expect(before.split(entry.old)).toHaveLength(2);
      expect(after).toBe(before.replace(entry.old, entry.new));
      expect(after.replace(entry.new, entry.old)).toBe(before);
      expect(after.split('AS $function$')[0]).toBe(before.split('AS $function$')[0]);
      expect(migration).toContain(`$old$${entry.old}$old$`);
      expect(migration).toContain(`$new$${entry.new}$new$`);
      expect(migration).toContain(entry.before_md5);
      expect(migration).toContain(entry.after_md5);
    }
  });

  it('copies window bytes before expansion and materializes narrow digest rows before sorting', () => {
    for (const entry of pins.functions) {
      expect(entry.new).toContain('WITH fingerprint_windows AS MATERIALIZED');
      expect(entry.new).toContain("w.cash_md5||''::bytea AS cash_md5");
      expect(entry.new).toContain("w.fee_md5||''::bytea AS fee_md5");
      expect(entry.new).toContain('cash_rows AS MATERIALIZED (SELECT u.id,encode(substring(');
      expect(entry.new).toContain('fee_rows AS MATERIALIZED (SELECT u.id,encode(substring(');
      expect(entry.new).toContain("SELECT string_agg(c.row_md5,'' ORDER BY c.id) FROM cash_rows c");
      expect(entry.new).toContain(
        "||COALESCE((SELECT string_agg(f.row_md5,'' ORDER BY f.id) FROM fee_rows f)"
      );
      expect(entry.new).not.toContain('string_agg(encode(substring(');
      expect(entry.new).not.toContain('SELECT w.*');
    }
  });

  it('keeps both replacements atomic and preserves installation authority and the sealed source set', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    for (const guard of [
      'operator_refused',
      'freeze_or_override_refused',
      'scheduler_owned',
      'history_replay',
      'inventory_seal_required',
      'preimage_authority_refused',
      'exact_replacement_refused',
      'postimage_refused',
      'installed_source_refused',
      'inventory_seal_changed',
    ])
      expect(migration).toContain(`window_digest_${guard}`);
    expect(migration).toContain(
      "proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'"
    );
    expect(migration).toContain("proconfig IS DISTINCT FROM ARRAY['search_path=public']");
    expect(migration).toContain("proowner<>'postgres'::regrole OR prosecdef OR provolatile<>'v'");
    expect(migration).not.toMatch(/CREATE\s+INDEX|ALTER\s+FUNCTION|\bGRANT\b|\bREVOKE\b/i);
    expect(migration).not.toMatch(
      /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(?:chip_ledger|club_members|ca_settlements|accounting_close_partials)\b/i
    );
    const sealed = JSON.parse(read('scripts/ci/fixtures/inventory-proof-lifetime-sources.json'));
    const sealedOwners = sealed.functions.map(
      (entry: { signature: string }) => entry.signature.split('(')[0]
    );
    for (const entry of pins.functions)
      expect(sealedOwners).not.toContain(entry.signature.split('(')[0]);
  });

  it('executes all three native owners unconditionally in the existing required accounting parent', () => {
    const parent = read('scripts/ci/test_launch_reset_floor.py');
    for (const name of [
      'test-weekly-window-r2-digests-postgres.py',
      'test-weekly-window-earned-digests-postgres.py',
      'test-weekly-window-digest-install-postgres.py',
    ]) {
      const invocation = `print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / '${name}'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))`;
      expect(parent.split('\n').filter((line) => line === invocation)).toHaveLength(1);
    }
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 -B scripts/ci/test_launch_reset_floor.py --candidate-migration'
    );
    expect(read('scripts/ci/test-weekly-window-r2-digests-postgres.py')).toContain(
      'actual_whole_before_after_function'
    );
    expect(read('scripts/ci/test-weekly-window-r2-digests-postgres.py')).toContain(
      'physical_toast_bytes'
    );
    expect(read('scripts/ci/test-weekly-window-earned-digests-postgres.py')).toContain(
      'independent_python_oracle'
    );
    expect(read('scripts/ci/test-weekly-window-earned-digests-postgres.py')).toContain(
      'partial_short_extra_null_digests_preserved'
    );
    expect(read('scripts/ci/test-weekly-window-digest-install-postgres.py')).toContain(
      'second owner changed after first replacement causes whole transaction rollback'
    );
  });
});
