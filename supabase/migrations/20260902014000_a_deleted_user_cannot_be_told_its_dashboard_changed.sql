-- A cascading account delete aborted on its own bookkeeping.
--
-- bump_daily_challenge_dashboard_revision fires AFTER DELETE on
-- user_daily_challenges and challenge_streak_state. Deleting a user cascades
-- into those tables, the trigger then INSERTs a dashboard revision row keyed to
-- that user, and daily_challenge_dashboard_revisions.user_id references
-- profiles - which the same cascade has already removed. The insert violates
-- its own foreign key and takes the whole delete down with it:
--
--   insert or update on table "daily_challenge_dashboard_revisions" violates
--   foreign key constraint ... Key (user_id)=(...) is not present in "profiles"
--
-- Found by creating one throwaway account and trying to remove it again; the
-- cleanup had to be unpicked by hand in trigger-safe order.
--
-- THE FIX is to notice what the revision row is FOR. It exists so a live
-- dashboard can tell it has stale data. A user who no longer exists has no
-- dashboard to refresh, so bumping a revision for them is meaningless as well
-- as fatal. The insert is now guarded on the profile still existing.
--
-- Deliberately NOT done: dropping the DELETE trigger. A delete of one
-- challenge row for a user who is still present is a real dashboard change and
-- must still bump. Only the already-gone case is skipped.
--
-- NOT THE WHOLE STORY, and deliberately so. With this fixed, a cascading delete
-- next reaches diamond_transactions and is refused by fn_ca_journal_append_only
-- because financial journals are append-only. That refusal is CORRECT and is
-- left alone: every account receives a diamond grant at signup, so every
-- account has journal history, and erasing it to delete a user would be the
-- wrong trade. Authorized removal goes through app.ledger_maintenance with an
-- incident reference, which is the sanctioned path and works today.

CREATE OR REPLACE FUNCTION public.bump_daily_challenge_dashboard_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    v_user_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  -- The profile must still be there. On a cascading account delete it is
  -- already gone, and a revision row for a deleted user is both unusable and
  -- an FK violation that aborts the delete.
  IF v_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user_id) THEN
    INSERT INTO public.daily_challenge_dashboard_revisions (user_id, revision, updated_at)
    VALUES (v_user_id, 1, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE
      SET revision = public.daily_challenge_dashboard_revisions.revision + 1,
          updated_at = EXCLUDED.updated_at;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DO $verify$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='bump_daily_challenge_dashboard_revision';
  IF position('EXISTS (SELECT 1 FROM public.profiles' in v_src) = 0 THEN
    RAISE EXCEPTION 'POST-APPLY: the existence guard is not present';
  END IF;
END $verify$;
