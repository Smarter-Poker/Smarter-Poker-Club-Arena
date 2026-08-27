/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  JOINING A CLUB MUST NOT DEPEND ON A TABLE NOTHING WRITES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-26, with a screenshot of the invite page: "LINK GETS SENT, BUT
 * WHEN ITS CLICKED YOU GET THIS ERROR MESSAGE STILL." The screen read
 * "Failed to join club" over the toast "Something Went Wrong. Please Try
 * Again." — which is `GENERIC_ERROR_MESSAGE`, the line safeErrorMessage falls
 * back to when the real error is machine text it refuses to show a player.
 *
 * The real error, from the logs, three times:
 *
 *   POST /rest/v1/rpc/fn_join_club  ->  409
 *   23503: insert or update on table "club_members"
 *          violates foreign key constraint "club_members_user_id_fkey"
 *
 * `club_members_user_id_fkey` pointed at **public.users**, a legacy shadow
 * identity table — not auth.users. Signup (`handle_new_user`) writes
 * `public.profiles` and nothing else, so every account created after
 * public.users stopped being maintained existed in auth.users and in profiles
 * and did NOT exist in the one table the foreign key checked.
 *
 * 29 accounts were in that state, including clubarena45@gmail.com and
 * runthetable45@gmail.com, both of which had signed in that morning. None of
 * them could join any club by any route. Nine foreign keys point at that same
 * table, so club ownership, wallets, hand actions, rake attribution and
 * tournament waitlists were closed to those accounts too.
 *
 * The migration backfills the 29, adds a trigger so profiles keeps
 * public.users filled, and takes club membership off that table entirely:
 * `club_members_user_id_fkey` was redundant with `club_members_profiles_fkey`
 * (same column, constrained to the table signup actually writes), and
 * `club_members_agent_id_fkey` is repointed to profiles so an agent missing
 * from the legacy table can still be somebody's upline.
 *
 * Proved against production inside a transaction that rolled itself back:
 * signed in as clubarena45@gmail.com — the account that could not join —
 * fn_join_club returned 'pending' instead of 23503, redemption promoted it to
 * 'active' and attached the inviter's upline agent, and zero rows survived.
 *
 * CI has no database, so these assertions are on the migration text. What they
 * can prove is that nobody quietly points club membership back at the dead
 * table.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20260826_join_club_blocked_by_an_abandoned_users_table.sql'
  ),
  'utf8'
);

describe('the migration that reopened club joins', () => {
  it('drops the foreign key that pointed club membership at public.users', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.club_members DROP CONSTRAINT IF EXISTS club_members_user_id_fkey;/
    );
  });

  it('only drops it after proving profiles still constrains the same column', () => {
    // Dropping it without that check would leave user_id unconstrained, which
    // is a worse bug than the one being fixed.
    expect(MIGRATION).toMatch(/club_members_profiles_fkey is missing/);
  });

  it('repoints the agent foreign key at profiles, not the legacy table', () => {
    // The ROLLBACK section in the header deliberately still names
    // public.users, so this asserts on the executable statement only.
    const executable = MIGRATION.slice(MIGRATION.indexOf('-- ── Pre-flight'));
    expect(executable).toMatch(
      /ADD CONSTRAINT club_members_agent_id_fkey\s+FOREIGN KEY \(agent_id\) REFERENCES public\.profiles\(id\)/
    );
    expect(executable).not.toMatch(/REFERENCES public\.users\(id\)/);
  });

  it('backfills from auth.users, which is the real identity table', () => {
    expect(MIGRATION).toMatch(/INSERT INTO public\.users/);
    expect(MIGRATION).toMatch(/FROM auth\.users u/);
    expect(MIGRATION).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('keeps public.users filled from profiles going forward', () => {
    expect(MIGRATION).toMatch(/CREATE TRIGGER trg_mirror_profile_into_legacy_users/);
    expect(MIGRATION).toMatch(/AFTER INSERT ON public\.profiles/);
  });

  it('can never block a signup, whatever goes wrong in the mirror', () => {
    // handle_new_user learned this the hard way and swallows everything into
    // signup_errors. A mirror that can throw would turn a cosmetic drift into
    // a failed registration.
    expect(MIGRATION).toMatch(/EXCEPTION WHEN unique_violation THEN/);
    expect(MIGRATION).toMatch(/INSERT INTO public\.signup_errors/);
  });

  it('asserts its own outcome instead of trusting the apply', () => {
    expect(MIGRATION).toMatch(/backfill left % auth users still missing from public\.users/);
    expect(MIGRATION).toMatch(/club_members_user_id_fkey is still present/);
    expect(MIGRATION).toMatch(/the profiles mirror trigger was not created/);
  });

  it('carries a pasted ROLLBACK, because it changes constraints', () => {
    expect(MIGRATION).toMatch(/ROLLBACK/);
    expect(MIGRATION).toMatch(/DROP TRIGGER IF EXISTS trg_mirror_profile_into_legacy_users/);
  });
});
