SET LOCAL lock_timeout = '1000ms';
SET LOCAL statement_timeout = '15000ms';
-- FWP01 scratch candidate: version/path reserved by integration owner later.
-- Scope only the overseer authorization alternative and its recursive club rows.
-- No table data, amount allocator, helper, signature, owner or ACL changes.
DO $migration$
DECLARE
  v_oid oid := to_regprocedure('public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)');
  v_definition text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'FWP01 target missing'; END IF;
  SELECT pg_get_functiondef(v_oid), jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'volatile',provolatile,'definer',prosecdef)
    INTO v_definition,v_before FROM pg_proc WHERE oid=v_oid;
  IF (SELECT proowner <> 'postgres'::regrole OR NOT prosecdef OR provolatile <> 's'
       OR proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
       OR (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(proacl) x)
          IS DISTINCT FROM ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']::text[]
       FROM pg_proc WHERE oid=v_oid) THEN RAISE EXCEPTION 'FWP01 authority metadata drift'; END IF;
  IF md5(v_definition) = '21fc983f3a464397bca00b053c4e6ec9' THEN RETURN; END IF;
  IF md5(v_definition) <> '1bf9f0db76d063512cf9945493cc2342' THEN RAISE EXCEPTION 'FWP01 target definition drift'; END IF;
  IF (length(v_definition)-length(replace(v_definition,$old0$  v_tail_start timestamptz;$old0$,''))) / length($old0$  v_tail_start timestamptz;$old0$) <> 1 THEN RAISE EXCEPTION 'FWP01 snippet 0 drift'; END IF;
  v_definition := replace(v_definition,$old0$  v_tail_start timestamptz;$old0$,$new0$  v_tail_start timestamptz;
  v_overseer_clubs uuid[];$new0$);
  IF (length(v_definition)-length(replace(v_definition,$old1$     AND NOT EXISTS (
       SELECT 1 FROM union_clubs uc
        WHERE (p_club_id IS NULL OR uc.club_id = p_club_id)
          AND public.fn_is_union_overseer(uc.union_id, v_caller))
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
$old1$,''))) / length($old1$     AND NOT EXISTS (
       SELECT 1 FROM union_clubs uc
        WHERE (p_club_id IS NULL OR uc.club_id = p_club_id)
          AND public.fn_is_union_overseer(uc.union_id, v_caller))
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
$old1$) <> 1 THEN RAISE EXCEPTION 'FWP01 snippet 1 drift'; END IF;
  v_definition := replace(v_definition,$old1$     AND NOT EXISTS (
       SELECT 1 FROM union_clubs uc
        WHERE (p_club_id IS NULL OR uc.club_id = p_club_id)
          AND public.fn_is_union_overseer(uc.union_id, v_caller))
     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
  THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
$old1$,$new1$     AND NOT (p_club_id IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id))
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
$new1$);
  IF (length(v_definition)-length(replace(v_definition,$old2$       AND (p_club_id IS NULL OR a.club_id = p_club_id)
    UNION ALL$old2$,''))) / length($old2$       AND (p_club_id IS NULL OR a.club_id = p_club_id)
    UNION ALL$old2$) <> 1 THEN RAISE EXCEPTION 'FWP01 snippet 2 drift'; END IF;
  v_definition := replace(v_definition,$old2$       AND (p_club_id IS NULL OR a.club_id = p_club_id)
    UNION ALL$old2$,$new2$       AND (p_club_id IS NULL OR a.club_id = p_club_id)
       AND (v_overseer_clubs IS NULL OR a.club_id = ANY(v_overseer_clubs))
    UNION ALL$new2$);
  IF (length(v_definition)-length(replace(v_definition,$old3$     WHERE c.status = 'active'
  ),$old3$,''))) / length($old3$     WHERE c.status = 'active'
  ),$old3$) <> 1 THEN RAISE EXCEPTION 'FWP01 snippet 3 drift'; END IF;
  v_definition := replace(v_definition,$old3$     WHERE c.status = 'active'
  ),$old3$,$new3$     WHERE c.status = 'active'
       AND (v_overseer_clubs IS NULL OR c.club_id = ANY(v_overseer_clubs))
  ),$new3$);
  EXECUTE v_definition;
  SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,'volatile',provolatile,'definer',prosecdef)
    INTO v_after FROM pg_proc WHERE oid=v_oid;
  IF v_after IS DISTINCT FROM v_before OR md5(pg_get_functiondef(v_oid)) <> '21fc983f3a464397bca00b053c4e6ec9' THEN
    RAISE EXCEPTION 'FWP01 postcondition failed';
  END IF;
END;
$migration$;
NOTIFY pgrst, 'reload schema';
