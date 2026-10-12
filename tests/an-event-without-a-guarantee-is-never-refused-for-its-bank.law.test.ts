import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Incident 2026-10-02 09:40Z: every Spin and heads-up Sit & Go of Deep Stack
// Society was refused "guarantee is short by 32,725.00 chips" because the
// readiness read counted OTHER events' guarantees against the bank, even for
// an event that promises nothing.
const sql = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20261002105918_an_event_without_a_guarantee_is_never_refused_for_its_bank_a.sql'
  ),
  'utf8'
);

function functionBody(): string {
  const open = sql.indexOf('AS $function$');
  const close = sql.indexOf('$function$;', open + 13);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

describe('an event without a guarantee is never refused for its bank', () => {
  const body = functionBody();

  it('blocks only an event that needs an overlay, and only for its own need', () => {
    const shortAssign = body.slice(
      body.indexOf('v_short :='),
      body.indexOf(';', body.indexOf('v_short :='))
    );
    expect(shortAssign).toContain('WHEN v_required > 0');
    expect(shortAssign).toContain('ELSE 0');
    expect(shortAssign).not.toContain('v_exposure');
  });

  it('still reports the bank-wide position without refusing on it', () => {
    expect(body).toContain("'portfolio_short_by', v_portfolio_short");
    expect(body).toContain("'other_live_exposure', COALESCE(v_exposure, 0)");
    expect(body).toMatch(/WHEN v_enforce AND v_short > 0 THEN 'funding_blocked'/);
  });

  it('is guarded against the live pre-image and asserts its post-image', () => {
    expect(sql).toContain("'ab3e5f80468318f9e7933790fc8dc353'");
    expect(sql).toMatch(/RAISE EXCEPTION 'preimage:/);
    expect(sql).toMatch(/RAISE EXCEPTION 'postimage:/);
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb) TO service_role'
    );
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
