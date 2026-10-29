import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
import { declaredFunctions } from '../scripts/ci/check-definer-authorization.mjs';
const read = (p: string) => readFileSync(p, 'utf8');
const fixture = 'scripts/ci/fixtures/original-linked-cash-spgist/';
const sql = read(
  'supabase/migrations/20261029172002_original_cash_links_use_a_lossless_partial_union_selector.sql'
);
describe('original linked cash preserves proof checks with a lossless selector', () => {
  it('adds only the exact partial SP-GiST union expression and preserves all existing authority', () => {
    const split = splitConcurrentPreamble(sql);
    expect(split.ok).toBe(true);
    expect(split.indexes).toHaveLength(1);
    expect(split.indexes[0].statement).toContain(
      "USING spgist((game_scope->>'game_union_id'))WHERE proof_md5=md5(proof::text)"
    );
    expect(split.indexes[0].statement).not.toMatch(/INCLUDE|length|substring|::uuid/i);
    expect(declaredFunctions(sql)).toHaveLength(0);
    expect(sql).not.toMatch(
      /DROP\s+INDEX|ALTER\s+TABLE|UPDATE\s+public\.|DELETE\s+FROM|SET\s+plan_cache_mode|ANALYZE\s/i
    );
    const t = JSON.parse(read(fixture + 'meaningful-table-contract.json'));
    expect(t.columns).toHaveLength(14);
    expect(t.constraints).toHaveLength(10);
    expect(t.indexes).toHaveLength(3);
    expect(t.triggers).toHaveLength(1);
    expect(sql).toContain("qualified->'raw_triggers'");
    expect(sql).toContain("qualified->'function_authorities'");
    expect(sql).toContain('0c3a826553e9ef65a03030c3ef78eaaf');
  });
  it('binds every qualification input and executes native regression in required Accounting1', () => {
    const b = JSON.parse(read(fixture + 'source-binding.json'));
    for (const [p, h] of Object.entries(b.source_sha256))
      expect(createHash('sha256').update(read(p)).digest('hex'), p).toBe(h);
    expect(read('scripts/ci/test_launch_reset_floor.py')).toContain(
      "'test-original-linked-cash-spgist-postgres.py'"
    );
    const r = read('scripts/ci/test-original-linked-cash-spgist-postgres.py');
    expect(r).toContain('admitted6144byte_key');
    expect(r).toContain("await_phase('waiting for old snapshots')");
    expect(r).toContain('production_capacity_claimed');
    expect(r).toContain('no_proof_rehash_filter');
  });
});
