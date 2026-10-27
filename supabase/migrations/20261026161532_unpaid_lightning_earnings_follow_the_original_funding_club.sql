-- @live-proof: (to_regclass('public.accounting_cash_funding_contract_admissions') IS NOT NULL AND position('accounting_cash_funding_contract_admissions' IN pg_get_viewdef('public.accounting_effective_cash_rake_sources'::regclass,true))>0 AND position('app.accounting_funding_contracts' IN pg_get_functiondef('public.fn_accrue_cash_hand_commissions(uuid)'::regprocedure))>0 AND NOT has_function_privilege('authenticated','smarter_private.admit_cash_funding_contracts(uuid,jsonb)','EXECUTE'))
-- The unpaid Lightning host-club contracts have no original agent tiers or
-- commissions. Admit their proven original funding contracts on an explicit
-- restart of the SAME accrual. Keep raw sources/attributions immutable, post
-- newly proven agent liabilities through the original writer, and retain the
-- original funding journals. No wallet credit, payout route or schedule here.
-- The effective view must retain the original club/time index restriction.
-- A source-id cover also permits its immutable-admission join to stay index-only.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.accounting_cash_club_week_player_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_club_week_player_cover
 ON public.accounting_cash_rake_sources(club_id,earned_at) INCLUDE(player_id,id);
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_accrue_cash_hand_commissions(uuid)'::regprocedure))<>'020617e6132d5df34b79b403b34f2062'
 OR md5(pg_get_viewdef('public.accounting_effective_cash_rake_sources'::regclass,true))<>'0dd662a7489be5f387e5838f8ca801c5'
 THEN RAISE EXCEPTION 'cash_funding_admission_preimage_changed'; END IF;
END $preimage$;
CREATE TABLE public.accounting_cash_funding_contract_admissions(
 source_id uuid PRIMARY KEY,
 original_contract jsonb NOT NULL,
 admitted_contract jsonb NOT NULL,
 original_club_id uuid NOT NULL,
 funding_club_id uuid NOT NULL,
 original_chair jsonb NOT NULL,
 buyin_ledger jsonb NOT NULL,
 wallet_debit jsonb NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(original_club_id<>funding_club_id),
 CHECK(original_contract->>'club_id'=original_club_id::text),
 CHECK(admitted_contract->>'club_id'=funding_club_id::text),
 CHECK(original_contract->'tiers'='[]'::jsonb)
);
ALTER TABLE public.accounting_cash_funding_contract_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_funding_contract_admissions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_cash_funding_admission_immutable BEFORE UPDATE OR DELETE ON public.accounting_cash_funding_contract_admissions FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_funding_admission_no_truncate BEFORE TRUNCATE ON public.accounting_cash_funding_contract_admissions FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE OR REPLACE VIEW public.accounting_effective_cash_rake_sources AS
 SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.union_id,s.coordinator_union_id,
 s.earned_at,s.rake_credit,COALESCE(a.admitted_contract,s.contract) AS contract,
 greatest(s.recorded_at,a.admitted_at) AS recorded_at
 FROM public.accounting_cash_rake_sources s
 LEFT JOIN public.accounting_cash_atomic_contract_admissions a ON a.source_id=s.id
 WHERE NOT EXISTS(SELECT FROM public.accounting_cash_funding_contract_admissions f WHERE f.source_id=s.id)
 UNION ALL
 SELECT s.id,s.rake_record_id,s.player_id,f.funding_club_id AS club_id,s.union_id,s.coordinator_union_id,
 s.earned_at,s.rake_credit,f.admitted_contract AS contract,
 greatest(s.recorded_at,a.admitted_at,f.admitted_at) AS recorded_at
 FROM public.accounting_cash_funding_contract_admissions f
 JOIN public.accounting_cash_rake_sources s ON s.id=f.source_id
 LEFT JOIN public.accounting_cash_atomic_contract_admissions a ON a.source_id=s.id;
REVOKE ALL ON public.accounting_effective_cash_rake_sources FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.admit_cash_funding_contracts(p_record uuid,p_expected jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $admit$
DECLARE r public.rake_records%ROWTYPE;s public.accounting_cash_rake_sources%ROWTYPE;
 e jsonb;canonical jsonb;existing jsonb;chair jsonb;ledger jsonb;wallet jsonb;
 funding uuid;matches bigint;w_from timestamptz;w_to timestamptz;key_club uuid;n integer:=0;posted integer;
BEGIN
 IF NOT public.fn_caller_is_engine() OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR p_expected='{}'::jsonb
 THEN RAISE EXCEPTION 'funding_cash_admission_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT r FROM public.rake_records WHERE id=p_record;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||r.hand_id::text,0));
 IF r.hand_id IS NULL OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
  OR r.metadata->>'accounting_source_version' IS DISTINCT FROM '2'
  OR NULLIF(r.metadata->>'union_id','')::uuid IS DISTINCT FROM r.club_id
  OR NOT EXISTS(SELECT FROM public.clubs c WHERE c.id=r.club_id AND c.is_union)
  OR NOT EXISTS(SELECT FROM public.lightning_hand h WHERE h.hand_history_id=r.hand_id AND h.host_table_id=r.table_id)
  OR NOT EXISTS(SELECT FROM public.accounting_cash_accrual_batches b WHERE b.rake_record_id=r.id AND b.status='accrued' AND b.earned_at=r.created_at)
 THEN RAISE EXCEPTION 'funding_cash_admission_requires_accrued_lightning_host_source' USING ERRCODE='23514'; END IF;
 -- The original plan proves the bank witness, amount conservation and the
 -- immutable attribution identities before any alternate contract is admitted.
 PERFORM public.fn_accounting_cash_commission_plan(r.id);
 w_from:=public.fn_union_week_start(r.created_at);w_to:=public.fn_union_week_start(w_from+interval '8 days');
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-accounting:'||r.club_id::text||':'||extract(epoch FROM w_from)::text||':'||extract(epoch FROM w_to)::text,0));
 IF EXISTS(SELECT FROM jsonb_object_keys(p_expected)k WHERE NOT EXISTS(SELECT FROM public.accounting_cash_rake_sources x WHERE x.rake_record_id=r.id AND x.id::text=k))
 THEN RAISE EXCEPTION 'funding_cash_admission_foreign_source' USING ERRCODE='23514'; END IF;
 -- Acquire the ENTIRE requested hand's calculator keys in club order,
 -- before posting any source. Per-source ordering would invert two clubs
 -- when a single Lightning hand has contributors funded by different clubs.
 FOR key_club IN SELECT c FROM (
  SELECT r.club_id c
  UNION
  SELECT l.club_id FROM public.cash_hand_provenance_receipts h
  CROSS JOIN LATERAL jsonb_array_elements(h.accepted_request->'stacks')p
  JOIN public.accounting_cash_rake_sources x ON x.rake_record_id=r.id AND x.player_id::text=p->>'user_id' AND p_expected ? x.id::text
  JOIN public.chip_ledger l ON l.from_entity_id=x.player_id AND l.created_at=(p->>'seat_joined_at')::timestamptz
   AND l.from_type='player_wallet' AND l.to_type='table_stack' AND l.category='buyin'
  JOIN public.wallet_transactions w ON w.user_id=l.from_entity_id AND w.created_at=l.created_at AND w.table_id=l.to_entity_id
   AND w.category='buyin' AND w.type='debit' AND w.wallet_type='PLAYER' AND w.amount=l.amount
  WHERE h.hand_id=r.hand_id AND h.table_id=r.table_id
 ) keys ORDER BY c LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||key_club::text||':'||(w_from AT TIME ZONE 'America/Los_Angeles')::date::text,0));
 END LOOP;
 FOR s IN SELECT * FROM public.accounting_cash_rake_sources x WHERE x.rake_record_id=r.id AND p_expected ? x.id::text ORDER BY x.id LOOP
  e:=p_expected->s.id::text;
  IF md5(s.contract::text) IS DISTINCT FROM e->>'original_md5' THEN RAISE EXCEPTION 'funding_cash_admission_original_changed' USING ERRCODE='23514'; END IF;
  SELECT f.admitted_contract INTO existing FROM public.accounting_cash_funding_contract_admissions f WHERE f.source_id=s.id;
  IF FOUND THEN
   IF md5(existing::text) IS DISTINCT FROM e->>'admitted_md5' THEN RAISE EXCEPTION 'funding_cash_admission_replay_conflict' USING ERRCODE='23514'; END IF;
   CONTINUE;
  END IF;
  IF s.club_id IS DISTINCT FROM r.club_id OR s.union_id IS DISTINCT FROM r.club_id OR s.coordinator_union_id IS DISTINCT FROM r.club_id
   OR s.earned_at IS DISTINCT FROM r.created_at OR s.contract->'tiers' IS DISTINCT FROM '[]'::jsonb
   OR EXISTS(SELECT FROM public.agent_commissions a WHERE a.source_type='cash_rake_accrual' AND a.source_id=s.id)
   OR EXISTS(SELECT FROM public.accounting_cash_atomic_contract_admissions a WHERE a.source_id=s.id)
  THEN RAISE EXCEPTION 'funding_cash_admission_original_not_supported' USING ERRCODE='23514'; END IF;
  -- The accepted request retains the ORIGINAL chair identity after a chair is
  -- reused/deleted. Its exact join instant and user must name one buy-in in
  -- BOTH independent journals; table, amount, direction and currency agree.
  SELECT count(*),(array_agg(l.club_id))[1],(jsonb_agg(p))->0,(jsonb_agg(to_jsonb(l)))->0,(jsonb_agg(to_jsonb(w)))->0
   INTO matches,funding,chair,ledger,wallet
  FROM public.cash_hand_provenance_receipts h
  CROSS JOIN LATERAL jsonb_array_elements(h.accepted_request->'stacks')p
  JOIN public.chip_ledger l ON l.from_entity_id=s.player_id AND l.created_at=(p->>'seat_joined_at')::timestamptz
   AND l.from_type='player_wallet' AND l.to_type='table_stack' AND l.category='buyin'
  JOIN public.wallet_transactions w ON w.user_id=l.from_entity_id AND w.created_at=l.created_at AND w.table_id=l.to_entity_id
   AND w.category='buyin' AND w.type='debit' AND w.wallet_type='PLAYER' AND w.amount=l.amount
  WHERE h.hand_id=r.hand_id AND h.table_id=r.table_id AND h.hand_number=(h.accepted_request->>'hand_number')::bigint
   AND h.accepted_request->>'table_id'=r.table_id::text AND p->>'user_id'=s.player_id::text
   AND NULLIF(p->>'seat_id','') IS NOT NULL AND (p->>'seat_joined_at')::timestamptz<=s.earned_at
   AND l.amount>0 AND l.amount=round(l.amount,2) AND l.amount::text NOT IN('NaN','Infinity','-Infinity');
  IF matches<>1 OR funding IS NULL OR funding=s.club_id THEN RAISE EXCEPTION 'funding_cash_admission_witness_not_exact' USING ERRCODE='23514'; END IF;
  canonical:=public.fn_accounting_earning_contract(funding,s.player_id,s.rake_credit,s.union_id,s.earned_at)
   ||jsonb_build_object('attribution_id',s.contract->>'attribution_id');
  IF md5(canonical::text) IS DISTINCT FROM e->>'admitted_md5'
   OR canonical->>'player_id' IS DISTINCT FROM s.player_id::text OR canonical->>'club_id' IS DISTINCT FROM funding::text
   OR canonical->>'union_id' IS DISTINCT FROM s.union_id::text OR canonical->>'coordinator_union_id' IS DISTINCT FROM s.coordinator_union_id::text
   OR (canonical->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR (canonical->>'terms_at')::timestamptz IS DISTINCT FROM s.earned_at
  THEN RAISE EXCEPTION 'funding_cash_admission_canonical_changed' USING ERRCODE='23514'; END IF;
  -- An old-host pending period is refused as well: this finite admission
  -- precedes calculation and cannot leave a stale host-only player outside
  -- a newly generated player page.
  IF EXISTS(SELECT FROM public.accounting_routed_settlement_runs x WHERE x.period_start<=s.earned_at AND x.period_end>s.earned_at AND (x.union_id=s.union_id OR x.standalone_club_id IN(s.club_id,funding)))
   OR EXISTS(SELECT FROM public.agent_commission_settlements x WHERE x.club_id IN(s.club_id,funding) AND x.period_start<=s.earned_at AND x.period_end>s.earned_at)
   OR EXISTS(SELECT FROM public.rakeback_periods x WHERE x.club_id IN(s.club_id,funding) AND x.user_id=s.player_id AND x.period_start=(w_from AT TIME ZONE 'America/Los_Angeles')::date AND (x.club_id=s.club_id OR x.status<>'pending'))
  THEN RAISE EXCEPTION 'funding_cash_admission_week_already_calculated_or_paid' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_cash_funding_contract_admissions(source_id,original_contract,admitted_contract,original_club_id,funding_club_id,original_chair,buyin_ledger,wallet_debit)
  VALUES(s.id,s.contract,canonical,s.club_id,funding,chair,ledger,wallet);
  posted:=public.fn_post_accounting_commission_source(s.id,'cash_rake_accrual',s.earned_at,canonical);
  IF posted<>(SELECT count(*) FROM jsonb_array_elements(canonical->'tiers')t WHERE(t->>'amount')::numeric>0)
  THEN RAISE EXCEPTION 'funding_cash_admission_posting_incomplete' USING ERRCODE='23514'; END IF;
  DELETE FROM public.accounting_close_partials WHERE union_id=s.union_id AND period_start=w_from AND period_end=w_to;
  DELETE FROM public.accounting_close_certificates WHERE union_id=s.union_id AND period_start=w_from AND period_end=w_to;
  DELETE FROM public.accounting_recompute_split_parts WHERE club_id IN(s.club_id,funding) AND period_start=(w_from AT TIME ZONE 'America/Los_Angeles')::date;
  INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  SELECT c,(w_from AT TIME ZONE 'America/Los_Angeles')::date,(w_to AT TIME ZONE 'America/Los_Angeles')::date-1 FROM unnest(ARRAY[s.club_id,funding])c ORDER BY c
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL;
  n:=n+1;
 END LOOP;
 RETURN n;
END $admit$;
REVOKE ALL ON FUNCTION smarter_private.admit_cash_funding_contracts(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $owner$
DECLARE original text;patched text;anchor text:=$anchor$  RETURN jsonb_build_object('recorded',true,'duplicate',true,'status',batch.status,'source_version',2);$anchor$;
BEGIN
 original:=pg_get_functiondef('public.fn_accrue_cash_hand_commissions(uuid)'::regprocedure);
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'funding_cash_admission_restart_anchor_changed'; END IF;
 patched:=replace(original,anchor,$replacement$  IF NULLIF(current_setting('app.accounting_funding_contracts',true),'') IS NOT NULL THEN
   PERFORM smarter_private.admit_cash_funding_contracts(source.id,current_setting('app.accounting_funding_contracts')::jsonb);
  END IF;
$replacement$||anchor);
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_accrue_cash_hand_commissions(uuid)'::regprocedure) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'funding_cash_admission_restart_readback_changed'; END IF;
END $owner$;
COMMIT;
