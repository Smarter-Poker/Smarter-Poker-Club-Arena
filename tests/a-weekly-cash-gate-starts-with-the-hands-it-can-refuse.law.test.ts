import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const migration =
  'supabase/migrations/20261013024122_weekly_shaped_hands_start_from_original_unaccepted.sql';
describe('The weekly cash gate starts with original unaccepted primary hands', () => {
  it('binds all actual financial fixtures and directly enforced native inputs', () => {
    const binding = JSON.parse(
      readFileSync('tests/fixtures/weekly-shaped-primary/source-binding.json', 'utf8')
    );
    for (const [path, pin] of Object.entries(binding.files) as [
      string,
      { bytes: number; sha256: string },
    ][]) {
      const bytes = readFileSync(path);
      expect(bytes.length, path).toBe(pin.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(pin.sha256);
    }
  });
  it('preserves raw semantics, private reader security and source generation contracts', () => {
    const old = readFileSync('tests/fixtures/weekly-shaped-primary/preimage.sql', 'utf8');
    const next = readFileSync(migration, 'utf8');
    expect(next.slice(next.indexOf('\n ELSE'), next.indexOf('END $function$'))).toBe(
      old.slice(old.indexOf('\n ELSE'), old.indexOf('END $function$'))
    );
    expect(next).toContain('WITH candidates AS MATERIALIZED');
    expect(next).toContain('h.table_id=o.table_id AND h.hand_number=o.hand_number) IS TRUE');
    expect(next).not.toMatch(
      /^\s*CREATE (?:UNIQUE )?INDEX|enable_seqscan|statement_timeout='(?:240|300)s'/m
    );
    const pins = readFileSync(
      'scripts/qualification/original-retirement-boundary/qualified-proof-source-pins.jsonb',
      'utf8'
    );
    expect(pins).not.toContain('fn_union_pnl_week_shaped_hands');
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('bash scripts/dev/probe-weekly-shaped-primary-pg17.sh');
    expect(workflow).toContain('steps.weekly_shaped_primary.outcome');
    expect(workflow).toContain(
      'weekly-shaped-primary-${{ github.run_id }}-${{ github.run_attempt }}'
    );
  });
});
