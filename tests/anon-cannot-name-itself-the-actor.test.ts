/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN UNAUTHENTICATED CALLER MUST NOT NAME ITSELF THE ACTOR (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_club_set_member_role decided who was acting with:
 *
 *     v_actor := COALESCE(auth.uid(), p_actor_user_id);
 *
 * auth.uid() is NULL for `anon` BY DEFINITION, so for an unauthenticated caller
 * that COALESCE fell through to p_actor_user_id - a value the CALLER supplies.
 * fn_club_grantable_roles then authorised against the spoofed identity, and the
 * audit_trail row recorded the spoofed actor as the person who did it.
 *
 * The function held EXECUTE for PUBLIC and anon (pg_proc.proacl read
 * `=X/postgres | anon=X/postgres | ...`) and is reachable over PostgREST at
 * /rest/v1/rpc/fn_club_set_member_role. Anyone with only the publishable anon
 * key could pass a club owner's uuid and set any member's role in that club,
 * co_owner included. Club and user uuids travel in ordinary listing payloads;
 * they are not secrets.
 *
 * NOT PROVEN BY EXPLOITING IT - CLAUDE.md 11.5 forbids probing a live privilege
 * path against production. Established by reading the definition, the ACL and
 * the grant history: 20260822_club_roles_rpcs.sql:105 granted `TO authenticated,
 * anon` on a THREE-argument version, and the anon grant outlived the six-argument
 * shape that introduced the COALESCE.
 *
 * WHY THE GATE MISSED IT. scripts/ci/check-definer-authorization.mjs cleared any
 * function that MENTIONS auth.uid() anywhere. This one mentions it - inside the
 * spoofable COALESCE. The gate's own printed guidance already said "Never from a
 * parameter: a caller-supplied ..."; it did not enforce its own sentence.
 *
 * These pin both halves so neither can come back.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  spoofableIdentityFallback,
  unauthorisedWriters,
} from '../scripts/ci/check-definer-authorization.mjs';

const MIGRATION_RAW = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260831_anon_cannot_name_itself_the_actor.sql'),
  'utf8'
);

/* COMMENTS CARRY NO BEHAVIOUR, AND THIS MIGRATION QUOTES THE BUG.
   Its header reproduces `COALESCE(auth.uid(), p_actor_user_id)` verbatim to
   explain what was wrong - so a naive negative assertion over the raw file
   fails on the explanation rather than on the code. That is the same trap
   check-definer-authorization.mjs documents in its own stripComments(). */
const MIGRATION = MIGRATION_RAW.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('the fix itself', () => {
  it('takes identity from auth.uid(), not from the caller', () => {
    expect(MIGRATION).toMatch(/v_actor := auth\.uid\(\);/);
    // The exact shape that shipped must not reappear in the fixed body.
    expect(MIGRATION).not.toMatch(/v_actor := COALESCE\(auth\.uid\(\), p_actor_user_id\)/);
  });

  it('still lets a trusted backend name the actor, by the documented idiom', () => {
    // Dropping the parameter would change the signature and turn a clear
    // refusal into a confusing PostgREST 404 for anyone sending the old shape.
    expect(MIGRATION).toMatch(/COALESCE\(auth\.role\(\), 'service_role'\)\s*=\s*'service_role'/);
  });

  it('revokes PUBLIC as well as anon', () => {
    // proacl carried `=X/postgres`, so revoking anon alone would have left the
    // identical access standing through the PUBLIC grant.
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon;/);
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO authenticated, service_role;/);
  });

  it('asserts its own effect, so it cannot silently no-op', () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'anon still holds EXECUTE/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'authenticated LOST EXECUTE/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'the spoofable COALESCE is still present/);
  });
});

describe('the gate now enforces the sentence it always printed', () => {
  it('treats a parameter fallback as spoofable', () => {
    expect(spoofableIdentityFallback('v := COALESCE(auth.uid(), p_actor_user_id);')).toBe(true);
    expect(spoofableIdentityFallback('v := COALESCE(auth.uid(), current_setting(1));')).toBe(true);
  });

  it('leaves the documented service_role idiom alone', () => {
    // A literal cannot be steered from a browser, so it is not a fallback to
    // caller input. Flagging it would make the gate unusable.
    expect(
      spoofableIdentityFallback("IF COALESCE(auth.role(),'service_role')='service_role' THEN")
    ).toBe(false);
    expect(spoofableIdentityFallback('v := auth.uid();')).toBe(false);
  });

  it('flags the exact shape that shipped, and clears the repaired one', () => {
    const vulnerable = `
CREATE OR REPLACE FUNCTION public.fn_probe_role(p_club_id uuid, p_actor_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_actor uuid;
BEGIN
  v_actor := COALESCE(auth.uid(), p_actor_user_id);
  UPDATE club_members SET role='co_owner' WHERE club_id=p_club_id;
  RETURN '{}'::jsonb;
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_probe_role TO authenticated, anon;`;
    const repaired = vulnerable
      .replace(
        'v_actor := COALESCE(auth.uid(), p_actor_user_id);',
        "v_actor := auth.uid();\n  IF v_actor IS NULL THEN RETURN '{}'::jsonb; END IF;"
      )
      .replace('TO authenticated, anon;', 'TO authenticated;');

    expect(unauthorisedWriters(vulnerable)).toContain('fn_probe_role');
    expect(unauthorisedWriters(repaired)).toEqual([]);
  });
});
