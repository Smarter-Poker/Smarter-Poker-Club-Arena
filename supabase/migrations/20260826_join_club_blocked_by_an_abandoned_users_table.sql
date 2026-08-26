-- ═══════════════════════════════════════════════════════════════════════════════
-- 29 REAL ACCOUNTS COULD NOT JOIN A CLUB, BECAUSE OF A TABLE NOTHING WRITES
--
-- Dan, 2026-08-26, with a screenshot: click the invite link, press Join Club,
-- get "Failed to join club" and "Something Went Wrong. Please Try Again."
--
-- WHAT THE LOGS SAY, EXACTLY
--
--   17:16:54  POST /rest/v1/rpc/fn_join_club  ->  409
--   17:47:04  POST /rest/v1/rpc/fn_join_club  ->  409
--   17:48:35  POST /rest/v1/rpc/fn_join_club  ->  409
--
-- and at each of those three timestamps, in postgres_logs:
--
--   23503: insert or update on table "club_members"
--          violates foreign key constraint "club_members_user_id_fkey"
--
-- WHY THAT CONSTRAINT FIRES
--
-- `club_members_user_id_fkey` is `FOREIGN KEY (user_id) REFERENCES users(id)`
-- and that is **public.users** -- a legacy shadow identity table, NOT
-- auth.users. The signup trigger `handle_new_user` writes `public.profiles`
-- and nothing else. So every account created after public.users stopped being
-- maintained exists in auth.users and in profiles, and does not exist in the
-- one table the club_members foreign key actually checks.
--
-- 29 accounts are in that state right now. Among them: clubarena45@gmail.com
-- and runthetable45@gmail.com, both of which signed in this morning, and seven
-- other real player emails. None of them could join any club, ever, by any
-- route -- invite link, club code, or the Discover list. It is not an invite
-- bug at all; the invite link is simply how Dan happened to walk into it.
--
-- IT IS NOT ONLY CLUB JOINS. Nine foreign keys point at public.users:
-- club_members (user_id, agent_id), clubs.owner_id, player_wallets.user_id,
-- hand_actions.player_id, rake_attributions.player_id,
-- tournament_waitlists.user_id, and two audit tables. For those 29 accounts,
-- every one of those paths was closed the same way.
--
-- WHAT THIS MIGRATION DOES
--
--   1. BACKFILLS public.users from auth.users for the 29 missing accounts, so
--      all nine paths open at once. Verified beforehand: zero username and
--      zero email collisions against the 2,030 rows already there.
--   2. KEEPS IT FILLED. A new AFTER INSERT trigger on public.profiles mirrors
--      each new profile into public.users. It is exception-safe by
--      construction: a failure to mirror can never block a signup.
--   3. TAKES THE CLUB-JOIN PATH OFF THAT TABLE ENTIRELY.
--      `club_members_user_id_fkey` (-> public.users) is REDUNDANT:
--      `club_members_profiles_fkey` already constrains the same column to
--      profiles(id) ON DELETE CASCADE, and profiles is the table signup
--      actually writes. The redundant one is dropped, so even if the mirror
--      ever breaks again, joining a club does not.
--      `club_members_agent_id_fkey` is repointed from public.users to
--      profiles(id) for the same reason -- an agent missing from the legacy
--      table could not be set as anybody's upline, which is the other half of
--      what Dan reported as broken.
--
-- ON DELETE SET NULL is new on agent_id (it was NO ACTION). Deleting a
-- profile that runs a downline should unassign that downline, not refuse the
-- deletion. Nothing depends on the old behaviour; no profile deletion has
-- ever had to pass it, because agent_id could only ever hold ids that were in
-- public.users.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- It does not repoint the other seven foreign keys. That is a larger change
-- across seven tables and it is not needed to unblock anybody once the
-- backfill and the mirror are in place. It is worth doing on its own, with
-- its own migration and its own verification.
--
-- ROLLBACK
--
--   ALTER TABLE public.club_members
--     DROP CONSTRAINT IF EXISTS club_members_agent_id_fkey;
--   ALTER TABLE public.club_members
--     ADD CONSTRAINT club_members_agent_id_fkey
--     FOREIGN KEY (agent_id) REFERENCES public.users(id);
--   ALTER TABLE public.club_members
--     ADD CONSTRAINT club_members_user_id_fkey
--     FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--   DROP TRIGGER IF EXISTS trg_mirror_profile_into_legacy_users ON public.profiles;
--   DROP FUNCTION IF EXISTS public.fn_mirror_profile_into_legacy_users();
--   -- The backfilled rows are left in place on rollback ON PURPOSE: removing
--   -- them would re-break the same 29 accounts, and they are valid rows.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Pre-flight: every assumption this migration rests on ────────────────────
DO $$
DECLARE
  v_users_ref text;
BEGIN
  SELECT confrelid::regclass::text INTO v_users_ref
    FROM pg_constraint
   WHERE conrelid = 'public.club_members'::regclass
     AND conname  = 'club_members_user_id_fkey';

  IF v_users_ref IS NULL THEN
    RAISE NOTICE 'club_members_user_id_fkey is already gone - nothing to drop';
  ELSIF v_users_ref <> 'users' THEN
    RAISE EXCEPTION 'club_members_user_id_fkey now references % - re-read this migration before applying it', v_users_ref;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.club_members'::regclass
       AND conname = 'club_members_profiles_fkey'
       AND confrelid = 'public.profiles'::regclass
  ) THEN
    RAISE EXCEPTION 'club_members_profiles_fkey is missing - dropping the users fkey would leave user_id unconstrained';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.agent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = cm.agent_id)
  ) THEN
    RAISE EXCEPTION 'some club_members.agent_id values are not in profiles - repointing the fkey would fail';
  END IF;
END $$;

-- ── 1. Backfill the 29 accounts that signup never mirrored ──────────────────
INSERT INTO public.users (id, username, email, avatar_url, created_at, updated_at)
SELECT
  u.id,
  -- profiles.username first; then the email local part; then a stable
  -- Player<player_number> that cannot collide with anything derived.
  COALESCE(
    NULLIF(btrim(p.username), ''),
    NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
    'Player' || COALESCE(p.player_number, left(replace(u.id::text, '-', ''), 10))
  ),
  NULLIF(btrim(COALESCE(u.email, '')), ''),
  NULLIF(btrim(COALESCE(p.avatar_url, '')), ''),
  COALESCE(u.created_at, now()),
  now()
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE NOT EXISTS (SELECT 1 FROM public.users pu WHERE pu.id = u.id)
  -- Defensive: skip anything that would collide on the two unique indexes.
  -- Verified zero collisions at write time; this is here so a later re-run
  -- degrades to "skipped" instead of "aborted".
  AND NOT EXISTS (
    SELECT 1 FROM public.users x
     WHERE lower(x.username) = lower(COALESCE(
             NULLIF(btrim(p.username), ''),
             NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
             'Player' || COALESCE(p.player_number, left(replace(u.id::text, '-', ''), 10))
           ))
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.users y
     WHERE y.email IS NOT NULL
       AND lower(y.email) = lower(NULLIF(btrim(COALESCE(u.email, '')), ''))
  )
ON CONFLICT (id) DO NOTHING;

-- ── 2. Keep it filled, forever, without ever blocking a signup ──────────────
CREATE OR REPLACE FUNCTION public.fn_mirror_profile_into_legacy_users()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- public.users is a legacy identity table that nine foreign keys still
  -- check. Signup writes profiles, so profiles is the honest place to mirror
  -- from. A row missing here is not cosmetic: it makes the account unable to
  -- join a club, own a club, hold a wallet, or sit in a hand.
  BEGIN
    INSERT INTO public.users (id, username, email, avatar_url, created_at, updated_at)
    VALUES (
      NEW.id,
      COALESCE(
        NULLIF(btrim(NEW.username), ''),
        NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
        'Player' || COALESCE(NEW.player_number, left(replace(NEW.id::text, '-', ''), 10))
      ),
      NULLIF(btrim(COALESCE(NEW.email, '')), ''),
      NULLIF(btrim(COALESCE(NEW.avatar_url, '')), ''),
      now(),
      now()
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    -- A username or email already taken by one of the 2,030 legacy rows. Land
    -- the row under a guaranteed-unique name rather than losing it: the id is
    -- what every foreign key checks, and the username here is not shown
    -- anywhere - profiles owns the displayed name.
    BEGIN
      INSERT INTO public.users (id, username, email, avatar_url, created_at, updated_at)
      VALUES (NEW.id, 'u_' || replace(NEW.id::text, '-', ''), NULL,
              NULLIF(btrim(COALESCE(NEW.avatar_url, '')), ''), now(), now())
      ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg)
      VALUES (NEW.id, NEW.email, 'fn_mirror_profile_into_legacy_users', SQLSTATE, SQLERRM);
    END;
  WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg)
      VALUES (NEW.id, NEW.email, 'fn_mirror_profile_into_legacy_users', SQLSTATE, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mirror_profile_into_legacy_users ON public.profiles;
CREATE TRIGGER trg_mirror_profile_into_legacy_users
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_mirror_profile_into_legacy_users();

COMMENT ON FUNCTION public.fn_mirror_profile_into_legacy_users() IS
  'Mirrors each new profile into the legacy public.users table, which nine foreign keys still reference. Added 2026-08-26 after 29 real accounts were found unable to join any club: signup writes profiles only, and club_members_user_id_fkey checks public.users.';

-- ── 3. Take club membership off the legacy table ────────────────────────────
-- Redundant with club_members_profiles_fkey, which constrains the same column
-- to the table signup actually writes.
ALTER TABLE public.club_members DROP CONSTRAINT IF EXISTS club_members_user_id_fkey;

ALTER TABLE public.club_members DROP CONSTRAINT IF EXISTS club_members_agent_id_fkey;
ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE
  v_missing int;
  v_agent_ref text;
BEGIN
  SELECT count(*) INTO v_missing
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.users pu WHERE pu.id = u.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill left % auth users still missing from public.users', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.club_members'::regclass
       AND conname = 'club_members_user_id_fkey'
  ) THEN
    RAISE EXCEPTION 'club_members_user_id_fkey is still present';
  END IF;

  SELECT confrelid::regclass::text INTO v_agent_ref
    FROM pg_constraint
   WHERE conrelid = 'public.club_members'::regclass
     AND conname = 'club_members_agent_id_fkey';
  IF v_agent_ref IS DISTINCT FROM 'profiles' THEN
    RAISE EXCEPTION 'club_members_agent_id_fkey references %, expected profiles', v_agent_ref;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.profiles'::regclass
       AND tgname = 'trg_mirror_profile_into_legacy_users'
  ) THEN
    RAISE EXCEPTION 'the profiles mirror trigger was not created';
  END IF;
END $$;
