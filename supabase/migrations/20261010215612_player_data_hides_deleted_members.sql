-- Omit authoritative deleted identities and count only visible downlines.
-- Keep recursive edges: active descendants beneath deleted parents remain visible.
-- Historical financial facts, authorization and original grants remain intact.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $patch$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure) INTO v_definition;
 IF md5(v_definition)<>'bd63036f5a09615561b6d0cb6f958f61' THEN RAISE EXCEPTION 'Member data preimage changed; qualify current source'; END IF;
 v_old := $old$  IF v_access = 'none' OR v_scope IS NULL THEN
    RETURN NULL;
  END IF;$old$;
 v_new := $new$  IF v_access = 'none' OR v_scope IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.club_members cm
    LEFT JOIN public.profiles profile ON profile.id = cm.user_id
    WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
      AND coalesce(cm.status, 'approved') IN ('active', 'approved')
      AND profile.status IS DISTINCT FROM 'deleted'
  ) THEN
    RETURN jsonb_build_object('identity', jsonb_build_object('user_id', NULL));
  END IF;$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member data replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$           count(DISTINCT child)::int AS total FROM tree$old$;
 v_new := $new$           count(DISTINCT child)::int AS total FROM tree
      LEFT JOIN public.profiles downline_profile ON downline_profile.id = tree.child
     WHERE downline_profile.status IS DISTINCT FROM 'deleted'$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member data replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 EXECUTE v_definition;
 SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure) INTO v_definition;
 IF md5(v_definition)<>'ead8ba8e19c06670dcf4d426807b1a50' THEN RAISE EXCEPTION 'Member data preimage changed; qualify current source'; END IF;
 v_old := $old$    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);$old$;
 v_new := $new$    v_platform_admin := coalesce(v_platform_admin, false);
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Roster authority preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$      FROM closure c
     GROUP BY c.root$old$;
 v_new := $new$      FROM closure c
      LEFT JOIN public.profiles downline_profile ON downline_profile.id = c.descendant
     WHERE downline_profile.status IS DISTINCT FROM 'deleted'
     GROUP BY c.root$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member data replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$  ) up ON true;$old$;
 v_new := $new$  ) up ON true
  WHERE pr.status IS DISTINCT FROM 'deleted';$new$;
 IF strpos(v_definition,v_old)=0 THEN RAISE EXCEPTION 'Member data replacement preimage missing'; END IF;
 v_definition := replace(v_definition,v_old,v_new);
 EXECUTE v_definition;
END
$patch$;
COMMIT;
