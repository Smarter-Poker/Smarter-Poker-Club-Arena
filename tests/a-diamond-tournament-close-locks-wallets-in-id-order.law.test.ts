import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  'supabase/migrations/20261021231028_tournament_close_custody_locks_owners_in_id_order.sql',
  'utf8'
);
const body = MIGRATION.slice(
  MIGRATION.indexOf('CREATE OR REPLACE FUNCTION'),
  MIGRATION.indexOf('END $function$;')
);

describe('LAW: a Diamond tournament close locks every owner wallet in id order', () => {
  it('replaces only the installed predecessor and pins its exact postimage', () => {
    expect(MIGRATION).toContain("<>'634cc0054bb96b9bb775f601831c57ee'");
    expect(MIGRATION).toContain(
      "md5(pg_get_functiondef(p.oid))='c190bce2730ae5b9b08a886883e84def'"
    );
    expect(MIGRATION).toContain("p.proacl::text='{postgres=X/postgres}'");
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it('takes all releasable owner locks in id order before the first release', () => {
    const lock = body.indexOf('ORDER BY p.id FOR UPDATE OF p;');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(body.indexOf('public.fn_poker_diamond_release(v_c.id,'));
    expect(body.indexOf('IF v_open <> 0 THEN')).toBeLessThan(lock);
    expect(body).toContain("c.state<>'released' AND c.balance=0");
  });
  it('changes no amount, receipt, custody state or release order', () => {
    expect(body).toContain('ORDER BY c.created_at, c.id');
    expect(body).toMatch(/\(v_receipt->>'amount'\)::bigint <> 0/);
    expect(body).toContain(
      "PERFORM public.fn_poker_diamond_guarantee_release(p_tournament_id, 'complete');"
    );
    expect(body).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)/i);
  });
});
