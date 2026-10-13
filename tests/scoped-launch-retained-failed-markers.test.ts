import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = () =>
  readFileSync(
    'supabase/migrations/20261013180855_retained_launch_originals_preserve_their_exact_failed_stack_.sql',
    'utf8'
  );

describe('Retained launch originals preserve exact failed stack markers', () => {
  it('uses only the existing private proof without a financial write or new dispatcher', () => {
    const sql = source();
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION smarter_private.launch_typed209_source_correction_proof'
    );
    expect(sql).not.toMatch(/CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+public\./i);
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION smarter_private.original_hand_source_correction_proof'
    );
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:public|smarter_private)\./i);
    expect(sql).toContain('caf700a4ad677baf44ab4b9a932887eadd92082411853a72971b7a8599f5c46a');
  });
  it('retains exact immutable original and failed-marker testimony', () => {
    const sql = source();
    for (const fragment of [
      'md5(to_jsonb(s)::text)',
      'md5(to_jsonb(h)::text)',
      'md5(to_jsonb(z)::text)',
      'md5(to_jsonb(p)::text)',
      'md5(to_jsonb(k)::text)',
      'md5(to_jsonb(c)::text)',
      "k.status='failed'",
      'k.completed_at IS NULL',
      'k.result IS NULL',
      "c.state='failed'",
      "c.totals='{}'::jsonb",
      'hand_submission_correction_claims',
      'hand_submission_disposals',
      'public.hand_atomic_commits',
      'public.hand_history',
      'public.hand_projection_outbox',
    ])
      expect(sql, fragment).toContain(fragment);
    expect(sql).toContain('WHERE submission_id=e');
    expect(sql).toContain('IF NOT FOUND THEN RETURN NULL');
    expect(sql).toMatch(/FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/);
  });
});
