/**
 * A GUARANTEE IS A FLOOR: THE FINAL POOL IS max(guarantee, collected) (2026-10-01)
 *
 * fn_ca_fund_overlay_on_lock funds the whole shortfall from the bank when an
 * event starts; money collected afterwards (late registration, rebuys, the
 * add-on) was then added on top and finalized as it stood. c21cacad: guarantee
 * 100.00, start-time overlay 100.00, 67.00 of add-ons, paid 167.00; correct
 * pool 100.00 with a 33.00 overlay. fn_apply_prize_guarantee now returns the
 * excess to the exact bank that funded it before it finalizes, in the same
 * subtransaction, and never touches a finalized pool.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20261001230928_an_excess_guarantee_overlay_returns_to_its_bank_when_the_poo.sql'
  ),
  'utf8'
);

function body(name: string): string {
  const start = SQL.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`));
  expect(start, `the file defines ${name}`).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$function$', start) + '$function$'.length;
  return SQL.slice(open, SQL.indexOf('$function$', open));
}

const WRAPPER = body('fn_apply_prize_guarantee');
const RETURN = body('fn_ca_return_excess_start_overlay_locked');

describe('an excess guarantee overlay returns to its bank when the pool is finalized', () => {
  it('replaces the reviewed production pre-image only', () => {
    expect(SQL).toContain("md5(p.prosrc) = '4f921617438bfcfb0b9db32ff490b81d'");
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
  });

  it('returns the excess before finalizing, and rolls it back with a refused finalization', () => {
    const ret = WRAPPER.indexOf('fn_ca_return_excess_start_overlay_locked(p_tournament_id)');
    const core = WRAPPER.indexOf('fn_ca_apply_prize_guarantee_core(');
    expect(ret).toBeGreaterThan(0);
    expect(core).toBeGreaterThan(ret);
    expect(WRAPPER).toContain("EXCEPTION WHEN SQLSTATE 'P0405' THEN");
    expect(WRAPPER).toContain('RETURN v_refusal;');
  });

  it('prices the final pool as max(guarantee, collected) and returns at most what was funded', () => {
    expect(RETURN).toContain('v_collected := round(v_pool - v_funded, 2);');
    expect(RETURN).toContain('v_target := GREATEST(v_guarantee, v_collected);');
    expect(RETURN).toContain(
      'v_excess := round(LEAST(v_funded, GREATEST(0, v_pool - v_target)), 2);'
    );
    // c21cacad: funded 100, pool 167 -> collected 67, target 100, excess 67, pool 100.
    const funded = 100;
    const pool = 167;
    const collected = pool - funded;
    const excess = Math.min(funded, Math.max(0, pool - Math.max(100, collected)));
    expect(excess).toBe(67);
    expect(pool - excess).toBe(100);
  });

  it('never reprices a finalized pool and returns once', () => {
    expect(RETURN).toMatch(
      /IF NOT FOUND OR COALESCE\(v_t\.prize_pool_finalized, false\) THEN\s+RETURN NULL;/
    );
    expect(RETURN).toContain(":guarantee_overlay_excess_return'");
  });

  it('pays back the exact funder through the reversal leg every reader already nets', () => {
    expect(RETURN).toContain("'prize_liability', p_tournament_id, v_from_type, v_from_entity");
    expect(RETURN).toContain("'kind', 'reviewed_void_overlay_return'");
    expect(RETURN).toContain('p_overlay_in => -v_excess');
    expect(RETURN).toContain('IF COALESCE(v_funded, 0) <= 0 OR v_sources <> 1 THEN');
  });

  it('keeps the wrapper service_role only and the helper owner only', () => {
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(uuid, text) TO service_role;'
    );
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_return_excess_start_overlay_locked(uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
  });
  it('registers the balance writer before it is created', () => {
    const reg = SQL.indexOf(
      "INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES (\n  'fn_ca_return_excess_start_overlay_locked','approved',"
    );
    expect(reg).toBeGreaterThan(0);
    expect(reg).toBeLessThan(
      SQL.indexOf('CREATE FUNCTION public.fn_ca_return_excess_start_overlay_locked(')
    );
  });
});
