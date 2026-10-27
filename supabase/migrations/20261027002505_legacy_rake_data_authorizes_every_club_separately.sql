-- Version reserved by scripts/new-migration.mjs.
-- Data access only: missing-club legacy reads authorize each root club,
-- including the summary's rate, without changing rake or commission arithmetic.
-- Recursive agency edges cannot cross clubs or repeat a cycle.
-- @live-proof: position('fn_ca_authorized_agent_data_clubs' IN pg_get_functiondef('public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure)) > 0 AND position('fn_ca_authorized_agent_data_clubs' IN pg_get_functiondef('public.fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $guard$
BEGIN
  IF current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'Legacy Data migration requires the maintained installer';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure) IS DISTINCT FROM '2235095280ba23d879d7318bc889e833' THEN
    RAISE EXCEPTION 'Legacy Data preimage changed: fn_agent_downline_rake';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM '98baca865fd8c9f04ad0dcbdfc49dca7' THEN
    RAISE EXCEPTION 'Legacy Data preimage changed: fn_agent_downline_rake_summary';
  END IF;
END;
$guard$;
CREATE FUNCTION public.fn_ca_authorized_agent_data_clubs(p_root uuid, p_club uuid)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $helper$
DECLARE
  v_caller uuid := auth.uid();
  v_clubs uuid[];
BEGIN
  -- A browser's optional club never makes authority global. Resolve every
  -- root club against the same current Data scope as the protected screen.
  SELECT array_agg(DISTINCT a.club_id) INTO v_clubs
    FROM public.agents a
   WHERE a.user_id = p_root AND a.status = 'active'
     AND a.role IN ('super_agent','agent','sub_agent')
     AND (p_club IS NULL OR a.club_id = p_club)
     AND (
       public.fn_ca_club_data_scope(a.club_id) = 'club'
       OR (public.fn_ca_club_data_scope(a.club_id) = 'downline'
           AND p_root = ANY(public.fn_ca_club_data_downline(a.club_id, v_caller)))
       OR EXISTS (SELECT 1 FROM public.union_clubs uc
                   WHERE uc.club_id = a.club_id AND public.ca_can_oversee_union(uc.union_id))
     );
  IF COALESCE(cardinality(v_clubs), 0) = 0 THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  RETURN v_clubs;
END;
$helper$;
REVOKE ALL ON FUNCTION public.fn_ca_authorized_agent_data_clubs(uuid,uuid) FROM PUBLIC, anon, authenticated;

DO $patch$
DECLARE
  v_oid oid := 'public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure;
  v_definition text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  SELECT pg_get_functiondef(oid),jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'volatile',provolatile,'definer',prosecdef)
    INTO v_definition,v_before FROM pg_proc WHERE oid=v_oid;
  IF (length(v_definition)-length(replace(v_definition,$before0$v_overseer_clubs uuid[];$before0$,''))) / length($before0$v_overseer_clubs uuid[];$before0$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 0';
  END IF;
  v_definition := replace(v_definition,$before0$v_overseer_clubs uuid[];$before0$,$after0$v_authorized_clubs uuid[];$after0$);
  IF (length(v_definition)-length(replace(v_definition,$before1$  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    -- Only the overseer alternative is scoped here; retain self, ancestor,
    -- explicit club-admin and existing null-caller service behavior above.
    SELECT array_agg(DISTINCT a.club_id) INTO v_overseer_clubs
      FROM agents a
      JOIN union_clubs uc ON uc.club_id = a.club_id
     WHERE a.user_id = v_root AND a.status = 'active'
       AND a.role IN ('super_agent','agent','sub_agent')
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND public.fn_is_union_overseer(uc.union_id, v_caller);
    IF COALESCE(cardinality(v_overseer_clubs), 0) = 0 THEN
      RAISE EXCEPTION 'not_authorised';
    END IF;
  END IF;

$before1$,''))) / length($before1$  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    -- Only the overseer alternative is scoped here; retain self, ancestor,
    -- explicit club-admin and existing null-caller service behavior above.
    SELECT array_agg(DISTINCT a.club_id) INTO v_overseer_clubs
      FROM agents a
      JOIN union_clubs uc ON uc.club_id = a.club_id
     WHERE a.user_id = v_root AND a.status = 'active'
       AND a.role IN ('super_agent','agent','sub_agent')
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND public.fn_is_union_overseer(uc.union_id, v_caller);
    IF COALESCE(cardinality(v_overseer_clubs), 0) = 0 THEN
      RAISE EXCEPTION 'not_authorised';
    END IF;
  END IF;

$before1$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 1';
  END IF;
  v_definition := replace(v_definition,$before1$  IF v_caller IS NOT NULL
     AND v_caller <> v_root
     AND NOT public.fn_is_agent_ancestor(v_caller, v_root, p_club_id)
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    -- Only the overseer alternative is scoped here; retain self, ancestor,
    -- explicit club-admin and existing null-caller service behavior above.
    SELECT array_agg(DISTINCT a.club_id) INTO v_overseer_clubs
      FROM agents a
      JOIN union_clubs uc ON uc.club_id = a.club_id
     WHERE a.user_id = v_root AND a.status = 'active'
       AND a.role IN ('super_agent','agent','sub_agent')
       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND public.fn_is_union_overseer(uc.union_id, v_caller);
    IF COALESCE(cardinality(v_overseer_clubs), 0) = 0 THEN
      RAISE EXCEPTION 'not_authorised';
    END IF;
  END IF;

$before1$,$after1$  v_authorized_clubs := public.fn_ca_authorized_agent_data_clubs(v_root, p_club_id);

$after1$);
  IF (length(v_definition)-length(replace(v_definition,$before2$RAISE EXCEPTION 'not_an_agent';$before2$,''))) / length($before2$RAISE EXCEPTION 'not_an_agent';$before2$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 2';
  END IF;
  v_definition := replace(v_definition,$before2$RAISE EXCEPTION 'not_an_agent';$before2$,$after2$RAISE EXCEPTION 'not_an_agent' USING ERRCODE = '42501';$after2$);
  IF (length(v_definition)-length(replace(v_definition,$before3$AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))$before3$,''))) / length($before3$AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))$before3$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 3';
  END IF;
  v_definition := replace(v_definition,$before3$AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))$before3$,$after3$AND a.club_id = ANY(v_authorized_clubs)$after3$);
  IF (length(v_definition)-length(replace(v_definition,$before4$AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))$before4$,''))) / length($before4$AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))$before4$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 4';
  END IF;
  v_definition := replace(v_definition,$before4$AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))$before4$,$after4$AND c.club_id = ch.club_id AND c.club_id = ANY(v_authorized_clubs)
       AND c.id <> ALL(ch.path)$after4$);
  IF (length(v_definition)-length(replace(v_definition,$before5$a.parent_agent_id, 0 AS depth$before5$,''))) / length($before5$a.parent_agent_id, 0 AS depth$before5$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 5';
  END IF;
  v_definition := replace(v_definition,$before5$a.parent_agent_id, 0 AS depth$before5$,$after5$a.parent_agent_id, 0 AS depth, ARRAY[a.id]::uuid[] AS path$after5$);
  IF (length(v_definition)-length(replace(v_definition,$before6$c.parent_agent_id, ch.depth + 1$before6$,''))) / length($before6$c.parent_agent_id, ch.depth + 1$before6$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 6';
  END IF;
  v_definition := replace(v_definition,$before6$c.parent_agent_id, ch.depth + 1$before6$,$after6$c.parent_agent_id, ch.depth + 1, ch.path || c.id$after6$);
  EXECUTE v_definition;
  SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'volatile',provolatile,'definer',prosecdef)
    INTO v_after FROM pg_proc WHERE oid=v_oid;
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'Legacy Data authority metadata changed';
  END IF;
END;
$patch$;
DO $patch$
DECLARE
  v_oid oid := 'public.fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
  v_definition text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  SELECT pg_get_functiondef(oid),jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'volatile',provolatile,'definer',prosecdef)
    INTO v_definition,v_before FROM pg_proc WHERE oid=v_oid;
  IF (length(v_definition)-length(replace(v_definition,$before0$  v_rate numeric;$before0$,''))) / length($before0$  v_rate numeric;$before0$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 0';
  END IF;
  v_definition := replace(v_definition,$before0$  v_rate numeric;$before0$,$after0$  v_rate numeric;
  v_authorized_clubs uuid[];$after0$);
  IF (length(v_definition)-length(replace(v_definition,$before1$BEGIN
  SELECT a.commission_rate$before1$,''))) / length($before1$BEGIN
  SELECT a.commission_rate$before1$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 1';
  END IF;
  v_definition := replace(v_definition,$before1$BEGIN
  SELECT a.commission_rate$before1$,$after1$BEGIN
  v_authorized_clubs := public.fn_ca_authorized_agent_data_clubs(v_root, p_club_id);
  SELECT a.commission_rate$after1$);
  IF (length(v_definition)-length(replace(v_definition,$before2$     AND (p_club_id IS NULL OR a.club_id = p_club_id)$before2$,''))) / length($before2$     AND (p_club_id IS NULL OR a.club_id = p_club_id)$before2$) <> 1 THEN
    RAISE EXCEPTION 'Legacy Data source fragment changed: 2';
  END IF;
  v_definition := replace(v_definition,$before2$     AND (p_club_id IS NULL OR a.club_id = p_club_id)$before2$,$after2$     AND a.club_id = ANY(v_authorized_clubs)$after2$);
  EXECUTE v_definition;
  SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'volatile',provolatile,'definer',prosecdef)
    INTO v_after FROM pg_proc WHERE oid=v_oid;
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'Legacy Data authority metadata changed';
  END IF;
END;
$patch$;
COMMIT;
