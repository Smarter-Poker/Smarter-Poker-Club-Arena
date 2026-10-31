CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_advance(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE w record; r record; began timestamptz; proved boolean:=false;

 v_l_value jsonb;v_l_key jsonb;v_l_witness jsonb;v_l_counts jsonb;
 v_l_valid boolean;v_l_name text;v_l_number numeric;
 v_l_cached record;
 stop_at timestamptz; v_generation text; v_bad bigint; v_flows jsonb; v_windows bigint; v_fresh bigint;v_hand_projected boolean;v_hand_witness jsonb;v_hand_groups jsonb;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR p_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 -- THE STATEMENT'S OWN CLOCK (20261015b): an attempt can begin late in its
 -- tick (job 272 visits other scopes first in the same 240 s statement), so a
 -- proving loop also stops a minute before the statement itself would be
 -- cancelled, not only 120 s after the attempt began.
 stop_at:=began+interval '120 seconds';
 IF current_setting('statement_timeout') NOT IN ('0','0ms') THEN
  stop_at:=LEAST(stop_at,statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds');
 END IF;
 IF public.fn_accounting_close_certificate('earned_plan',p_union_id,p_start,p_end) IS NULL THEN
 DELETE FROM public.accounting_close_partials WHERE computed_at<clock_timestamp()-interval '8 days';
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='earned_plan_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime());
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
  IF NOT FOUND THEN
   -- v3 over the same window refuses exactly what it refuses in the week.
   PERFORM public.fn_accounting_union_earned_plan_v3(p_union_id,w.window_start,w.window_end);
   RAISE EXCEPTION 'union_earned_plan_window_unproved' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('union_id',p_union_id,'period_start',p_start,'period_end',p_end,'window_start',w.window_start,'window_end',w.window_end)::text;
  END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at)
  VALUES('earned_plan_window',p_union_id,p_start,p_end,w.window_start,w.window_end,r.value,r.cash_ids,r.cash_md5,r.fee_ids,r.fee_md5,clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=EXCLUDED.cash_ids,cash_md5=EXCLUDED.cash_md5,fee_ids=EXCLUDED.fee_ids,fee_md5=EXCLUDED.fee_md5,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 -- PROVING WINDOWS IS A WHOLE ATTEMPT (20261015): an attempt that proved a
 -- window ends here, even when it proved the last one, so the closing boundary
 -- and every later step start the next attempt with the whole budget.
 IF proved THEN RETURN false; END IF;
 END IF;
 -- THE WEEK'S ORIGINAL FLOWS ARE PROVED TWO HOURS AT A TIME (20261015b).
 -- fn_union_pnl_evidence_report proves the week's original money flows in one
 -- statement (814,510 flows for the 2026-10-05 week: 162 s alone, 2 GB of
 -- temporary files), which cannot fit an attempt of job 272's 240 s statement
 -- once the attempt's preparation and the tick's other scopes have run, so
 -- every attempt that reached it was cancelled and rolled back. The same proof
 -- is made here one plan window at a time (each flow is proved from its own
 -- row and the week's bounds, so the windows partition the week exactly), kept
 -- as partials like the earned-plan windows, and assembled into the very
 -- certificate the report reads, in an attempt of its own. Only while the
 -- report and the week proof are the reviewed definitions, the window proof is
 -- derived from; otherwise the report proves the week itself, as before.
 IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_end>='2026-10-12 07:00Z'::timestamptz THEN
  v_generation:=COALESCE(smarter_private.original_inventory_basis_generation(),'original-inventory-245:unqualified');
 END IF;
 IF v_generation IS NOT DISTINCT FROM 'original-inventory-245:unqualified'
  OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'b23655a15587192f137ae4ad57859742'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'ca8931142b7e8ad6bbac07bd0913d268'
 THEN RETURN true;END IF;
 IF smarter_private.inventory_basis_cache_read(v_generation,false,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL
 OR smarter_private.inventory_basis_cache_read(v_generation,true,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL THEN
 -- Original hand proof progresses only after original flow proof, in its own attempt.
 IF md5(pg_get_functiondef('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM 'a7c22cb171d6d6548707c6aa73fada6d'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '97fc255997a2faeac593b5b1f5420d4c'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)) IS DISTINCT FROM 'd427fd27d163ba72a7dc3cd50866163d'
 THEN RAISE EXCEPTION 'weekly_hand_parts_owner_changed';END IF;
 IF (SELECT count(*) FROM pg_proc WHERE oid IN('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)
  AND proowner='postgres'::regrole AND NOT prosecdef AND provolatile='s' AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'weekly_hand_parts_owner_authority_changed';END IF;
 v_hand_projected:=public.fn_union_pnl_projection_ready('cash_outcome_touches');
 -- ORIGINAL CANONICAL LINKED WINDOWS. New proof kind; no existing hand JSON ABI
 -- changes. An attempt that proves any linked unit ends warming before later work.
 IF v_generation IS NOT NULL AND v_generation<>'original-inventory-245:unqualified'THEN
  FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end)ORDER BY 1 LOOP
   v_l_witness:=smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected);
   v_l_key:=jsonb_build_object('union_id',p_union_id::text,'period_start_epoch',extract(epoch FROM p_start),'period_end_epoch',extract(epoch FROM p_end),'window_start_epoch',extract(epoch FROM w.window_start),'window_end_epoch',extract(epoch FROM w.window_end));v_l_valid:=false;
   SELECT p.*INTO v_l_cached FROM public.accounting_close_partials p WHERE p.kind='pnl_linked_window'
    AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start;
   IF FOUND AND v_l_cached.window_end=w.window_end AND isfinite(v_l_cached.computed_at)
    AND v_l_cached.computed_at>=p_end AND v_l_cached.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
    AND v_l_cached.computed_at<=clock_timestamp()AND v_l_cached.cash_ids IS NULL AND v_l_cached.cash_md5 IS NULL
    AND v_l_cached.fee_ids IS NULL AND v_l_cached.fee_md5 IS NULL THEN
    v_l_value:=v_l_cached.value;

 v_l_valid:=false;
 IF jsonb_typeof(v_l_value)='object'
 AND v_l_value->>'contract'='canonical-linked-validation-v1'
 AND v_l_value->>'generation'=v_generation
 AND v_l_value->'projected'=to_jsonb(v_hand_projected)
 AND v_l_value->>'reader_md5'='798e8c95a26ad587da13151675f47fd1'
 AND v_l_value->>'witness_md5'='a7c22cb171d6d6548707c6aa73fada6d'
 AND v_l_value->'input_key'=v_l_key
 AND v_l_value->'witness'=v_l_witness
 AND v_l_value->>'proof_md5'=md5((v_l_value-'proof_md5')::text)
 AND jsonb_typeof(v_l_value->'counts')='object' THEN
  v_l_counts:=v_l_value->'counts';v_l_valid:=true;
  IF(SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(v_l_counts)key)
    IS DISTINCT FROM ARRAY['bad','resolved','rows','unknown']THEN v_l_valid:=false;END IF;
  IF v_l_valid THEN
   FOREACH v_l_name IN ARRAY ARRAY['rows','bad','resolved','unknown']LOOP
    IF jsonb_typeof(v_l_counts->v_l_name)IS DISTINCT FROM'number'
     OR(v_l_counts->>v_l_name)!~'^[0-9]{1,19}$'THEN v_l_valid:=false;EXIT;END IF;
    v_l_number:=(v_l_counts->>v_l_name)::numeric;
    IF v_l_number>9223372036854775807 THEN v_l_valid:=false;EXIT;END IF;
   END LOOP;
  END IF;
  IF v_l_valid THEN
   IF (v_l_counts->>'rows')::numeric IS DISTINCT FROM
    (v_l_counts->>'bad')::numeric+(v_l_counts->>'resolved')::numeric+(v_l_counts->>'unknown')::numeric THEN v_l_valid:=false;END IF;
  END IF;
 END IF;

   END IF;
   CONTINUE WHEN v_l_valid;
   IF proved AND clock_timestamp()>stop_at THEN RETURN false;END IF;
   -- The canonical reader is a filtered subset of this admitted raw linked
   -- innerjoin bag. An exact zero witness therefore proves an empty result.
   IF (v_l_witness->>'links')::bigint=0 THEN
    v_l_counts:=jsonb_build_object('rows',0,'bad',0,'resolved',0,'unknown',0);
   ELSE
   SELECT jsonb_build_object('rows',count(*),
    'bad',count(*)FILTER(WHERE NOT(k.evidence->>'status'='ready'AND k.evidence->'basis_certified'='true'::jsonb AND k.evidence->'all_players_included'='true'::jsonb)),
    'resolved',count(*)FILTER(WHERE k.evidence->>'status'='ready'AND k.evidence->'basis_certified'='true'::jsonb AND k.evidence->'all_players_included'='true'::jsonb),
    'unknown',count(*)FILTER(WHERE(k.evidence->>'status'='ready'AND k.evidence->'basis_certified'='true'::jsonb AND k.evidence->'all_players_included'='true'::jsonb)IS NULL))
   INTO v_l_counts FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,w.window_start,w.window_end)k;
   END IF;
   IF v_l_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected)
    THEN RAISE EXCEPTION 'weekly_linked_parts_sources_changed_during_window';END IF;
   v_l_value:=jsonb_build_object('contract','canonical-linked-validation-v1','generation',v_generation,
    'projected',v_hand_projected,'reader_md5','798e8c95a26ad587da13151675f47fd1',
    'witness_md5','a7c22cb171d6d6548707c6aa73fada6d','input_key',v_l_key,'witness',v_l_witness,'counts',v_l_counts);
   v_l_value:=v_l_value||jsonb_build_object('proof_md5',md5(v_l_value::text));
   INSERT INTO public.accounting_close_partials AS current_proof(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
   VALUES('pnl_linked_window',p_union_id,p_start,p_end,w.window_start,w.window_end,v_l_value,clock_timestamp())
   ON CONFLICT(kind,union_id,period_start,period_end,window_start)DO UPDATE SET
    window_end=EXCLUDED.window_end,value=EXCLUDED.value,cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at
   WHERE current_proof.window_end IS DISTINCT FROM EXCLUDED.window_end OR current_proof.value IS DISTINCT FROM EXCLUDED.value
    OR current_proof.cash_ids IS NOT NULL OR current_proof.cash_md5 IS NOT NULL OR current_proof.fee_ids IS NOT NULL OR current_proof.fee_md5 IS NOT NULL
    OR NOT isfinite(current_proof.computed_at)OR current_proof.computed_at<p_end
    OR current_proof.computed_at<=clock_timestamp()-public.fn_accounting_close_proof_lifetime()OR current_proof.computed_at>clock_timestamp();
   -- Revalidate after the upsert while its row lock is held: a stale worker
   -- must roll back rather than overwrite a newer committed window proof.
   IF v_l_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected)
    THEN RAISE EXCEPTION 'weekly_linked_parts_sources_changed_during_write';END IF;
   proved:=true;
   -- Batch sound empty units within the original stop budget. At most one
   -- nonempty canonical reader call is allowed in any original attempt.
   IF (v_l_witness->>'links')::bigint>0 THEN RETURN false;END IF;
  END LOOP;
  IF proved THEN RETURN false;END IF;
 END IF;

 IF EXISTS(SELECT FROM public.accounting_close_partials p WHERE p.kind='pnl_hands_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end
 AND NOT EXISTS(SELECT FROM public.fn_accounting_close_windows(p_start,p_end)cw WHERE cw.window_start=p.window_start)) THEN RAISE EXCEPTION 'weekly_hand_parts_noncanonical_window';END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  v_hand_witness:=smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected);
  CONTINUE WHEN EXISTS(SELECT FROM public.accounting_close_partials p WHERE p.kind='pnl_hands_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND p.computed_at<=clock_timestamp() AND jsonb_typeof(p.value->'groups')='array' AND p.value->>'groups_md5'=md5((p.value->'groups')::text)
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation AND p.value->'projected' IS NOT DISTINCT FROM to_jsonb(v_hand_projected)
   AND p.value->>'contract' IS NOT DISTINCT FROM '9dee2921c7b956281be61a3eb9d7df6e' AND p.value->'witness' IS NOT DISTINCT FROM v_hand_witness);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false;END IF;
  DELETE FROM public.accounting_close_certificates WHERE union_id=p_union_id AND period_start=p_start AND period_end=p_end AND kind IN('pnl_clubs','pnl_clubs_problem');
  v_hand_groups:=smarter_private.weekly_hand_parts_reduce(p_union_id,w.window_start,w.window_end,v_hand_projected);
  IF v_hand_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected) THEN RAISE EXCEPTION 'weekly_hand_parts_sources_changed_during_window';END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_hands_window',p_union_id,p_start,p_end,w.window_start,w.window_end,jsonb_build_object('generation',v_generation,'projected',v_hand_projected,'contract','9dee2921c7b956281be61a3eb9d7df6e','witness',v_hand_witness,'groups',v_hand_groups,'groups_md5',md5(v_hand_groups::text)),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved THEN RETURN false;END IF;
 IF smarter_private.weekly_hand_parts_read(p_union_id,p_start,p_end,v_generation,v_hand_projected) IS NULL THEN RETURN false;END IF;
 RETURN true;
 END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  -- A window that found a problem is re-proved after an hour, as the report
  -- re-proves a week whose flows found one.
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
   FROM smarter_private.union_pnl_original_flow_evidence_window(p_union_id,p_start,p_end,w.window_start,w.window_end) f;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_flows_window',p_union_id,p_start,p_end,w.window_start,w.window_end,
   jsonb_build_object('generation',v_generation,'bad',v_bad,'flows',v_flows),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved THEN RETURN false; END IF;
 -- Every window is fresh: the week's flows are its windows' flows and the two
 -- whole-week return families, the same rows the week proof returns.
 SELECT count(*),count(p.window_start) INTO v_windows,v_fresh
  FROM public.fn_accounting_close_windows(p_start,p_end) cw
  LEFT JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation;
 IF v_windows=0 OR v_fresh<>v_windows THEN RETURN false; END IF;
 WITH parts AS MATERIALIZED (
  SELECT p.value FROM public.fn_accounting_close_windows(p_start,p_end) cw
  JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
 ), tails AS MATERIALIZED (
  SELECT t.* FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
  UNION ALL
  SELECT t.* FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
 ) SELECT COALESCE((SELECT sum((value->>'bad')::bigint) FROM parts),0)+(SELECT count(*) FILTER(WHERE NOT valid) FROM tails),
  COALESCE((SELECT jsonb_agg(x.flow) FROM (SELECT e.flow FROM parts CROSS JOIN LATERAL jsonb_array_elements(parts.value->'flows') e(flow)
   UNION ALL SELECT to_jsonb(t) FROM tails t) x),'[]')
 INTO v_bad,v_flows;
 IF v_bad=0 THEN PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows));
 ELSE PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
 -- Assembling the certificate is the attempt's step; the report reads it next.
 RETURN false;
END $function$
