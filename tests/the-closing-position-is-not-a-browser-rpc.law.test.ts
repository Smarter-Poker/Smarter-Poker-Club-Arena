/**
 * LAW: epoch-reset evidence is callable only by trusted infrastructure.
 *
 * Supabase's function default ACL grants anon and authenticated explicitly.
 * REVOKE FROM PUBLIC does not remove either grant.  SECURITY DEFINER also makes
 * current_user the function owner, so it cannot identify a browser caller.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  'supabase/migrations/20260908121900_the_closing_position_is_not_a_browser_rpc.sql',
  'utf8'
);

describe('closing-position RPC authority', () => {
  it('replaces the SECURITY DEFINER current_user check by asserted substitution', () => {
    expect(SQL).toContain(
      "v_old_guard constant text :=\n    'IF NOT (current_user IN (''postgres'', ''service_role'')) THEN'"
    );
    expect(SQL).toContain(
      "v_new_guard constant text :=\n    'IF COALESCE(NULLIF(auth.role(), ''''), session_user) NOT IN (''service_role'', ''postgres'', ''supabase_admin'') THEN'"
    );
    expect(SQL).toContain('expected exactly one insecure current_user guard');
    expect(SQL).toContain('EXECUTE replace(v_definition, v_old_guard, v_new_guard)');
  });

  it.each([
    'public.fn_ca_capture_closing_position(text, boolean)',
    'public.fn_ca_closing_position_summary(uuid)',
  ])('removes every browser grant from %s', (signature) => {
    expect(SQL).toContain(
      `REVOKE ALL ON FUNCTION ${signature}\n    FROM PUBLIC, anon, authenticated`
    );
    expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n    TO service_role`);
  });

  it('fails its own migration if either browser role can still execute', () => {
    expect(SQL).toContain("has_function_privilege('anon', v_target, 'EXECUTE')");
    expect(SQL).toContain("has_function_privilege('authenticated', v_target, 'EXECUTE')");
    expect(SQL).toContain("has_function_privilege('service_role', v_target, 'EXECUTE')");
    expect(SQL).toContain('remains executable from a browser role');
  });

  it('permits branch landing order but never a partial RPC set', () => {
    expect(SQL).toContain('IF v_capture IS NULL AND v_summary IS NULL THEN');
    expect(SQL).toContain('IF v_capture IS NULL OR v_summary IS NULL THEN');
    expect(SQL).toContain('refusing an incomplete authority repair');
  });
});
