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

CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_st text;
  v_msg text;
  v_floor numeric;
  v_min numeric;
  v_max numeric;
  v_eff numeric;
BEGIN
  PERFORM set_config('app.money_path', 'fn_horse_seat_from_treasury', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  /* A KEYED CALL IS ANSWERED ONCE. The engine funds a rebuy from a bust it
     has already seen; a retry after a lost response must not fund it twice.
     With no key this is the old behaviour exactly. */
  IF p_op_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'horse_fund:' || p_op_id::text) THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'op_id', p_op_id);
  END IF;

  SELECT club_id, min_buy_in, max_buy_in INTO v_club_id, v_min, v_max FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to seat from club treasury');
  END IF;

  -- CHIP CONTINUITY (I7): the same floor a human meets at atomic_table_buyin.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
  v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  IF v_max IS NOT NULL AND v_max > 0 AND p_amount > GREATEST(v_max, COALESCE(v_floor, 0)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'BUYIN_ABOVE_MAX');
  END IF;
  IF v_floor IS NOT NULL THEN
    v_eff := GREATEST(COALESCE(v_min, 0), v_floor);
    -- The return floor is never reduced to the ordinary maximum.
    IF p_amount < v_eff THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYIN_BELOW_FLOOR', 'required', v_eff);
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  -- CHIP CONTINUITY: the session opens with the seat, baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  BEGIN
    /* PHASE 7.2 (2026-09-06): the leg NAMES THE PLAYER and carries the
       caller's key when it has one. Before this a horse funding said only
       that a table was funded: 9,252 legs in seven days, none naming the
       seat, so no per-seat audit could read them and a replay could not be
       told from a second horse buying in for the same amount at the same
       table. The key is optional: without it nothing changes but the name. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description, idempotency_key, metadata)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Seated + funded from club treasury (fn_horse_seat_from_treasury) for ' || p_user_id::text,
      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'horse_fund:' || p_op_id::text END,
      jsonb_build_object('user_id', p_user_id, 'op_id', p_op_id, 'door', 'fn_horse_seat_from_treasury'));
  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_claim_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  INSERT INTO public.entry_purchase_idempotency_receipts
    (key_domain, idempotency_key, request)
  VALUES (p_key_domain, p_idempotency_key, p_request)
  ON CONFLICT (key_domain, idempotency_key) DO NOTHING
  RETURNING request, response INTO v_request, v_response;
  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  /* The unique-index wait above cannot observe an uncommitted placeholder.
     A committed placeholder without a response means some code violated the
     same-transaction contract, so it is corruption-not permission to rerun
     a money core. */
  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key is already bound to a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NULL THEN
    RAISE EXCEPTION
      'INCOMPLETE_IDEMPOTENCY_RECEIPT: % key was committed without its response',
      p_key_domain
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('claimed', false, 'response', v_response);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_record_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb, p_response jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN p_response;
  END IF;
  IF p_request IS NULL OR p_response IS NULL THEN
    RAISE EXCEPTION 'entry purchase receipts require a non-null request and response'
      USING ERRCODE = '22004';
  END IF;

  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key completed concurrently for a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NOT NULL THEN
    RETURN v_response;
  END IF;

  UPDATE public.entry_purchase_idempotency_receipts r
     SET response = p_response,
         completed_at = transaction_timestamp()
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key
     AND r.request IS NOT DISTINCT FROM p_request
     AND r.response IS NULL
  RETURNING r.response INTO STRICT v_response;
  RETURN v_response;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_entry_purchase_receipt(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_record_entry_purchase_receipt(text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
