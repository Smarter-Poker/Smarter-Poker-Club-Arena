-- Version reserved by scripts/new-migration.mjs against origin/main and remote branches.
-- Owner 2026-10-26: an agent sees self and every descendant, never the club.
-- The screen already filters every fact and seated stack by this private helper.
-- UNION on user identity terminates cycles without truncating deep hierarchies.
-- No money, membership, grants to browser roles, or reporting totals change.
-- @live-proof: position('tree(uid)' IN pg_get_functiondef('public.fn_ca_club_data_downline(uuid,uuid)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $guard$
BEGIN
  IF current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'downline migration requires the maintained installer';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_club_data_downline(uuid,uuid)'::regprocedure)
       IS DISTINCT FROM 'cdcdbc2920121a440397f2279678b20b' THEN
    RAISE EXCEPTION 'Club Data downline preimage changed';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_club_data_downline(p_club_id uuid, p_user uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $function$
  WITH RECURSIVE edges AS MATERIALIZED (
    SELECT cm.user_id AS child, cm.agent_id AS parent
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.agent_id IS NOT NULL AND cm.agent_id <> cm.user_id
  ), tree(uid) AS (
    SELECT p_user WHERE p_user IS NOT NULL
    UNION
    SELECT e.child FROM tree t JOIN edges e ON e.parent = t.uid
  )
  SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::uuid[]) FROM tree;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_data_downline(uuid,uuid) FROM PUBLIC,anon,authenticated;
COMMIT;
