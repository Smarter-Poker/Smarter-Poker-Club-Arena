-- 20260911142515_the_mini_switch_names_who_is_asking.sql
--
-- WHAT THIS CHANGES, AND WHY.
--
-- `check-definer-authorization` blocked the push that added
-- fn_bbj_set_club_mini_enabled, and it was right to:
--
--   SECURITY DEFINER, it writes, a browser role can execute it, and it never
--   calls auth.uid(), auth.role() or auth.jwt(). It cannot know who is asking.
--
-- The function DID derive its actor from the caller - through
-- fn_is_club_admin_uid, which reads auth.uid() internally - so this was one
-- level of indirection away from visible, not an open door. But a guard that
-- has to read through a helper to decide whether a writer is safe is a guard
-- that will eventually read wrong, and "you have to follow one more call to
-- see it" is exactly how a browser-reachable definer writer gets waved past.
--
-- So the actor is named HERE, in the function, before anything else:
-- auth.uid() IS NULL is refused as `not_signed_in`. That is not merely
-- paperwork for the guard, it closes a real (if currently unreachable) case -
-- the function is granted to service_role, and a service-role caller has no
-- auth.uid(), so before today a session-less caller fell through to
-- fn_is_club_admin_uid and was refused with the misleading `not_a_club_admin`.
-- Nothing on the engine calls this (it is a club settings control; the only
-- caller in the repo is src/lib/bbjMiniFeed.ts), so refusing a caller with no
-- session is correct rather than a restriction on anything real.
--
-- The rest of the body is unchanged, including the order that matters:
-- authorize, THEN explain, so a stranger cannot learn a club's union shape
-- from a refusal.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.fn_bbj_set_club_mini_enabled(
  p_club_id uuid, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_pool uuid; v_now boolean; v_actor uuid;
BEGIN
  IF p_club_id IS NULL OR p_enabled IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_and_state_required');
  END IF;

  /* WHO IS ASKING, named here rather than only inside fn_is_club_admin_uid.
     A SECURITY DEFINER function that writes and that a browser can execute
     must say out loud where its actor comes from. It comes from the session,
     never from a parameter: a caller-supplied id is a caller-supplied
     answer. */
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  /* WHO MAY SET IT. Dan, 2026-09-11: "club admin, owner or co owner have
     access to all features and details like that, create a table, edit
     settings etc." fn_is_club_admin_uid is exactly that set - read, not
     assumed: role IN ('owner','co_owner','admin','manager') AND an active
     membership - and it is the same gate the rest of the club settings page
     uses. It reads auth.uid(), the same actor named above, so a member of one
     club cannot set another's switch by passing its id. */
  IF NOT public.fn_is_club_admin_uid(p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_club_admin');
  END IF;

  /* A UNION CLUB DOES NOT OWN THIS SWITCH. It plays into the union's pool, so
     flipping it would turn the mini off for every other club in that union.
     AFTER the authorization checks, deliberately: a stranger must not learn a
     club's union shape from a refusal. */
  IF v_union IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_club_follows_the_union',
                              'union_id', v_union);
  END IF;

  SELECT id INTO v_pool FROM public.bbj_pools
   WHERE club_id = p_club_id AND union_id IS NULL AND status = 'active'
   ORDER BY created_at LIMIT 1;

  /* NO POOL YET IS NOT AN ERROR, and it must not silently drop the setting.
     fn_resolve_bbj_pool creates the row on the club's first raked hand; a club
     that sets this before then gets the row now, at zero, carrying its
     choice. */
  IF v_pool IS NULL THEN
    INSERT INTO public.bbj_pools
      (club_id, pool_amount, main_balance, backup_balance, promo_balance,
       hands_contributed, status, mini_enabled)
    VALUES (p_club_id, 0, 0, 0, 0, 0, 'active', p_enabled)
    RETURNING id INTO v_pool;
  ELSE
    UPDATE public.bbj_pools
       SET mini_enabled = p_enabled, updated_at = now()
     WHERE id = v_pool;
  END IF;

  SELECT COALESCE(mini_enabled, true) INTO v_now FROM public.bbj_pools WHERE id = v_pool;
  RETURN jsonb_build_object('ok', true, 'pool_id', v_pool, 'mini_enabled', v_now);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_set_club_mini_enabled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_set_club_mini_enabled(uuid, boolean) TO authenticated, service_role;

DO $$
BEGIN
  IF position('auth.uid()' IN
       pg_get_functiondef('public.fn_bbj_set_club_mini_enabled(uuid, boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the mini switch must name its own actor';
  END IF;
  IF position('not_signed_in' IN
       pg_get_functiondef('public.fn_bbj_set_club_mini_enabled(uuid, boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the mini switch must refuse a caller with no session';
  END IF;
END $$;

COMMIT;
