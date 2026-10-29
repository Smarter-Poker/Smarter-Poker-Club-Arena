-- Versioned interpretation of an immutable source. No paid source, original
-- allocation certificate, original transfer, or wallet is updated here.
CREATE TABLE public.accounting_own_agent_interpretations(
 source_type text NOT NULL CHECK(source_type IN('cash_rake_accrual','tournament_fee_accrual')),
 source_id uuid NOT NULL,version text NOT NULL CHECK(version='own-agent-v1'),
 club_id uuid NOT NULL,player_id uuid NOT NULL,earned_at timestamptz NOT NULL,
 raw_source jsonb NOT NULL,raw_source_md5 text NOT NULL,
 original_contract jsonb NOT NULL,admitted_contract jsonb NOT NULL,
 original_commissions jsonb NOT NULL CHECK(jsonb_typeof(original_commissions)='array'),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_type,source_id),CHECK(raw_source_md5=md5(raw_source::text)),CHECK(original_contract<>admitted_contract)
);
ALTER TABLE public.accounting_own_agent_interpretations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_own_agent_interpretations FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER own_agent_interpretation_immutable BEFORE UPDATE OR DELETE ON public.accounting_own_agent_interpretations FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_interpretation_no_truncate BEFORE TRUNCATE ON public.accounting_own_agent_interpretations FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION smarter_private.own_agent_interpreted_contract(p_contract jsonb,p_club uuid,p_player uuid,p_rake numeric,p_union uuid,p_terms timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $interpret$
DECLARE own jsonb;canonical jsonb;
BEGIN
 IF coalesce(p_contract#>>'{membership,terms,role}','')NOT IN('super_agent','agent','sub_agent')
 OR p_contract#>>'{tiers,0,user_id}'=p_player::text
 OR ((p_contract#>>'{membership,terms,player_rakeback_pct}')::numeric=.70 AND EXISTS(SELECT FROM public.clubs c WHERE c.id=p_club AND c.owner_id=NULLIF(p_contract#>>'{membership,terms,agent_id}','')::uuid))THEN RETURN NULL;END IF;
 BEGIN own:=public.fn_accounting_agent_terms_at(p_club,p_player,p_terms);
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active')THEN RETURN NULL;ELSE RAISE;END IF;END;
 canonical:=public.fn_accounting_earning_contract(p_club,p_player,p_rake,p_union,p_terms);
 -- Only hierarchy and its retained residual may change. Owner-basis,
 -- attribution and every original capture field remain in the admitted row.
 IF canonical#>>'{tiers,0,user_id}'IS DISTINCT FROM p_player::text
 OR canonical#>'{tiers,0,agreement}'IS DISTINCT FROM own
 OR NOT((p_contract-'tiers'-'club_residual')@>(canonical-'tiers'-'club_residual'))
 THEN RAISE EXCEPTION 'own_agent_interpretation_historical_contract_disagrees' USING ERRCODE='23514';END IF;
 RETURN p_contract||jsonb_build_object('tiers',canonical->'tiers','club_residual',canonical->'club_residual');
END $interpret$;
REVOKE ALL ON FUNCTION smarter_private.own_agent_interpreted_contract(jsonb,uuid,uuid,numeric,uuid,timestamptz)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.admit_own_agent_source(p_type text,p_source uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $admit$
DECLARE s record;raw jsonb;canonical jsonb;old_rows jsonb;source_proof jsonb;w_from timestamptz;w_to timestamptz;key text;old_setting text;posted int;expected int;
BEGIN
 IF NOT public.fn_caller_is_engine()OR p_type NOT IN('cash_rake_accrual','tournament_fee_accrual')OR p_type IS NULL OR p_source IS NULL THEN RAISE EXCEPTION 'own_agent_interpretation_not_authorised' USING ERRCODE='42501';END IF;
 SELECT x.*,CASE WHEN x.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(f.tournament_id,f.charged_at,f.contract)ELSE x.earned_at END terms_at
 INTO s FROM public.accounting_payable_earning_sources x LEFT JOIN public.accounting_tournament_fee_sources f ON f.id=CASE WHEN x.source_type='tournament_fee_accrual'THEN x.source_id END WHERE x.source_type=p_type AND x.source_id=p_source;
 IF NOT FOUND THEN RAISE EXCEPTION 'own_agent_interpretation_payable_source_required' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.accounting_own_agent_interpretations a WHERE a.source_type=p_type AND a.source_id=p_source)THEN RETURN false;END IF;
 canonical:=smarter_private.own_agent_interpreted_contract(s.contract,s.club_id,s.player_id,s.rake_credit,s.union_id,s.terms_at);
 IF canonical IS NULL THEN RETURN false;END IF;
 w_from:=public.fn_union_week_start(s.earned_at);w_to:=public.fn_union_week_start(w_from+interval '8 days');
 key:=CASE WHEN s.coordinator_union_id IS NULL THEN'club-accounting:'ELSE'union-accounting:'END||coalesce(s.coordinator_union_id,s.club_id)||':'||extract(epoch FROM w_from)||':'||extract(epoch FROM w_to);
 IF NOT pg_try_advisory_xact_lock(hashtextextended(key,0))THEN RAISE EXCEPTION 'own_agent_interpretation_scope_busy' USING ERRCODE='55000';END IF;
 -- Take the same original producer lock without reversing its lock order.
 IF p_type='cash_rake_accrual' THEN
  SELECT to_jsonb(x)INTO raw FROM public.accounting_cash_rake_sources x WHERE x.id=p_source;
  SELECT 'accounting_cash_hand:'||r.hand_id INTO key FROM public.rake_records r WHERE r.id=s.rake_record_id;
 ELSE
  SELECT to_jsonb(x)INTO raw FROM public.accounting_tournament_fee_sources x WHERE x.id=p_source;
  key:='accounting_tournament_recognition:'||s.tournament_id;
 END IF;
 IF raw IS NULL OR key IS NULL OR NOT pg_try_advisory_xact_lock(hashtextextended(key,0))THEN RAISE EXCEPTION 'own_agent_interpretation_source_busy' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM public.agent_commission_settlements a WHERE a.club_id=s.club_id AND a.period_start<=s.earned_at AND a.period_end>s.earned_at)
 OR EXISTS(SELECT FROM public.accounting_routed_settlement_runs r WHERE r.period_start=w_from AND r.period_end=w_to AND((r.union_id IS NOT NULL AND r.union_id=s.coordinator_union_id)OR(r.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL)))
 OR EXISTS(SELECT FROM public.rakeback_periods r WHERE r.club_id=s.club_id AND r.period_start=(w_from AT TIME ZONE'America/Los_Angeles')::date AND r.status<>'pending')
 OR EXISTS(SELECT FROM public.rakeback_period_payouts pp JOIN public.rakeback_periods r ON r.id=pp.rakeback_period_id WHERE r.club_id=s.club_id AND r.period_start=(w_from AT TIME ZONE'America/Los_Angeles')::date)
 THEN RAISE EXCEPTION 'own_agent_interpretation_week_already_paid' USING ERRCODE='23514';END IF;
 -- Reuse the real capture/disposition proof; do not fabricate bad history IDs.
 IF p_type='cash_rake_accrual' THEN
  source_proof:=public.fn_accounting_cash_commission_plan(s.rake_record_id);
  IF NOT EXISTS(SELECT FROM jsonb_array_elements(source_proof->'players')p WHERE p->>'attribution_id'=s.contract->>'attribution_id'AND p->>'player_id'=s.player_id::text AND(p->>'rake_credit')::numeric=s.rake_credit)THEN RAISE EXCEPTION 'own_agent_interpretation_cash_capture_changed' USING ERRCODE='23514';END IF;
 ELSE
  source_proof:=public.fn_accounting_tournament_fee_net_plan(s.tournament_id);
  IF NOT(source_proof->'active_source_ids'@>jsonb_build_array(p_source))OR source_proof->>'status'IS DISTINCT FROM'proven'
  OR NOT EXISTS(SELECT FROM public.accounting_tournament_fee_recognitions r WHERE r.tournament_id=s.tournament_id AND r.status='recognized'AND r.recognized_at=s.earned_at AND r.source_fingerprint=source_proof->>'source_fingerprint')THEN RAISE EXCEPTION 'own_agent_interpretation_fee_capture_changed' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM 1 FROM public.agent_commissions a WHERE a.source_type=p_type AND a.source_id=p_source FOR UPDATE;
 SELECT coalesce(jsonb_agg(to_jsonb(a)ORDER BY a.id),'[]')INTO old_rows FROM public.agent_commissions a WHERE a.source_type=p_type AND a.source_id=p_source;
 SELECT count(*)INTO expected FROM jsonb_array_elements(s.contract->'tiers')t WHERE(t->>'amount')::numeric>0;
 IF jsonb_array_length(old_rows)<>expected OR EXISTS(SELECT FROM jsonb_array_elements(old_rows)a WHERE a->>'settled_at'IS NOT NULL OR a->>'club_id'IS DISTINCT FROM s.club_id::text OR(a->>'created_at')::timestamptz IS DISTINCT FROM s.earned_at OR NOT EXISTS(SELECT FROM jsonb_array_elements(s.contract->'tiers')t WHERE t->>'user_id'=a->>'user_id'AND(t->>'amount')::numeric=(a->>'amount')::numeric AND(t->>'rate')::numeric=(a->>'commission_rate')::numeric))THEN RAISE EXCEPTION 'own_agent_interpretation_original_commissions_changed' USING ERRCODE='23514';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||s.club_id||':'||(w_from AT TIME ZONE'America/Los_Angeles')::date,0))THEN RAISE EXCEPTION 'own_agent_interpretation_period_busy' USING ERRCODE='55000';END IF;
 -- These are the original unpaid proof records, never copied or retagged.
 DELETE FROM public.accounting_close_partials WHERE union_id=coalesce(s.coordinator_union_id,s.club_id)AND period_start=w_from AND period_end=w_to;
 DELETE FROM public.accounting_close_certificates WHERE union_id=coalesce(s.coordinator_union_id,s.club_id)AND period_start=w_from AND period_end=w_to;
 DELETE FROM public.accounting_recompute_split_parts WHERE club_id=s.club_id AND period_start=(w_from AT TIME ZONE'America/Los_Angeles')::date AND period_end=(w_to AT TIME ZONE'America/Los_Angeles')::date-1;
 INSERT INTO public.accounting_own_agent_interpretations(source_type,source_id,version,club_id,player_id,earned_at,raw_source,raw_source_md5,original_contract,admitted_contract,original_commissions)VALUES(p_type,p_source,'own-agent-v1',s.club_id,s.player_id,s.earned_at,raw,md5(raw::text),s.contract,canonical,old_rows);
 old_setting:=current_setting('app.ledger_maintenance',true);PERFORM set_config('app.ledger_maintenance','own-agent-interpretation:'||p_source,true);
 DELETE FROM public.agent_commissions WHERE source_type=p_type AND source_id=p_source;
 PERFORM set_config('app.ledger_maintenance',coalesce(old_setting,''),true);
 UPDATE public.agents a SET lifetime_rake_generated=coalesce(a.lifetime_rake_generated,0)-s.rake_credit,weekly_rake_generated=coalesce(a.weekly_rake_generated,0)-CASE WHEN public.fn_union_week_start(s.earned_at)=public.fn_union_week_start(now())THEN s.rake_credit ELSE 0 END WHERE a.club_id=s.club_id AND EXISTS(SELECT FROM jsonb_array_elements(s.contract->'tiers')t WHERE a.id=(t->>'agent_id')::uuid AND a.user_id=(t->>'user_id')::uuid);
 posted:=public.fn_post_accounting_commission_source(p_source,p_type,s.earned_at,canonical);
 IF posted<>(SELECT count(*)FROM jsonb_array_elements(canonical->'tiers')t WHERE(t->>'amount')::numeric>0)THEN RAISE EXCEPTION 'own_agent_interpretation_posting_incomplete' USING ERRCODE='23514';END IF;
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)VALUES(s.club_id,(w_from AT TIME ZONE'America/Los_Angeles')::date,(w_to AT TIME ZONE'America/Los_Angeles')::date-1)ON CONFLICT(club_id,period_start,period_end)DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL,last_result='{}';
 RETURN true;
END $admit$;
REVOKE ALL ON FUNCTION smarter_private.admit_own_agent_source(text,uuid)FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.ca_ledger_maintenance_kinds(kind,note,severity)VALUES('own-agent-interpretation','Original unpaid R0 source interpretation; immutable raw/current contracts and original pending commissions preserved. No wallet movement.','info');

CREATE TABLE public.accounting_own_agent_preparation_versions(
 scope_kind text NOT NULL CHECK(scope_kind IN('club','union')),scope_id uuid NOT NULL,
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,version text NOT NULL CHECK(version='own-agent-v1'),
 original_partials jsonb NOT NULL,original_certificates jsonb NOT NULL,owner_hashes jsonb NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope_kind,scope_id,period_start,period_end)
);
ALTER TABLE public.accounting_own_agent_preparation_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_own_agent_preparation_versions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER own_agent_preparation_version_immutable BEFORE UPDATE OR DELETE ON public.accounting_own_agent_preparation_versions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_preparation_version_no_truncate BEFORE TRUNCATE ON public.accounting_own_agent_preparation_versions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

-- The original R0 request reviews a finite source-ID batch before invoking
-- historical constructors. Even an unchanged source gets immutable progress,
-- so a later request does not repeat an unbounded eligibility scan.
CREATE TABLE public.accounting_own_agent_source_reviews(
 source_type text NOT NULL CHECK(source_type IN('cash_rake_accrual','tournament_fee_accrual')),
 source_id uuid NOT NULL,version text NOT NULL CHECK(version='own-agent-v1'),
 original_contract_md5 text NOT NULL,effective_contract_md5 text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN('unchanged','admitted')),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(source_type,source_id)
);
ALTER TABLE public.accounting_own_agent_source_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_own_agent_source_reviews FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER own_agent_source_review_immutable BEFORE UPDATE OR DELETE ON public.accounting_own_agent_source_reviews FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_source_review_no_truncate BEFORE TRUNCATE ON public.accounting_own_agent_source_reviews FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION smarter_private.prepare_own_agent_interpretation(p_union uuid,p_club uuid,p_from timestamptz,p_to timestamptz,p_limit int DEFAULT 256)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $prepare$
DECLARE kind text;identity uuid;item record;seen int:=0;admitted int:=0;clubs uuid[];parts jsonb;certs jsonb;old_hash text;new_hash text;did_admit boolean;budget_exhausted boolean:=false;work_deadline timestamptz:=LEAST(NULLIF(current_setting('app.weekly_accounting_preparation_deadline',true),'')::timestamptz,NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz);
BEGIN
 IF NOT public.fn_caller_is_engine()OR p_from IS NULL OR p_to IS NULL OR(p_union IS NULL)=(p_club IS NULL)OR p_limit IS NULL OR p_limit<1 OR p_limit>1024
 OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days')OR p_to>now()THEN RAISE EXCEPTION 'own_agent_preparation_scope_invalid' USING ERRCODE='22023';END IF;
 kind:=CASE WHEN p_union IS NULL THEN'club'ELSE'union'END;identity:=coalesce(p_union,p_club);
 IF NOT pg_try_advisory_xact_lock(hashtextextended(CASE WHEN p_union IS NULL THEN'club-accounting:'ELSE'union-accounting:'END||identity||':'||extract(epoch FROM p_from)||':'||extract(epoch FROM p_to),0))THEN RAISE EXCEPTION 'own_agent_interpretation_scope_busy' USING ERRCODE='55000';END IF;
 -- Original completed books remain authoritative, including manual correction
 -- receipts made later. Replaying them cannot create a v1 source or new delta.
 IF EXISTS(SELECT FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=kind AND r.scope_id=identity AND r.period_start=p_from AND r.period_end=p_to AND r.round_no=3)THEN RETURN jsonb_build_object('ready',true,'legacy_paid',true,'admitted',0);END IF;
 IF work_deadline IS NOT NULL AND(NOT isfinite(work_deadline)OR clock_timestamp()+interval '1 second'>=work_deadline)THEN RETURN jsonb_build_object('ready',false,'admitted',0,'reviewed',0,'budget_exhausted',true,'version','own-agent-v1');END IF;
 SELECT coalesce(array_agg(DISTINCT s.club_id),'{}')INTO clubs FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to AND((p_union IS NOT NULL AND s.coordinator_union_id=p_union)OR(p_club IS NOT NULL AND s.club_id=p_club AND s.coordinator_union_id IS NULL));
 IF NOT EXISTS(SELECT FROM public.accounting_own_agent_preparation_versions v WHERE v.scope_kind=kind AND v.scope_id=identity AND v.period_start=p_from AND v.period_end=p_to)THEN
  IF EXISTS(SELECT FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=kind AND r.scope_id=identity AND r.period_start=p_from AND r.period_end=p_to)
  OR EXISTS(SELECT FROM public.agent_commission_settlements a WHERE a.club_id=ANY(clubs)AND a.period_start=p_from AND a.period_end=p_to)
  OR EXISTS(SELECT FROM public.rakeback_periods r WHERE r.club_id=ANY(clubs)AND r.period_start=(p_from AT TIME ZONE'America/Los_Angeles')::date AND(r.status<>'pending'OR EXISTS(SELECT FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=r.id)))THEN RAISE EXCEPTION 'own_agent_interpretation_week_already_paid' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind',p.kind,'window_start',p.window_start,'window_end',p.window_end,'full_row_md5',md5(to_jsonb(p)::text))ORDER BY p.kind,p.window_start),'[]')INTO parts FROM public.accounting_close_partials p WHERE p.union_id=identity AND p.period_start=p_from AND p.period_end=p_to;
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind',c.kind,'full_row_md5',md5(to_jsonb(c)::text))ORDER BY c.kind),'[]')INTO certs FROM public.accounting_close_certificates c WHERE c.union_id=identity AND c.period_start=p_from AND c.period_end=p_to;
  INSERT INTO public.accounting_own_agent_preparation_versions(scope_kind,scope_id,period_start,period_end,version,original_partials,original_certificates,owner_hashes)VALUES(kind,identity,p_from,p_to,'own-agent-v1',parts,certs,jsonb_build_object('producer',md5(pg_get_functiondef('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz)'::regprocedure)),'calculator',md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)),'split_check',md5(pg_get_functiondef('public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure)),'split_write',md5(pg_get_functiondef('public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure))));
  DELETE FROM public.accounting_close_partials WHERE union_id=identity AND period_start=p_from AND period_end=p_to;
  DELETE FROM public.accounting_close_certificates WHERE union_id=identity AND period_start=p_from AND period_end=p_to;
  DELETE FROM public.accounting_recompute_split_parts WHERE club_id=ANY(clubs)AND period_start=(p_from AT TIME ZONE'America/Los_Angeles')::date AND period_end=(p_to AT TIME ZONE'America/Los_Angeles')::date-1;
  UPDATE public.accounting_period_recompute_requests SET status='pending',reason=NULL,last_result='{}',last_requested_at=clock_timestamp()WHERE club_id=ANY(clubs)AND period_start=(p_from AT TIME ZONE'America/Los_Angeles')::date AND period_end=(p_to AT TIME ZONE'America/Los_Angeles')::date-1;
 END IF;
 FOR item IN SELECT s.source_type,s.source_id FROM public.accounting_payable_earning_sources s
 WHERE s.earned_at>=p_from AND s.earned_at<p_to AND((p_union IS NOT NULL AND s.coordinator_union_id=p_union)OR(p_club IS NOT NULL AND s.club_id=p_club AND s.coordinator_union_id IS NULL))
 AND coalesce(s.contract#>>'{membership,terms,role}','')IN('super_agent','agent','sub_agent')AND s.contract#>>'{tiers,0,user_id}'IS DISTINCT FROM s.player_id::text
 AND NOT(coalesce((s.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=.70,false)AND EXISTS(SELECT FROM public.clubs c WHERE c.id=s.club_id AND c.owner_id=NULLIF(s.contract#>>'{membership,terms,agent_id}','')::uuid))
 AND NOT EXISTS(SELECT FROM public.accounting_own_agent_source_reviews a WHERE a.source_type=s.source_type AND a.source_id=s.source_id)
 ORDER BY s.source_type,s.source_id LIMIT p_limit LOOP
  IF work_deadline IS NOT NULL AND clock_timestamp()+interval '1 second'>=work_deadline THEN budget_exhausted:=true;EXIT;END IF;
  seen:=seen+1;
  SELECT md5(s.contract::text)INTO STRICT old_hash FROM public.accounting_payable_earning_sources s WHERE s.source_type=item.source_type AND s.source_id=item.source_id;
  did_admit:=smarter_private.admit_own_agent_source(item.source_type,item.source_id);
  IF did_admit THEN admitted:=admitted+1;END IF;
  SELECT md5(s.contract::text)INTO STRICT new_hash FROM public.accounting_payable_earning_sources s WHERE s.source_type=item.source_type AND s.source_id=item.source_id;
  INSERT INTO public.accounting_own_agent_source_reviews(source_type,source_id,version,original_contract_md5,effective_contract_md5,outcome)VALUES(item.source_type,item.source_id,'own-agent-v1',old_hash,new_hash,CASE WHEN did_admit THEN'admitted'ELSE'unchanged'END);
  IF work_deadline IS NOT NULL AND clock_timestamp()+interval '1 second'>=work_deadline THEN budget_exhausted:=true;EXIT;END IF;
 END LOOP;
 RETURN jsonb_build_object('ready',NOT budget_exhausted AND seen<p_limit,'admitted',admitted,'reviewed',seen,'budget_exhausted',budget_exhausted,'version','own-agent-v1');
END $prepare$;
REVOKE ALL ON FUNCTION smarter_private.prepare_own_agent_interpretation(uuid,uuid,timestamptz,timestamptz,int)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.assert_own_agent_scope_interpreted(p_kind text,p_scope uuid,p_from timestamptz,p_to timestamptz,p_round int)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $assert$
BEGIN
 -- The original paid receipt always decides its own replay, including books
 -- with a later approved adjustment. This guard never upgrades a paid source.
 IF EXISTS(SELECT FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=p_kind AND r.scope_id=p_scope AND r.period_start=p_from AND r.period_end=p_to AND r.round_no=p_round)THEN RETURN;END IF;
 IF NOT EXISTS(SELECT FROM public.accounting_own_agent_preparation_versions v WHERE v.scope_kind=p_kind AND v.scope_id=p_scope AND v.period_start=p_from AND v.period_end=p_to AND v.version='own-agent-v1'AND v.owner_hashes=jsonb_build_object('producer',md5(pg_get_functiondef('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamptz)'::regprocedure)),'calculator',md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)),'split_check',md5(pg_get_functiondef('public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure)),'split_write',md5(pg_get_functiondef('public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure))))THEN RAISE EXCEPTION 'own_agent_source_interpretation_required_before_payment' USING ERRCODE='55000';END IF;
 -- Historical entitlement survives suspension. Frozen, missing or ambiguous
 -- current own-agent destinations cannot accept a new transfer. Deleted
 -- profiles retain the original documented discharge transaction below.
 IF EXISTS(SELECT FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to AND((p_kind='union'AND s.coordinator_union_id=p_scope)OR(p_kind='club'AND s.club_id=p_scope AND s.coordinator_union_id IS NULL))AND coalesce(s.contract#>>'{membership,terms,role}','')IN('super_agent','agent','sub_agent')AND s.contract#>>'{tiers,0,user_id}'IS DISTINCT FROM s.player_id::text
 AND NOT(coalesce((s.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=.70,false)AND EXISTS(SELECT FROM public.clubs c WHERE c.id=s.club_id AND c.owner_id=NULLIF(s.contract#>>'{membership,terms,agent_id}','')::uuid))
 AND NOT EXISTS(SELECT FROM public.accounting_own_agent_source_reviews a WHERE a.source_type=s.source_type AND a.source_id=s.source_id AND a.version='own-agent-v1'AND a.effective_contract_md5=md5(s.contract::text)))THEN RAISE EXCEPTION 'own_agent_source_interpretation_pending' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM public.accounting_payable_earning_sources s LEFT JOIN public.accounting_tournament_fee_sources f ON f.id=CASE WHEN s.source_type='tournament_fee_accrual'THEN s.source_id END
 CROSS JOIN LATERAL(SELECT count(*)n,min(a.status)status,min(a.role)role FROM public.agents a WHERE a.club_id=s.club_id AND a.user_id=s.player_id)g
 WHERE s.earned_at>=p_from AND s.earned_at<p_to AND((p_kind='union'AND s.coordinator_union_id=p_scope)OR(p_kind='club'AND s.club_id=p_scope AND s.coordinator_union_id IS NULL))AND s.rake_credit>0
 AND coalesce(s.contract#>>'{membership,terms,role}','')IN('super_agent','agent','sub_agent')
 AND(s.contract#>>'{tiers,0,user_id}'=s.player_id::text OR smarter_private.own_agent_destination_contract(s.contract,s.club_id,s.player_id,CASE WHEN s.source_type='tournament_fee_accrual'THEN public.fn_accounting_tournament_source_terms_at(f.tournament_id,f.charged_at,f.contract)ELSE s.earned_at END)IS NOT NULL)
 AND(g.n<>1 OR coalesce(g.role,'')NOT IN('super_agent','agent','sub_agent')OR(coalesce(g.status,'')NOT IN('active','suspended')AND NOT EXISTS(SELECT FROM public.profiles p WHERE p.id=s.player_id AND p.status='deleted'))))THEN RAISE EXCEPTION 'own_agent_current_destination_unavailable' USING ERRCODE='23514';END IF;

END $assert$;
REVOKE ALL ON FUNCTION smarter_private.assert_own_agent_scope_interpreted(text,uuid,timestamptz,timestamptz,int)FROM PUBLIC,anon,authenticated,service_role;
