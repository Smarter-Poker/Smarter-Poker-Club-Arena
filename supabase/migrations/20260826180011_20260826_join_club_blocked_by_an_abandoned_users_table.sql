-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826180011; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 29 REAL ACCOUNTS COULD NOT JOIN A CLUB, BECAUSE OF A TABLE NOTHING WRITES.
-- fn_join_club returned 409 three times today; postgres_logs at each of those
-- timestamps: 23503 insert or update on table "club_members" violates foreign
-- key constraint "club_members_user_id_fkey". That constraint references
-- public.users -- a legacy shadow identity table -- while signup
-- (handle_new_user) writes public.profiles and nothing else. Full rationale
-- and ROLLBACK in
-- supabase/migrations/20260826_join_club_blocked_by_an_abandoned_users_table.sql

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

INSERT INTO public.users (id, username, email, avatar_url, created_at, updated_at)
SELECT
  u.id,
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

CREATE OR REPLACE FUNCTION public.fn_mirror_profile_into_legacy_users()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
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

ALTER TABLE public.club_members DROP CONSTRAINT IF EXISTS club_members_user_id_fkey;

ALTER TABLE public.club_members DROP CONSTRAINT IF EXISTS club_members_agent_id_fkey;
ALTER TABLE public.club_members
  ADD CONSTRAINT club_members_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

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

