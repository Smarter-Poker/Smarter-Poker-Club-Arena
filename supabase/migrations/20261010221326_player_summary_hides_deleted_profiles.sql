-- Member summary and displayed upline identities use authoritative deletion status.
-- Live Shark summary counted 595 while the readable directory contained 533;
-- active descendants printed deleted upline names. Preserve membership edges,
-- historical fees and active descendants, and fix missing-profile authorization.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $patch$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_members_summary(uuid)'::regprocedure) INTO v_definition;
 IF md5(v_definition)<>'784a8511f0d5f60838ba9ddf35beadc5' THEN RAISE EXCEPTION 'Member summary preimage changed; qualify current source'; END IF;
 v_old := $old$    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);$old$;
 v_new := $new$    v_platform_admin := coalesce(v_platform_admin, false);
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member summary replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$  LEFT JOIN public.profiles pr ON pr.id = b.user_id;$old$;
 v_new := $new$  LEFT JOIN public.profiles pr ON pr.id = b.user_id
  WHERE pr.status IS DISTINCT FROM 'deleted';$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member summary replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 EXECUTE v_definition;
 SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure) INTO v_definition;
 IF md5(v_definition)<>'c8db941a412d88ccfb075d3d5c9cd32d' THEN RAISE EXCEPTION 'Member summary preimage changed; qualify current source'; END IF;
 v_old := $old$     WHERE u.id = b.m_agent_id$old$;
 v_new := $new$     WHERE u.id = b.m_agent_id
       AND u.status IS DISTINCT FROM 'deleted'$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member summary replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 EXECUTE v_definition;
 SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure) INTO v_definition;
 IF md5(v_definition)<>'f759121885ceda3a05158cb28c9c3e34' THEN RAISE EXCEPTION 'Member summary preimage changed; qualify current source'; END IF;
 v_old := $old$      FROM public.profiles u WHERE u.id = m.agent_id$old$;
 v_new := $new$      FROM public.profiles u WHERE u.id = m.agent_id
        AND u.status IS DISTINCT FROM 'deleted'$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member summary replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 EXECUTE v_definition;
END
$patch$;
COMMIT;
