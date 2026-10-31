import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261027220709_original_linked_outcomes_follow_the_recognition_window.sql',
  'utf8'
);
const native = readFileSync('scripts/ci/test-linked-outcome-window-index-postgres.py', 'utf8');
const workflow = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');

describe('Linked hand windows retain their original immutable proof', () => {
  it('adds only one nonpartial time key and preserves original owners and catalog safeguards', () => {
    expect(migration).toContain('btree(recognized_at)');
    expect(migration).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(migration).toContain('ix.indnkeyatts<>1 OR ix.indnatts<>1');
    expect(migration).toContain('ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL');
    expect(migration).toContain('public.fn_platform_frozen()');
    expect(migration).toContain('0c3a826553e9ef65a03030c3ef78eaaf');
    expect(migration).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION|UPDATE public\.|DELETE FROM|ALTER TABLE|INCLUDE\s*\(|DISABLE TRIGGER/i
    );
  });
  it('executes original full rows, reducer, witness, catalog refusals and natural index qualification', () => {
    expect(native).toContain('original-hand-parts.sql');
    expect(native).toContain('original-source65.sql');
    expect(native).toContain('actual-relations.sql');
    expect(native).toContain('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)');
    expect(native).toContain('actual_invalid_concurrent_index_refused');
    expect(native).toContain('installer_original_acl_fault_refused');
    expect(native).not.toMatch(/enable_seqscan|enable_bitmapscan|enable_indexscan/);
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-linked-outcome-window-index-postgres.py'
    );
  });
});
