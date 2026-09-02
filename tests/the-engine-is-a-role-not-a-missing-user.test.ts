/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  "NO USER" IS NOT A SYNONYM FOR "TRUSTED"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Thirty-nine SECURITY DEFINER functions guarded themselves with
 *
 *     IF auth.uid() IS NOT NULL AND <the real check> THEN refuse
 *
 * which skips the check entirely when there is no auth.uid(). All thirty-nine
 * were written that way for the same honest reason: the engine calls them on the
 * service key and has no auth.uid() to offer. `anon` has no auth.uid() either,
 * and on 2026-08-28 that shorthand was live-exploitable in
 * process_tournament_rebuy - an unauthenticated caller bought a rebuy for a real
 * seated player and took the chips out of their balance (#1570).
 *
 * The other thirty-eight were not exploitable, only because `anon` lacked the
 * grant. Safety that rests on a grant rather than on the guard is one migration
 * from ending.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const MIG = read(
  'supabase/migrations/20260828090000_the_engine_is_a_role_not_the_absence_of_a_user.sql'
);

describe('there is one definition of "is this the engine"', () => {
  it('asks the ROLE, so no two guards can disagree', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()');
    expect(MIG).toContain("COALESCE(auth.role(), 'service_role') = 'service_role'");
  });

  it('is not built on current_user, which SECURITY DEFINER makes useless', () => {
    // current_user reads as the OWNER for the browser and the engine alike.
    // That is what made an earlier club_members guard a silent no-op.
    expect(MIG).toContain('NOT current_user');
    expect(MIG).not.toMatch(/SELECT current_user\s*(=|IN)/);
  });

  it('is not callable by a logged-out visitor', () => {
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.fn_caller_is_engine() FROM PUBLIC, anon');
  });
});

describe('the rewrite preserves both real callers and closes the third', () => {
  it('turns a skipped check into a refusal when there is no user', () => {
    expect(MIG).toContain(
      "'NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR (\\1)) THEN'"
    );
    expect(MIG).toContain("'NOT public.fn_caller_is_engine() THEN'");
  });

  it('cannot run past the end of an IF and swallow half a function', () => {
    /**
     * `[^;]*?` rather than `[\s\S]*?`. A condition never contains a statement
     * separator, so the match cannot cross one. It is also what makes the two
     * expression-embedded guards skip themselves instead of being mangled.
     */
    expect(MIG).toContain('([^;]*?)');
    expect(MIG).not.toContain('([\\s\\S]*?)\\s+THEN');
  });

  it('records the probe on a real money path', () => {
    expect(MIG).toContain('PROBE11  A(anon)   = refused at the gate');
    expect(MIG).toContain('D(engine) = past the gate');
  });
});

describe('nothing is rewritten by accident and nothing is skipped by accident', () => {
  it('demands the exact counts, so a partial pass aborts the whole thing', () => {
    expect(MIG).toContain("RAISE EXCEPTION 'expected to rewrite 37 functions, rewrote %', v_done");
    expect(MIG).toContain('expected to skip exactly 2 expression-embedded guards');
  });

  it('names the two it leaves alone, and says why they are correct as written', () => {
    // Both use the shape as a POSITIVE permission test in a boolean expression.
    // That already fails closed; rewriting would invert their meaning.
    expect(MIG).toContain('ca_player_hands(uuid, text, integer)');
    expect(MIG).toContain('fn_union_report_caller_ok(uuid)');
    expect(MIG).toContain('POSITIVE');
    expect(MIG).toContain('already fails CLOSED');
  });

  it('refuses to leave a skipped guard that writes', () => {
    // Read-only is what makes "leave it as a positive test" defensible. If one
    // ever starts writing, that reasoning is void and this must fail.
    expect(MIG).toContain('a skipped guard writes; it cannot be left as a positive test');
  });

  it('asserts afterwards that exactly those two remain', () => {
    expect(MIG).toContain('expected exactly the two positive-test guards to remain');
    expect(MIG).toContain('only % functions reference fn_caller_is_engine');
  });
});
