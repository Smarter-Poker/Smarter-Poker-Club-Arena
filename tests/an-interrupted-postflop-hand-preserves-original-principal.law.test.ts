import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const sql = read(
  'supabase/migrations/20261028233452_interrupted_postflop_void_preserves_original_principal.sql'
);
const body = (s: string) => s.split('$function$')[1];
const base = read('scripts/ci/probes/f06-shared-hand-lane/abandoned-addon/preimage.sql');
const addon = read(
  'supabase/migrations/20261018152437_a_documented_addon_does_not_strand_an_abandoned_misdeal.sql'
);
const previous = base.replace(
  "AND (x->>'stack')::numeric = (r->>'stack')::numeric)))) THEN",
  addon.split('new_clause constant text := $new$')[1].split('$new$;')[0]
);
const digest = (s: string) => createHash('md5').update(s).digest('hex');

describe('an interrupted postflop hand preserves original principal', () => {
  it('pins the exact installed authority and successor', () => {
    expect(digest(body(previous))).toBe('0753a506f9ef7ac48588c7e8ec3f4721');
    expect(digest(body(sql))).toBe('7e8b0c0308d20726fa7daa39e9158248');
    expect(sql).toContain("AND md5(prosrc)='0753a506f9ef7ac48588c7e8ec3f4721'");
    expect(sql).toContain("AND md5(prosrc)='7e8b0c0308d20726fa7daa39e9158248'");
    expect(sql).toContain("proacl::text='{postgres=X/postgres,service_role=X/postgres}'");
  });
  it('preserves every old branch byte for byte, including the preflop-only guard', () => {
    const candidate = body(sql);
    const start = candidate.indexOf('    ELSIF n = 1 AND EXISTS (');
    const end = candidate.indexOf('    ELSIF n = 1 THEN', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const withoutNewBranch = (candidate.slice(0, start) + candidate.slice(end)).replace(
      '  v_original_roster jsonb;\n  v_prior record;\n',
      ''
    );
    expect(withoutNewBranch).toBe(body(previous));
  });
  it('runs native causality and mixed-generation proof through the existing required runner', () => {
    const runner = read('scripts/ci/test-f06-shared-hand-lane.py');
    expect(runner).toContain('interrupted-postflop/qualify.py');
    expect(runner).toContain(
      "interrupted['qualify'](ROOT, out, cmd, command, run, probe, require, results)"
    );
    expect(runner).toContain("results.get('interruptedPostflop', {}).get('passed') is True");
    const proof = read('scripts/ci/probes/f06-shared-hand-lane/interrupted-postflop/qualify.py');
    for (const name of [
      'postflop-fails-before',
      'postflop-bad-sibling-atomic-rollback',
      'postflop-no-partial-disposition',
      'postflop-concurrent-same-receipt-replays',
      'postflop-late-commit-fenced',
      'postflop-late-history-fenced',
    ]) {
      expect(proof).toContain(name);
    }
  });
});
