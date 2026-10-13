import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const dir = 'scripts/qualification/cash-original17/';
const path =
  'supabase/migrations/20261013035113_a_cash_original_hand_corrects_its_rolled_back_allocator.sql';
describe('A cash original corrects its exact rolled-back allocator', () => {
  it('binds maintained source, native fixtures and current enforcement', () => {
    const binding = JSON.parse(readFileSync(dir + 'source-binding.json', 'utf8'));
    for (const [file, pin] of Object.entries(binding.files) as [
      string,
      { bytes: number; sha256: string },
    ][]) {
      const b = readFileSync(file);
      expect(b.length, file).toBe(pin.bytes);
      expect(createHash('sha256').update(b).digest('hex'), file).toBe(pin.sha256);
    }
  });
  it('preserves exact parent30 proof and ordinary public financial owner', () => {
    const sql = readFileSync(path, 'utf8');
    const parent = readFileSync(
      'supabase/migrations/20261013022132_a_retained_original_hand_corrects_its_exact_refused_source_o.sql',
      'utf8'
    );
    const proof = (s: string, name: string) =>
      s
        .slice(s.indexOf('CREATE FUNCTION smarter_private.' + name + '('))
        .split('AS $body$')[1]
        .split('$body$;')[0];
    expect(proof(sql, 'original_tournament30_source_correction_proof')).toBe(
      proof(parent, 'original_hand_source_correction_proof')
    );
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\.fn_ca_resume_hand_submission/);
    expect(sql).toContain('public.engine_table_leases');
    expect(sql).toContain("proof->>'scope' IS DISTINCT FROM 'cash'");
    expect(sql).toContain("proof->>'source_cause' IS DISTINCT FROM 'backup_residue_constraint'");
    expect(sql).toContain('cardinality(statements)=1');
    expect(sql).toContain('CASH17_PARENT30_FULL_AUTHORITY_CHANGED');
    expect(sql).toContain('CASH17_FINAL_FULL_POSTIMAGES_AND_SECURITY_REQUIRED');
  });
  it('directly runs PG17 qualification and always preserves its artifact', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('bash scripts/dev/probe-cash-original17-pg17.sh');
    expect(ci).toContain('steps.cash_original17.outcome');
    expect(ci).toContain('name: cash-original17-${{ github.run_id }}-${{ github.run_attempt }}');
    const probe = readFileSync(dir + 'probe-public-safe.py', 'utf8');
    expect(probe).toContain('EXPECTED_CASH17_INSTALLER_ROLLBACK');
    expect(probe).toContain('cash17-replay-refusal');
    expect(probe).toContain('raise SystemExit(1)');
  });
});
