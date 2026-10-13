import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const source = readFileSync(
  'supabase/migrations/20261013163547_scoped_launch_retained_originals_use_the_installed_typed_row.sql',
  'utf8'
);

describe('Scoped launch retained original source correction', () => {
  it('runs the existing accounting owner when only its native inputs change', () => {
    for (const path of [
      'scripts/qualification/retained18-correction/native-typed209.py',
      'scripts/qualification/retained18-correction/typed209-source-binding.json',
      'scripts/qualification/retained18-correction/original_hand_source_correction_proof.sql',
      'scripts/qualification/retained18-correction/probe-native-bootstrap.py',
    ]) {
      const selection = classifyChangedPaths([path]);
      expect(selection.server, path).toBe(true);
      expect(selection.tests, path).toBe(true);
    }
  });

  it('keeps the admitted original cohort finite and unique', () => {
    const ids = [...source.matchAll(/^\s*\('([0-9a-f-]{36})'::uuid,/gm)].map((match) => match[1]);
    expect(ids).toHaveLength(209);
    expect(new Set(ids).size).toBe(209);
    expect(source).toContain('WHERE submission_id=e');
    expect(source).toContain('IF NOT FOUND THEN RETURN NULL');
  });

  it('keeps the correction inside the existing original dispatcher', () => {
    const first = source.indexOf('original_tournament30_source_correction_proof(e)');
    const second = source.indexOf('cash_original17_source_correction_proof(e)');
    const last = source.indexOf(
      'RETURN smarter_private.launch_typed209_source_correction_proof(e)'
    );
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(last).toBeGreaterThan(second);
    expect(source).not.toMatch(
      /(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:public|smarter_private)\./i
    );
    expect(source).not.toMatch(/CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+public\./i);
  });

  it('requires the exact failed source and refuses previously consumed financial work', () => {
    for (const guard of [
      'md5(to_jsonb(s)::text)',
      'md5(to_jsonb(h)::text)',
      'md5(to_jsonb(z)::text)',
      'md5(to_jsonb(p)::text)',
      'hand_submission_correction_claims',
      'hand_submission_disposals',
      'public.hand_atomic_commits',
      'public.hand_history',
      'public.hand_projection_outbox',
      'public.settlement_idempotency_keys',
      'public.ca_settlements',
      "'rolled_back'",
      'record "new" has no field "metadata"',
      "'20261013133012'",
      '89b1671cf9aa507248b7620f734855fa03cdf586d133a1caa9890530fbd04df3',
    ])
      expect(source, guard).toContain(guard);
    expect(source).toMatch(/FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/);
  });
});
