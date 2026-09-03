/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SECURITY DEFINER FUNCTION MUST NOT TAKE THE CALLER'S WORD FOR WHO IT IS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two RPCs decided authorization from data the caller supplied.
 *
 *   fn_mystery_bounty_reveal  skipped its "are you the revealer" check whenever
 *                             p_auto was true. p_auto is a PARAMETER. Passing
 *                             p_auto => true read amount_cents, tier and the
 *                             recipient list for any award id and flipped the
 *                             award and chest to revealed.
 *   commander_clock_write     had no authorization at all. Any authenticated
 *                             user could pause, level-jump or end any Commander
 *                             tournament by id, straight through the
 *                             captain_tournaments_update RLS policy that
 *                             SECURITY DEFINER bypasses.
 *
 * CI has no database, so these assert on migration source. That cannot prove
 * the SQL is right. Both were proved against production inside transactions
 * that rolled themselves back, before and after, and both probe outputs are
 * quoted in the migration headers. What these CAN prove is that nobody quietly
 * puts the caller back in charge.
 *
 * The trap these guards are built to avoid: current_user is USELESS inside a
 * SECURITY DEFINER body. It reports the function owner for the browser and the
 * engine alike, which is how an earlier guard on club_members shipped as a
 * silent no-op. auth.role() reads the verified request claim instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const REVEAL = read(
  'supabase/migrations/20260827i_mystery_bounty_reveal_cannot_be_told_it_is_the_engine.sql'
);
const CLOCK = read('supabase/migrations/20260827i_commander_clock_belongs_to_the_floor.sql');

/**
 * Both headers quote the vulnerable line verbatim, because a migration that
 * does not say what it repaired is not a record of anything. A negative
 * assertion therefore has to look at the EXECUTABLE half of the file, or it
 * matches the very documentation that makes the fix reviewable.
 */
const body = (sql: string) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'));
const REVEAL_BODY = body(REVEAL);
const CLOCK_BODY = body(CLOCK);
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const ELIMINATIONS = read('server/src/tournament/TournamentManagerEliminations.ts');

describe('a mystery bounty chest opens for its revealer and nobody else', () => {
  it('honours p_auto only when the caller really is the engine', () => {
    // The old line, which trusted the flag on its own, must be gone.
    expect(REVEAL_BODY).not.toMatch(/IF NOT COALESCE\(p_auto, false\) AND \(p_actor_user_id/);
    expect(REVEAL_BODY).toContain('v_auto  := v_is_engine AND COALESCE(p_auto, false)');
    // And the header keeps the exploit on the record, so the next reader can
    // see what this replaced.
    expect(REVEAL).toContain('p_auto is a PARAMETER');
  });

  it('derives the actor from the request, not from the argument list', () => {
    expect(REVEAL_BODY).toContain(
      'v_actor := CASE WHEN v_is_engine THEN p_actor_user_id ELSE auth.uid() END'
    );
    expect(REVEAL_BODY).toContain(
      'IF NOT v_auto AND (v_actor IS NULL OR v_actor IS DISTINCT FROM v_revealer)'
    );
  });

  it('asks auth.role(), because current_user cannot see past SECURITY DEFINER', () => {
    expect(REVEAL_BODY).toContain(
      "v_is_engine := COALESCE(auth.role(), 'service_role') = 'service_role'"
    );
    // A guard that TESTS current_user would compile, read as correct, and
    // never fire. Naming it in a comment is fine, and both bodies do, which is
    // why this looks for the comparison rather than the word.
    const testsCurrentUser = /current_user\s*(=|<>|!=|IN\b|IS\b)/;
    expect(REVEAL_BODY).not.toMatch(testsCurrentUser);
    expect(CLOCK_BODY).not.toMatch(testsCurrentUser);
  });

  it('still refuses anon outright', () => {
    expect(REVEAL_BODY).toContain(
      'REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) FROM PUBLIC, anon'
    );
  });

  it('leaves both real callers passing what they always passed', () => {
    // The revealer's own tap: never auto.
    expect(TABLE_PAGE).toContain('p_auto: false');
    // The engine's deadline sweep: auto, with the service key behind it.
    expect(ELIMINATIONS).toContain('p_auto: true');
  });
});

describe('the tournament clock belongs to the floor', () => {
  it('requires active staff at that tournament venue', () => {
    expect(CLOCK_BODY).toContain('FROM commander_staff s');
    expect(CLOCK_BODY).toContain('WHERE s.venue_id = v_venue');
    expect(CLOCK_BODY).toContain('AND s.is_active');
    expect(CLOCK_BODY).toContain('AND s.user_id = (SELECT auth.uid())');
  });

  it('refuses with insufficient_privilege rather than failing open', () => {
    expect(CLOCK_BODY).toContain("USING ERRCODE = '42501'");
    expect(CLOCK_BODY).toContain('commander_clock_write refused: not active staff at venue');
  });

  it('still lets the Commander API routes through on the service key', () => {
    expect(CLOCK_BODY).toContain(
      "v_is_engine := COALESCE(auth.role(), 'service_role') = 'service_role'"
    );
    expect(CLOCK_BODY).toContain('IF NOT v_is_engine THEN');
  });

  it('keeps the write itself atomic and unchanged', () => {
    expect(CLOCK_BODY).toContain("jsonb_set(COALESCE(settings, '{}'::jsonb), '{clock_state}'");
    expect(CLOCK_BODY).toContain("status = COALESCE(p_updates->>'status', status)");
  });
});
