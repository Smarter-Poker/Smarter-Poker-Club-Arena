/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THREE-VALUED LOGIC, IN A MONEY GAME (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_definer_exposure_audit()` names five SECURITY DEFINER functions a
 * LOGGED-OUT caller can execute and that WRITE - all five the Diamonds casino
 * games. Three refused a signed-out caller in their first statement. Two did
 * not, and in those two the ownership check read:
 *
 *     SELECT * INTO prior FROM public.crash_rounds WHERE commit_id = p_commit_id;
 *     IF prior.id IS NOT NULL THEN
 *       IF prior.user_id <> v_user THEN
 *         RETURN ... 'That Round Belongs To Another Player';
 *       END IF;
 *       RETURN public.fn_crash_round_result(prior) || ... 'replayed';
 *     END IF;
 *
 * `v_user` is `auth.uid()`, which is NULL for a logged-out caller. `x <> NULL`
 * is NULL, NULL is not TRUE, so the refusal did not fire and execution fell
 * straight through to the RETURN below it: **a signed-out caller holding a
 * commit_id could read another player's round result.** Identically in
 * `fn_plinko_drop`.
 *
 * Two things make this worth pinning rather than just fixing. The comparison
 * LOOKS like a guard, and reads like one in review. And it was reachable only
 * because the sign-in guard its three siblings all have was missing from these
 * two - so neither defect was visible on its own.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceDollarQuoted } from '../testHelpers/sourceWindow.js';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260909071854_a_signed_out_caller_cannot_read_another_players_round.sql'
  ),
  'utf8'
);

const FIX = sliceDollarQuoted(MIGRATION, '$fix$');
const PROOF = sliceDollarQuoted(MIGRATION, '$proof$');
/**
 * A negative pin must aim at SQL, never at the header that EXPLAINS the SQL -
 * the same rule `testHelpers/sourceWindow` exists for. "The grants are left
 * exactly as they are ... revoking EXECUTE from `anon`" is prose, and matching
 * it would fail the file on its own documentation.
 */
const MIGRATION_SQL = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('a signed-out caller is not a player', () => {
  it('covers both entry points that were missing the guard', () => {
    expect(FIX).toContain('fn_crash_start');
    expect(FIX).toContain('fn_plinko_drop');
  });

  it('adds the sign-in refusal as the FIRST statement, before any read', () => {
    // After the commit_id lookup would be too late: the fall-through it guards
    // is the very next branch.
    expect(FIX).toMatch(/IF v_user IS NULL THEN\s*\n\s*RETURN jsonb_build_object/);
    expect(FIX).toContain("'BEGIN\n  -- A SIGNED-OUT CALLER IS NOT A PLAYER");
  });

  it('replaces EVERY null-unsafe owner comparison, not just the one it first saw', () => {
    // The first attempt targeted `prior.user_id <> v_user` and left a second
    // `c.user_id <> v_user` behind. The post-check caught it and the migration
    // aborted - which is why the replace is on the bare comparison.
    expect(FIX).toContain("replace(v_new, 'user_id <> v_user', 'user_id IS DISTINCT FROM v_user')");
  });

  it('makes fn_wheel_spin null-safe too, though its guard already covers it', () => {
    // Defence against the NEXT edit: if somebody moves that guard, the
    // comparison must not quietly become the hole again.
    expect(FIX).toContain('fn_wheel_spin');
    expect(FIX).toMatch(/already refuses a NULL v_user up front/);
  });

  it('refuses to edit a body that has moved on', () => {
    expect(FIX).toContain('v_user is no longer auth.uid()');
    expect(FIX).toContain('already carries a signed-out guard');
    expect(FIX).toContain('the commit_id replay lookup is not where this edit expects it');
    expect(FIX).toContain('the owner check is not the null-unsafe form this edit fixes');
    expect(FIX).toContain('replacement matched nothing');
  });

  it('proves both halves afterwards rather than assuming them', () => {
    expect(PROOF).toContain('of 2 game entry points refuse a signed-out caller');
    expect(PROOF).toContain('null-unsafe owner comparison(s) remain');
  });

  it('does not quiet the exposure audit by changing a grant', () => {
    // Revoking EXECUTE from anon is the stronger fix and belongs with whoever
    // owns the Diamonds surface. Silently doing it here would ALSO empty the
    // audit's anon_writers list, which is the only thing that still says these
    // RPCs are reachable at all.
    expect(MIGRATION_SQL).not.toMatch(/REVOKE\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bGRANT\b/i);
    expect(MIGRATION).toContain('The grants are left exactly as they are');
  });

  it('is one transaction, per the production DDL policy', () => {
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
  });
});
