/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A GUARD THAT LETS THE ENGINE THROUGH BY LETTING NOBODY-AT-ALL THROUGH
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * process_tournament_rebuy checked identity like this:
 *
 *     IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN ... 42501
 *
 * skipped entirely when auth.uid() IS NULL. That was written so the ENGINE could
 * call it for horses on the service key, which has no auth.uid() to offer. A
 * real requirement, solved the wrong way: `anon` has no auth.uid() either, and
 * `anon` held EXECUTE.
 *
 * So the guard failed OPEN for exactly the caller it most needed to stop, one
 * holding nothing but the public anon key that ships in the client bundle.
 * Proved against production, rolled back: an unauthenticated call bought a rebuy
 * for a real seated player and took the chips out of their balance.
 *
 * The rule these pin: identify the engine by WHAT ROLE IS CALLING, never by the
 * absence of a user. A missing identity is a refusal, not a free pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const MIG = read(
  'supabase/migrations/20260828060000_anon_could_buy_rebuys_with_another_players_chips.sql'
);

describe('the rebuy identity check fails closed', () => {
  it('replaces the fail-open guard with one that refuses a missing identity', () => {
    expect(MIG).toContain(
      "v_old text := 'IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN'"
    );
    expect(MIG).toContain('auth.uid() IS NULL OR auth.uid() <> p_user_id');
  });

  it('recognises the engine by its ROLE, not by having no user', () => {
    // The same rule as the two bypasses closed in #1532. current_user would be
    // useless here: SECURITY DEFINER rewrites it to the owner.
    expect(MIG).toContain("COALESCE(auth.role(), ''service_role'') = ''service_role''");
    expect(MIG).not.toMatch(/current_user\s*(=|<>|IN\b)/);
  });

  it('takes EXECUTE away from anon outright', () => {
    // Defence in depth: no logged-out visitor has any business buying chips,
    // guard or no guard.
    expect(MIG).toContain('FROM PUBLIC, anon');
    expect(MIG).toContain('TO authenticated, service_role');
  });
});

describe('the edit cannot silently do nothing', () => {
  it('edits the body in place rather than retyping 12,815 characters of money path', () => {
    expect(MIG).toContain('pg_get_functiondef');
    expect(MIG).toContain('EXECUTE replace(v_def, v_old, v_new)');
  });

  it('refuses unless it matched exactly once', () => {
    expect(MIG).toContain('IF v_hits <> 1 THEN');
    expect(MIG).toContain('expected exactly one fail-open guard to replace');
  });

  it('re-reads the installed definition afterwards instead of trusting the edit', () => {
    // Two shipped "fixes" in this estate were silent no-ops that reviewed as
    // correct. The migration proves its own effect.
    expect(MIG).toContain("RAISE EXCEPTION 'the fail-open guard is still there'");
    expect(MIG).toContain("RAISE EXCEPTION 'the new guard is not there'");
    expect(MIG).toContain("RAISE EXCEPTION 'anon can still execute it'");
    expect(MIG).toContain("RAISE EXCEPTION 'a legitimate caller lost access'");
  });
});

describe('the evidence is on the record', () => {
  it('quotes the exploit and the closure with numbers', () => {
    expect(MIG).toContain('"success": true, "chips_added": 5000');
    expect(MIG).toContain('balance 25814.61 -> 25813.61');
    expect(MIG).toContain('A(anon)        = refused 42501');
    expect(MIG).toContain('C(the player)  = allowed success=true');
  });
});
