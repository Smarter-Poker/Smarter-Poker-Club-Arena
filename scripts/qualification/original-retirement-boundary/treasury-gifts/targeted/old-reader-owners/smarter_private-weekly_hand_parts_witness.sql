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
