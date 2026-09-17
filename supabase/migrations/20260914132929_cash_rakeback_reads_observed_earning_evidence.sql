-- Read-only earning evidence. No period, commission, balance or invoice is written.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.fn_accounting_terms_at(p_entity_type text,p_entity_key text,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE h public.accounting_agreement_history%ROWTYPE;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_terms_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_entity_type NOT IN('agents','club_members','union_clubs') OR p_entity_type IS NULL
    OR p_entity_key IS NULL OR p_entity_key='' OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 SELECT * INTO h FROM public.accounting_agreement_history
  WHERE entity_type=p_entity_type AND entity_key=p_entity_key AND observed_at<=p_at
  ORDER BY observed_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('history_id',h.id,'observed_at',h.observed_at,'terms',h.after_terms);
END $function$;

CREATE FUNCTION public.fn_accounting_agent_terms_at(p_club_id uuid,p_user_id uuid,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE identities text[]; identity_key text; v jsonb; result jsonb; active_count int:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_terms_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_user_id IS NULL OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 -- Find candidate identities from history, then resolve each identity at the
 -- earning time. A later move/deletion closes the old identity; filtering the
 -- history by club before selecting its latest event would resurrect that row.
 SELECT array_agg(DISTINCT entity_key) INTO identities FROM public.accounting_agreement_history
  WHERE entity_type='agents' AND club_id=p_club_id AND subject_user_id=p_user_id AND observed_at<=p_at;
 IF identities IS NULL THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 FOREACH identity_key IN ARRAY identities LOOP
  v:=public.fn_accounting_terms_at('agents',identity_key,p_at);
  IF v->'terms'->>'club_id'=p_club_id::text AND v->'terms'->>'user_id'=p_user_id::text
     AND v->'terms'->>'status'='active' THEN
   active_count:=active_count+1; result:=v;
  END IF;
 END LOOP;
 IF active_count=0 THEN RAISE EXCEPTION 'accounting_terms_not_active' USING ERRCODE='55000'; END IF;
 IF active_count>1 THEN RAISE EXCEPTION 'accounting_terms_ambiguous' USING ERRCODE='55000'; END IF;
 RETURN result;
END $function$;

CREATE FUNCTION public.fn_cash_rakeback_period_basis(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE
 v_from timestamptz; v_to timestamptz; v_union uuid; source_issues bigint; missing_terms bigint:=0;
 invalid_terms bigint:=0; legacy_pending bigint; paid_conflicts bigint; v record;
 member_receipt jsonb; agent_receipt jsonb; member_terms jsonb; member_agent uuid;
 rows_by_user jsonb:='{}'; item jsonb; histories jsonb; total_cents numeric:=0; basis_rows jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_basis_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_basis_request' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT union_id INTO v_union FROM public.clubs WHERE id=p_club_id;
 -- Missing attribution cannot be assigned to a particular member club. Hold
 -- every affected union preview when a source under its house club is missing,
 -- rather than quietly omitting the unknown beneficiary. Current club routing
 -- is used only to widen this failure check, never to assign a player's credit.
 WITH scoped_records AS (
  SELECT r.* FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
     AND (r.club_id=p_club_id
       OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)
       OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=r.club_id AND house.is_union IS TRUE
          AND v_union IS NOT NULL AND (house.union_id=v_union OR house.id=v_union)))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS NOT TRUE)) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 )
 SELECT count(*) INTO source_issues FROM checks WHERE hand_id IS NULL OR attribution_count=0
  OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2);

 FOR v IN
  SELECT a.player_id,a.weighted_rake_credit,r.id AS rake_record_id,r.created_at
   FROM public.rake_attributions a JOIN public.rake_records r ON r.id=a.rake_record_id AND r.hand_id=a.hand_id
   WHERE a.club_id=p_club_id AND r.created_at>=v_from AND r.created_at<v_to
    AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
    AND a.weighted_rake_credit>0 AND a.weighted_rake_credit=round(a.weighted_rake_credit,2)
    AND (p_user_ids IS NULL OR a.player_id=ANY(p_user_ids))
    AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
   ORDER BY r.created_at,r.id,a.player_id
 LOOP
  item:=COALESCE(rows_by_user->v.player_id::text,jsonb_build_object('user_id',v.player_id,
    'rake_generated',0,'source_count',0,'first_earned_at',v.created_at,'contract_versions','[]'::jsonb));
  histories:=item->'contract_versions';
  BEGIN
   member_receipt:=public.fn_accounting_terms_at('club_members',p_club_id::text||':'||v.player_id::text,v.created_at);
   member_terms:=member_receipt->'terms';
   IF member_terms IS NULL OR member_terms='null'::jsonb
      OR member_terms->>'club_id' IS DISTINCT FROM p_club_id::text OR member_terms->>'user_id' IS DISTINCT FROM v.player_id::text
      OR member_terms->>'is_active' IS DISTINCT FROM 'true'
      OR COALESCE(member_terms->>'status','') NOT IN('active','approved')
   THEN RAISE EXCEPTION 'accounting_terms_not_active' USING ERRCODE='55000'; END IF;
   histories:=histories||jsonb_build_array(member_receipt->'history_id');
   member_agent:=NULLIF(member_terms->>'agent_id','')::uuid;
   IF member_agent IS NOT NULL THEN
    agent_receipt:=public.fn_accounting_agent_terms_at(p_club_id,member_agent,v.created_at);
    histories:=histories||jsonb_build_array(agent_receipt->'history_id');
   END IF;
  EXCEPTION WHEN SQLSTATE '55000' THEN
   IF SQLERRM='accounting_terms_not_observed' THEN missing_terms:=missing_terms+1;
   ELSIF SQLERRM IN('accounting_terms_not_active','accounting_terms_ambiguous') THEN invalid_terms:=invalid_terms+1;
   ELSE RAISE; END IF;
  END;
  SELECT COALESCE(jsonb_agg(DISTINCT h),'[]'::jsonb) INTO histories FROM jsonb_array_elements(histories) h;
  item:=item||jsonb_build_object('rake_generated',(item->>'rake_generated')::numeric+v.weighted_rake_credit,
    'source_count',(item->>'source_count')::bigint+1,'last_earned_at',v.created_at,'contract_versions',histories);
  rows_by_user:=jsonb_set(rows_by_user,ARRAY[v.player_id::text],item,true);
  total_cents:=total_cents+v.weighted_rake_credit*100;
 END LOOP;
 SELECT COALESCE(jsonb_agg(value ORDER BY key),'[]'::jsonb) INTO basis_rows FROM jsonb_each(rows_by_user);
 -- Existing rows do not carry a source version or observed contracts. They
 -- are conflicts for the eventual writer even when the displayed totals match.
 SELECT count(*) FILTER(WHERE status='pending'),count(*) FILTER(WHERE status<>'pending')
  INTO legacy_pending,paid_conflicts FROM public.rakeback_periods
  WHERE club_id=p_club_id AND period_start<=p_period_end AND period_end>=p_period_start
    AND (p_user_ids IS NULL OR user_id=ANY(p_user_ids));
 RETURN jsonb_build_object('source_version',2,'accounting_timezone','America/Los_Angeles','club_id',p_club_id,
  'period_start',p_period_start,'period_end',p_period_end,'from',v_from,'to',v_to,
  'status',CASE WHEN source_issues+missing_terms+invalid_terms+legacy_pending+paid_conflicts=0 THEN 'ready' ELSE 'needs_reconciliation' END,
  'payable',false,'rows',basis_rows,'total_rake',total_cents/100,
  'missing_source_count',source_issues,'missing_terms_count',missing_terms,'invalid_terms_count',invalid_terms,
  'legacy_pending_conflicts',legacy_pending,'paid_period_conflicts',paid_conflicts,
  'scope','cash_only','written',0);
END $function$;

REVOKE ALL ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),
 public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz),
 public.fn_cash_rakeback_period_basis(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_terms_at(text,text,timestamptz),
 public.fn_accounting_agent_terms_at(uuid,uuid,timestamptz),
 public.fn_cash_rakeback_period_basis(uuid,date,date,uuid[]) TO service_role;
COMMIT;
