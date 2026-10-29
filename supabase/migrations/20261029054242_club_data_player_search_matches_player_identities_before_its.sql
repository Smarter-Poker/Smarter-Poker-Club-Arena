-- Club Data searches a player's identity, not every player below that upline.
-- The generic Players roster deliberately also matches club/upline names. Its
-- first alphabetical page can hide the requested player behind 20 downlines.
-- Keep that roster unchanged; filter identities and authorized record access
-- before this bounded limit, with exact matches first. No financial writes.
-- @live-proof: (SELECT count(*)=1 AND bool_and(md5(pg_get_functiondef(p.oid))='c4f40e11045bd1f18435199232fa7bad' AND p.prosecdef AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')) FROM pg_proc p WHERE p.oid=to_regprocedure('public.ca_club_data_player_search(uuid,text,integer)'))
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

CREATE FUNCTION public.ca_club_data_player_search(p_club_id uuid, p_search text, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_search text := lower(left(btrim(coalesce(p_search, '')), 120));
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 20));
  v_items jsonb;
BEGIN
  IF (auth.uid() IS NULL AND coalesce(auth.role(), '') <> 'service_role')
     OR public.fn_ca_club_data_scope(p_club_id) IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_search = '' THEN
    RETURN jsonb_build_object('items', '[]'::jsonb);
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(m) - 'match_rank' ORDER BY m.match_rank, lower(m.alias), m.user_id), '[]'::jsonb)
    INTO v_items
    FROM (
      SELECT r.user_id, r.management_club_id, r.alias, r.username,
             r.player_number, r.can_view_financials,
             CASE WHEN v_search IN (lower(r.alias), lower(r.username), lower(r.player_number)) THEN 0
                  WHEN position(v_search IN lower(r.alias)) = 1
                    OR position(v_search IN lower(r.username)) = 1
                    OR position(v_search IN lower(r.player_number)) = 1 THEN 1
                  ELSE 2 END AS match_rank
        FROM public.ca_club_roster_rows(p_club_id) r
       WHERE r.can_view_financials
         AND (position(v_search IN lower(r.alias)) > 0
           OR position(v_search IN lower(r.username)) > 0
           OR position(v_search IN lower(r.player_number)) > 0)
       ORDER BY match_rank, lower(r.alias), r.user_id
       LIMIT v_limit
    ) m;
  RETURN jsonb_build_object('items', v_items);
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_club_data_player_search(uuid,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_data_player_search(uuid,text,integer) TO authenticated, service_role;
COMMIT;
