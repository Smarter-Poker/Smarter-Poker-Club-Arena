SET LOCAL check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_cash_outcome_accepted(o union_pnl_cash_outcomes)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT o.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb
  AND o.evidence->'game_scope' IS NOT DISTINCT FROM o.game_scope
  AND ((o.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND o.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions r WHERE r.table_id=o.table_id AND r.hand_number=o.hand_number
    AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text))
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes actual
     WHERE actual.table_id=o.table_id AND actual.hand_number=o.hand_number
      AND to_jsonb(actual) IS NOT DISTINCT FROM to_jsonb(o)
      AND smarter_private.posthand_escrow_certified_evidence(o.table_id,o.hand_number) IS NOT NULL))
$function$
;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_hand_lines(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS TABLE(hand_accepted_rake text, hand_participants jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT h.accepted_rake,
   CASE WHEN h.shaped AND cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_touch(h) ELSE h.participants END
   FROM public.union_pnl_cash_outcome_touches h
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(h.table_id,h.hand_number)
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end;
 ELSE
  RETURN QUERY SELECT o.evidence->>'accepted_rake',
   CASE WHEN cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_participants(o) ELSE o.evidence->'participants' END
   FROM public.union_pnl_cash_outcomes o
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(o.table_id,o.hand_number)
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 END IF;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_witness(p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE n bigint;
BEGIN
 IF current_setting('session_replication_role') IS DISTINCT FROM 'origin'
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_hand_parts_original_sources_unqualified';END IF;
 SELECT count(*) INTO n FROM (VALUES ('public.fn_union_pnl_projection_ready(text)','5f643c03d3595c20354d753087988476'),('public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)','0c69388b1406858f3bed04f54639fab6'),('public.fn_accounting_close_windows(timestamp with time zone,timestamp with time zone)','349f940293dfe6175faae2787840ede1'),('public.fn_union_pnl_posthand_escrow_participants(union_pnl_cash_outcomes)','2db7263f8d42e2e0e5a45b42b7198e4d'),('public.fn_union_pnl_posthand_escrow_touch(union_pnl_cash_outcome_touches)','e51decda42bbe46dd90aaf1bd3119023'),('public.fn_accounting_close_proof_lifetime()','80e026be0041fd1bdb04114c87ec368c'),('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)','0c3a826553e9ef65a03030c3ef78eaaf'),('public.fn_union_pnl_inventory_immutable()','307d83a1ee3d912bade24c48144aa801'),('smarter_private.posthand_escrow_certificate_immutable()','14b1ddb37d4e3e83a9a42a34438e4b6e'))x(signature,hash) JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)
 WHERE p.proowner='postgres'::regrole AND md5(pg_get_functiondef(p.oid))=x.hash;
 IF n IS DISTINCT FROM 9::bigint THEN RAISE EXCEPTION 'weekly_hand_parts_original_owners_changed';END IF;
 SELECT count(*) INTO n FROM(VALUES ('public.union_pnl_cash_outcomes','original_pnl_immutable',58,'public.fn_union_pnl_inventory_immutable()'),('public.union_pnl_cash_outcome_touches','original_pnl_immutable',58,'public.fn_union_pnl_inventory_immutable()'),('public.union_pnl_cash_outcome_link_resolutions','original_pnl_immutable',58,'public.fn_union_pnl_inventory_immutable()'),('smarter_private.posthand_escrow_certificates','posthand_escrow_certificate_immutable',31,'smarter_private.posthand_escrow_certificate_immutable()'),('smarter_private.posthand_escrow_certificates','posthand_escrow_certificate_no_truncate',34,'smarter_private.posthand_escrow_certificate_immutable()'))x(rel,name,kind,fn) JOIN pg_trigger t ON t.tgrelid=to_regclass(x.rel) AND t.tgname=x.name
 WHERE NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgtype=x.kind AND t.tgfoid=to_regprocedure(x.fn) AND t.tgqual IS NULL AND t.tgnargs=0;
 IF n IS DISTINCT FROM 5::bigint THEN RAISE EXCEPTION 'weekly_hand_parts_append_only_contract_changed';END IF;
 IF p_projected IS DISTINCT FROM public.fn_union_pnl_projection_ready('cash_outcome_touches') THEN RAISE EXCEPTION 'weekly_hand_parts_projection_changed';END IF;
 RETURN jsonb_build_object('ordinary_count',CASE WHEN p_projected THEN
 (SELECT count(*) FROM public.union_pnl_cash_outcome_touches h WHERE h.game_union_id=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end)
 ELSE (SELECT count(*) FROM public.union_pnl_cash_outcomes h WHERE h.game_scope->>'game_union_id'=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end) END,
 -- Link ownership comes from the immutable resolution, while recognition comes
 -- from the original outcome, exactly as the original linked reader requires.
 'links',(SELECT count(*) FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'=p_union::text AND o.recognized_at>=p_start AND o.recognized_at<p_end),
 -- Only certificates consulted by the ordinary reader can change this window.
 -- Linked outcomes carry their original resolved evidence and do not read these.
 'escrow_certificates',CASE WHEN p_projected THEN
 (SELECT count(*) FROM public.union_pnl_cash_outcome_touches h
 JOIN smarter_private.posthand_escrow_certificates c ON c.table_id=h.table_id AND c.hand_number=h.hand_number
 WHERE h.game_union_id=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end)
 ELSE(SELECT count(*) FROM public.union_pnl_cash_outcomes h
 JOIN smarter_private.posthand_escrow_certificates c ON c.table_id=h.table_id AND c.hand_number=h.hand_number
 WHERE h.game_scope->>'game_union_id'=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end)END);
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_read(p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_generation text, p_projected boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE w record;p record;groups jsonb:='[]';n bigint;expected bigint;
BEGIN
 IF current_setting('app.weekly_accounting_chunked',true) IS DISTINCT FROM 'on' OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on' THEN RETURN NULL;END IF;
 IF p_generation IS NULL OR p_generation='original-inventory-245:unqualified' THEN RETURN NULL;END IF;
 SELECT count(*) INTO expected FROM public.fn_accounting_close_windows(p_start,p_end);
 SELECT count(*) INTO n FROM public.accounting_close_partials WHERE kind='pnl_hands_window' AND union_id=p_union AND period_start=p_start AND period_end=p_end;
 IF expected=0 OR n<>expected THEN RETURN NULL;END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
 SELECT * INTO p FROM public.accounting_close_partials WHERE kind='pnl_hands_window' AND union_id=p_union AND period_start=p_start AND period_end=p_end AND window_start=w.window_start;
 IF NOT FOUND OR p.window_end IS DISTINCT FROM w.window_end OR p.computed_at<p_end OR p.computed_at<=clock_timestamp()-public.fn_accounting_close_proof_lifetime()
 OR p.value->>'generation' IS DISTINCT FROM p_generation OR p.value->'projected' IS DISTINCT FROM to_jsonb(p_projected)
 OR p.computed_at>clock_timestamp() OR jsonb_typeof(p.value->'groups') IS DISTINCT FROM 'array' OR p.value->>'groups_md5' IS DISTINCT FROM md5((p.value->'groups')::text)
 OR p.value->>'contract' IS DISTINCT FROM 'd4665eb6e43425a93816c55ded55f644'
 OR p.value->'witness' IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union,w.window_start,w.window_end,p_projected)
 THEN RETURN NULL;END IF;
 groups:=groups||(p.value->'groups');
 END LOOP;
 RETURN(SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY kind,club_id,user_id),'[]'::jsonb) FROM(
 SELECT kind,club_id,user_id,sum(delta)delta,sum(hands)::bigint hands,sum(rake)rake
 FROM jsonb_to_recordset(groups)x(kind integer,club_id uuid,user_id uuid,delta numeric,hands bigint,rake numeric)GROUP BY kind,club_id,user_id)q);
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_reduce(p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
 SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY kind,club_id,user_id),'[]'::jsonb) FROM(
 SELECT x.kind,x.club_id,x.user_id,sum(x.delta)delta,count(*)hands,sum(x.rake)rake
 FROM(SELECT h.hand_accepted_rake accepted_rake,h.hand_participants participants FROM public.fn_union_pnl_week_hand_lines(p_union,p_start,p_end,p_projected)h
 UNION ALL SELECT k.evidence->>'accepted_rake',k.evidence->'participants' FROM public.fn_union_pnl_linked_cash_outcomes(p_union,p_start,p_end)k)o
 CROSS JOIN LATERAL(SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,o.accepted_rake::numeric rake
 UNION ALL SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric FROM jsonb_array_elements(COALESCE(o.participants,'[]'))p)x
 GROUP BY x.kind,x.club_id,x.user_id)q
$function$
;
REVOKE ALL ON FUNCTION smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;
SET LOCAL check_function_bodies=on;
