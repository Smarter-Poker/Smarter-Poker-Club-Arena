-- Deleted historical payers settle their recorded obligations before free chips return.
-- Original October 5-12 R2 rolled back: the deleted-credit hook drained a parent's
-- gross pass-through before its child debit. The same closed payers owe 184 R3
-- periods, so draining their entire net at the R2 chunk would strand players.
-- Keep every existing transfer, invoice, source, funding and net-balance check.
-- The trusted owning stages flush only their paid cohort after those checks,
-- through the existing ledgered bank return. Published pending R3 liabilities
-- remain funded across chunks; only free net chips return. Ordinary credits
-- with no published obligations still return immediately in their transaction.
-- No membership/profile/access, entitlement, proof TTL, budget, money row,
-- trigger attachment or original inventory certificate is changed by installation.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='299975706a6b2ad943909e56a967d88c' AND md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='d880a99b18d966c092f5d5fb6f2ee98b' AND md5(pg_get_functiondef('public.fn_ca_deleted_wallet_credit()'::regprocedure))='dbd7c02c8cd647c413cfec866c4e4570' AND md5(pg_get_functiondef('public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)'::regprocedure))='975a6eb235c2d0a6e0f7e84043bb3d28' AND (SELECT md5(prosrc)='bac28580767de41b0a852e4a427b810c' FROM pg_proc WHERE oid='smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure) AND smarter_private.original_inventory_proof_sources_match() IS TRUE)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $deleted_weekly$
DECLARE r record; generation text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR nullif(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'deleted_weekly_operator_refused'; END IF;
 IF nullif(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
  OR public.fn_platform_frozen() IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
  RAISE EXCEPTION 'deleted_weekly_freeze_or_override_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
  RAISE EXCEPTION 'deleted_weekly_scheduler_owned'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261017065530') THEN
  RAISE EXCEPTION 'deleted_weekly_history_replay'; END IF;
 IF to_regprocedure('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'deleted_weekly_reserve_already_exists'; END IF;
 IF md5(pg_get_functiondef('public.fn_caller_is_engine()'::regprocedure)) IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d'
  OR md5(pg_get_functiondef('public.fn_guard_membership_lifecycle_write()'::regprocedure)) IS DISTINCT FROM '9d41bf84bc77ef026c604438c0c96b5e' THEN
  RAISE EXCEPTION 'deleted_weekly_actor_or_departed_wallet_authority_changed'; END IF;
 -- The captured publication owners lock an existing period before its new
 -- certificate. The reserve takes the same period row NOWAIT, never waiting
 -- in the reverse member-to-period order. No future unpublished debt is inferred.
 IF md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)) IS DISTINCT FROM '5b0c507615f6b63542a94364b8ad3c14'
  OR md5(pg_get_functiondef('public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure)) IS DISTINCT FROM 'b1e9a7c36647ada7f3f0796db657c7eb' THEN
  RAISE EXCEPTION 'deleted_weekly_period_publication_lock_contract_changed'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.fn_ca_deleted_wallet_credit()'::regprocedure AND NOT tgisinternal)<>3
  OR EXISTS(SELECT FROM (VALUES
    ('club_members','zzzz_deleted_member_credit','777e03faf89df6980100454ee221ac4b'),
    ('agents','zzzz_deleted_agent_credit','8b6bcffd48f73fa1c6361a535cb2b675'),
    ('profiles','zzzz_deleted_profile_bank_return','e3e9dc50dd9bbdc3d71bd192c4c1169b')
   ) v(tab,trigger_name,hash) WHERE NOT EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||v.tab)
    AND t.tgname=v.trigger_name AND t.tgfoid='public.fn_ca_deleted_wallet_credit()'::regprocedure
    AND NOT t.tgisinternal AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))=v.hash)) THEN
  RAISE EXCEPTION 'deleted_weekly_credit_trigger_attachment_changed'; END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF generation IS NULL OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'deleted_weekly_inventory_seal_required'; END IF;
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)','bbf9b44151a265cfa6c019c197229344','b7854e44c83ba086313e4b6dff529670','{postgres=X/postgres}',ARRAY['search_path=public']),
 ('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)','be339460b4005d27a66d2d7bb056b490','becf5641bfc20b8e754c60f686cfcac0','{postgres=X/postgres}',ARRAY['search_path=public']),
 ('public.fn_ca_deleted_wallet_credit()','c38d47f45b2192b5e20e52205819a381','140af6d35cd86165f53f53e82bd42e4a','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp']),
 ('public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)','bccd30228fd808adb885cf3c7f47db88','b4e250b4e92101f2d30f2078fa012ab4','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp','lock_timeout=4s'])
 ) pins(sig,full_hash,body_hash,acl,config) LOOP
  IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure(r.sig)
   AND md5(pg_get_functiondef(p.oid))=r.full_hash AND md5(p.prosrc)=r.body_hash
   AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
   AND p.proacl::text=r.acl AND p.proconfig=r.config) THEN
   RAISE EXCEPTION 'deleted_weekly_preimage_authority_changed %',r.sig;
  END IF;
 END LOOP;
 EXECUTE $reserve_definition$
CREATE OR REPLACE FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(p_club uuid,p_user uuid)
RETURNS numeric
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $reserve$
DECLARE
 r public.rakeback_periods%ROWTYPE;
 c public.accounting_rakeback_period_calculations%ROWTYPE;
 reserved numeric:=0;
 locked_period_ids uuid[];
BEGIN
 IF p_club IS NULL OR p_user IS NULL THEN
  RAISE EXCEPTION 'deleted_wallet_reserve_identity_required' USING ERRCODE='22023';
 END IF;
 -- Publishers lock an existing period FOR UPDATE before adding its certificate.
 -- NOWAIT is essential: caller may already own the member row, while the
 -- ordinary stage owns period rows before member rows. Never wait in reverse.
 SELECT coalesce(array_agg(locked.id ORDER BY locked.id),ARRAY[]::uuid[]) INTO locked_period_ids
 FROM (SELECT rp.id FROM public.rakeback_periods rp
       WHERE rp.club_id=p_club AND rp.status='pending'
       ORDER BY rp.id FOR SHARE NOWAIT) locked;
 -- Visit ONLY the locked admission cohort, not a second fresh pending scan.
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp
          WHERE rp.id=ANY(locked_period_ids) ORDER BY rp.id
 LOOP
  -- Select latest FIRST. An invalid latest certificate must not expose funds
  -- by falling back to an older certificate or disappearing from a filtered sum.
  SELECT pc.* INTO c FROM public.accounting_rakeback_period_calculations pc
  WHERE pc.period_id=r.id ORDER BY pc.id DESC LIMIT 1;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_latest_certificate_required' USING ERRCODE='55000';
  END IF;
  IF r.id IS NULL OR r.club_id IS NULL OR r.club_id IS DISTINCT FROM p_club
   OR r.user_id IS NULL OR r.period_start IS NULL OR r.period_end IS NULL
   OR NOT isfinite(r.period_start) OR NOT isfinite(r.period_end)
   OR r.period_start>r.period_end OR extract(isodow FROM r.period_start)<>1 OR r.period_end<>r.period_start+6
   OR r.rake_generated IS NULL OR r.total_rake_paid IS NULL
   OR r.rakeback_amount IS NULL OR r.rakeback_earned IS NULL OR r.rakeback_rate IS NULL
   OR c.id IS NULL OR c.period_id IS DISTINCT FROM r.id
   OR c.accounting_version IS DISTINCT FROM 2
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS NULL OR c.rake_generated IS DISTINCT FROM r.rake_generated
   OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rake_generated<0 OR c.rake_generated::text IN ('NaN','Infinity','-Infinity')
   OR c.rakeback_amount IS NULL OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.rakeback_amount<0 OR c.rakeback_amount>c.rake_generated OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN ('NaN','Infinity','-Infinity')
   OR c.display_rate IS NULL OR c.display_rate IS DISTINCT FROM r.rakeback_rate
   OR c.display_rate<0 OR c.display_rate>1 OR c.display_rate<>round(c.display_rate,4)
   OR c.display_rate::text IN ('NaN','Infinity','-Infinity')
   OR c.payer_kind IS NULL OR c.payer_kind NOT IN ('agent','club')
   OR (c.payer_kind='agent') IS DISTINCT FROM (c.payer_user_id IS NOT NULL)
   OR c.payer_user_id=r.user_id
   OR c.source_fingerprint IS NULL OR c.source_fingerprint !~ '^[0-9a-f]{32}$'
  THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_certificate_identity_invalid' USING ERRCODE='55000';
  END IF;
  -- The owning R3 stage refuses any existing payout for a pending period.
  -- A pending row plus a paid receipt must never be mistaken for free money.
  IF EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=r.id) THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_pending_payout_conflict' USING ERRCODE='55000';
  END IF;
  IF c.payer_kind='agent' AND c.payer_user_id=p_user THEN
   reserved:=reserved+c.rakeback_amount;
  END IF;
 END LOOP;
 RETURN reserved;
END;
$reserve$;
ALTER FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

$reserve_definition$;
 EXECUTE $r2_definition$
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;v4_ok boolean:=true;v_comb jsonb;
 deleted_deferral text; v_deleted record; v_deleted_before numeric; v_deleted_held numeric; v_deleted_locked numeric;
 v_deleted_bank numeric; v_deleted_return jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 -- WEEKLY CLOSE SCALE (20260928): one read of the week's sources keeps only
 -- what this stage uses (tiers, the contract's club and each row's own md5),
 -- instead of copying every full contract into a temp table. The fingerprint
 -- is the same md5 over the same per-row md5s in the same order. Anything
 -- this path cannot read exactly as the original did is answered by the
 -- original, byte-for-byte, as public.fn_settle_accounting_commission_stage_v3.
 -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan below
 -- is combined from the week's proved two-hour windows
 -- (fn_settle_accounting_commission_window, fn_settle_accounting_commission_combine),
 -- exactly as these reads build it; outside one, or with any window missing,
 -- the week is read here as before.
 v_comb:=CASE WHEN COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  THEN public.fn_settle_accounting_commission_combine(p_scope_kind,p_scope_id,p_period_start,p_period_end) END;
 IF v_comb IS NOT NULL THEN
  IF (v_comb->>'read_failed')::boolean THEN
   RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  fingerprint:=v_comb->>'fingerprint'; source_count:=(v_comb->>'sources')::int;
  SELECT * INTO previous FROM public.accounting_routed_settlement_runs
   WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
  IF FOUND THEN
   IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
   RETURN previous.result||jsonb_build_object('duplicate',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
    AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
   OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
     AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
  THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'unclassified')::bigint>0 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
  -- A contract only the original v3 path can read is not paid from windows,
  -- and v3 is never run here in one long transaction: nothing is paid.
  IF (v_comb->>'full_path')::boolean THEN RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'hierarchy_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
  IF (v_comb->>'entitlement_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 ELSE
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _routed_sources_v4(source_type text,source_id uuid,club_id uuid,earned_at timestamptz,tiers jsonb,tiers_type text,contract_club text,row_md5 text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
  TRUNCATE pg_temp._routed_sources_v4;
  INSERT INTO pg_temp._routed_sources_v4 SELECT source_type,source_id,club_id,earned_at,contract->'tiers',jsonb_typeof(contract->'tiers'),contract->>'club_id',
   md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text)
   FROM public.accounting_payable_earning_sources
   WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 SELECT count(*),md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type||'',source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources_v4;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 -- Any source matching (type,id,club,earned_at=created_at) of a commission row
 -- of these clubs created this week is itself one of these clubs' sources
 -- earned this week, so one hashed read of that slice answers every row. The
 -- tests are counted, not EXISTS: an EXISTS is planned for its first row and
 -- a clean book has none, so it would be a nested loop over the whole week.
 IF (WITH club_week AS MATERIALIZED (
   SELECT rs.source_type,rs.source_id,rs.club_id,rs.earned_at FROM public.accounting_payable_earning_sources rs
    WHERE rs.club_id=ANY(scope.club_ids) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
  SELECT count(*) FROM public.agent_commissions ac
   LEFT JOIN club_week rs ON rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at
  WHERE ac.created_at>=public.fn_ca_launch_accounting_start('club',ac.club_id,p_period_start) AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR rs.source_id IS NULL))>0
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 -- One set insert of every tier. A contract the original loop would refuse,
 -- or a tier value it would fail to read, is answered by the original.
 IF EXISTS(SELECT 1 FROM pg_temp._routed_sources_v4 s WHERE s.tiers_type IS DISTINCT FROM 'array' OR s.contract_club IS DISTINCT FROM s.club_id::text) THEN
  RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 END IF;
 BEGIN
  INSERT INTO pg_temp._routed_tiers SELECT s.source_type,s.source_id,s.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM pg_temp._routed_sources_v4 s CROSS JOIN LATERAL jsonb_array_elements(s.tiers) WITH ORDINALITY x(j,ord);
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 ANALYZE pg_temp._routed_tiers;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 -- Every commission row of every source, read once by its (source_id,
 -- source_type) index in source order, whatever its club or time; the three
 -- original tests are then answered from that set.
 CREATE TEMP TABLE IF NOT EXISTS _routed_ac_v4(source_type text,source_id uuid,club_id uuid,user_id uuid,amount numeric,commission_rate numeric,settled_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_ac_v4;
 INSERT INTO pg_temp._routed_ac_v4 SELECT a.* FROM (SELECT s.source_type,s.source_id FROM pg_temp._routed_sources_v4 s ORDER BY s.source_id,s.source_type) s
  CROSS JOIN LATERAL (SELECT ac.source_type,ac.source_id,ac.club_id,ac.user_id,ac.amount,ac.commission_rate,ac.settled_at FROM public.agent_commissions ac
   WHERE ac.source_id=s.source_id AND ac.source_type=s.source_type OFFSET 0) a;
 ANALYZE pg_temp._routed_ac_v4;
 IF (SELECT count(*) FROM pg_temp._routed_tiers t WHERE t.own_amount>0 AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_ac_v4 ac
    WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
     AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL))>0
  OR (SELECT count(*) FROM pg_temp._routed_tiers t LEFT JOIN (SELECT ac.source_type,ac.source_id,ac.user_id,count(*) AS n FROM pg_temp._routed_ac_v4 ac GROUP BY 1,2,3) c
    ON c.source_type=t.source_type AND c.source_id=t.source_id AND c.user_id=t.user_id
   WHERE COALESCE(c.n,0)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)>0
  OR (SELECT count(*) FROM pg_temp._routed_ac_v4 ac
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=ac.source_type AND t.source_id=ac.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))>0
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 -- The same per-tier running sum (depth is unique within a source).
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum(t.upto),min(t.role)
 FROM (SELECT t.*,sum(t.own_amount) OVER(PARTITION BY t.source_type,t.source_id ORDER BY t.depth ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS upto
  FROM pg_temp._routed_tiers t) t
 LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum(t.upto)>0;
 CREATE TEMP TABLE IF NOT EXISTS _routed_clubs(club_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_clubs;
 INSERT INTO pg_temp._routed_clubs SELECT DISTINCT club_id FROM pg_temp._routed_sources_v4;
 END IF;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing club member wallet and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_clubs) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','commission',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.club_members SET chip_balance=chip_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND chip_balance>=v_edge.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'player_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'player_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT own_amount FROM pg_temp._routed_nodes WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n JOIN public.club_members cm ON cm.club_id=n.club_id AND cm.user_id=n.user_id
   WHERE cm.chip_balance IS DISTINCT FROM n.opening_balance+n.own_amount)
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT cm.club_id,cm.user_id FROM public.club_members cm
  JOIN public.profiles dp ON dp.id=cm.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE n.club_id=cm.club_id AND n.user_id=cm.user_id) AND EXISTS(SELECT FROM pg_temp._routed_edges e WHERE e.club_id=cm.club_id AND e.payee_user=cm.user_id AND e.amount>0) ORDER BY cm.club_id,cm.user_id
 LOOP
  SELECT cm.chip_balance,coalesce(cm.held_chips,0),coalesce(cm.locked_chips,0)
   INTO STRICT v_deleted_before,v_deleted_held,v_deleted_locked FROM public.club_members cm
   WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'player_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-v_deleted_held-v_deleted_locked-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id
     AND cm.chip_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric
     AND coalesce(cm.held_chips,0)=v_deleted_held AND coalesce(cm.locked_chips,0)=v_deleted_locked)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$
;
$r2_definition$;
 EXECUTE $r3_definition$
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE legacy_paid_cash_replay boolean:=false;scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;v4_ok boolean:=false;
 v_plan jsonb;v_plan_used boolean:=false;v_batched boolean:=false;v_stop timestamptz;v_remaining bigint:=0;
 v_paid_before numeric:=0;v_payees_before int:=0;
 deleted_deferral text; v_deleted record; v_deleted_before numeric; v_deleted_held numeric; v_deleted_locked numeric;
 v_deleted_bank numeric; v_deleted_return jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 IF public.fn_ca_launch_accounting_waived(p_scope_kind,p_scope_id,p_period_end) THEN
  RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver');
 END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF p_union_id IS NOT NULL THEN PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end); END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 -- Only a completed cash-only run can read its original untyped allocation
 -- again. Pending certificates need explicit source types before any payment.
 legacy_paid_cash_replay:=FOUND AND previous.routing_version=3 AND previous.result->>'source_version'='2'
  AND NOT(previous.result ? 'source_contract_version');
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 -- CHUNKED CLOSE (20261003, round 3 read once): in a chunked close attempt the
 -- week's reads and allocation tests may come from the attempt that read them
 -- (fn_settle_accounting_rakeback_plan); see below for when they are used.
 v_plan:=public.fn_settle_accounting_rakeback_plan_get(p_scope_kind,p_scope_id,p_period_start,p_period_end,scope.club_ids,p_union_id,standalone_club,legacy_paid_cash_replay);
 CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_nonhouse(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._rr3_plan_nonhouse;
 CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 -- WEEKLY CLOSE SCALE (20260928): the per-period proof, read as sets. The
 -- periods are locked in the original order; the latest certificate of each,
 -- every allocation of every certificate and this scope's sources of the week
 -- are each read once, and every original test is evaluated on them. Only a
 -- book that passes every test takes this path. Any refusal, and anything
 -- this path cannot read, runs the original per-period loop below, unchanged,
 -- which raises exactly what it always raised.
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rr3_periods_v4(ord bigint,LIKE public.rakeback_periods) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_periods_v4;
  -- WEEKLY CLOSE SCALE (20261003): a period of a club outside scope.club_ids
  -- is admitted when this scope earned from its player in the week. Those
  -- (club, player) pairs are read once, for exactly the clubs of such
  -- periods, in this same statement, instead of a scan of the club's whole
  -- week of sources per period (887 s in the 2026-10-01 Midway close: 382
  -- standalone periods). A period whose club is not in that set (only a row
  -- changed under EvalPlanQual) still asks the sources directly.
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT DISTINCT rs.club_id,rs.player_id FROM public.accounting_payable_earning_sources rs
      WHERE rs.club_id IN(SELECT pc.club_id FROM pclubs pc)
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
      AND v_plan IS NULL
     UNION SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'pairs') e
      WHERE v_plan IS NOT NULL AND (e->>0)::uuid IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE OF rp) x;
  CREATE TEMP TABLE IF NOT EXISTS _rr3_certs_v4(period_id uuid PRIMARY KEY,id bigint,accounting_version integer,source_fingerprint text,club_id uuid,player_id uuid,
   coordinator_union_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_amount numeric,display_rate numeric,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_certs_v4;
  INSERT INTO pg_temp._rr3_certs_v4 SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.accounting_version,x.source_fingerprint,x.club_id,x.player_id,
   x.coordinator_union_id,x.period_start,x.period_end,x.rake_generated,x.rakeback_amount,x.display_rate,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rr3_periods_v4) ORDER BY x.period_id,x.id DESC;
  IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr LEFT JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
    WHERE COALESCE(pc.id IS NULL OR pc.accounting_version<>2 OR pc.coordinator_union_id IS DISTINCT FROM p_union_id OR pr.period_start<>from_date OR pr.period_end<>to_date
   OR pc.club_id IS DISTINCT FROM pr.club_id OR pc.player_id IS DISTINCT FROM pr.user_id
   OR pc.period_start IS DISTINCT FROM pr.period_start OR pc.period_end IS DISTINCT FROM pr.period_end
   OR pc.rake_generated IS DISTINCT FROM pr.rake_generated OR pc.rake_generated IS DISTINCT FROM pr.total_rake_paid
   OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_amount OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_earned
   OR pc.display_rate IS DISTINCT FROM pr.rakeback_rate OR pc.rakeback_amount<0 OR pc.rakeback_amount<>round(pc.rakeback_amount,2)
   OR pc.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR pc.payer_kind NOT IN('agent','club')
   OR (pc.payer_kind='agent') IS DISTINCT FROM(pc.payer_user_id IS NOT NULL) OR pc.payer_user_id=pr.user_id,false))=0 THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_wn_v4(club_id uuid,player_id uuid,n bigint,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_wn_v4;
   IF v_plan IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_alloc(period_id uuid PRIMARY KEY,cert_id bigint,club_id uuid,user_id uuid,allocation_count bigint,matched_count bigint,
     generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
    TRUNCATE pg_temp._rr3_plan_alloc;
    INSERT INTO pg_temp._rr3_plan_alloc SELECT (e->>0)::uuid,(e->>1)::bigint,(e->>2)::uuid,(e->>3)::uuid,(e->>4)::bigint,(e->>5)::bigint,
     (e->>6)::numeric,(e->>7)::numeric,(e->>8)::boolean FROM jsonb_array_elements(v_plan->'alloc') e;
    IF NOT EXISTS(SELECT 1 FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rr3_plan_alloc a WHERE a.period_id=pr.id AND a.cert_id=pc.id AND a.club_id=pr.club_id AND a.user_id=pr.user_id)) THEN
     v_plan_used:=true;
    END IF;
   END IF;
   IF NOT v_plan_used THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   -- house_text (20261003): the source's is_union_house as written, read in
   -- this one pass so the missing-period check below need not read the week
   -- of sources again.
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    rs.contract->'membership'->'terms'->>'agent_id',rs.contract->>'is_union_house'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
   ANALYZE pg_temp._rr3_week_v4;
   END IF;
   CREATE TEMP TABLE IF NOT EXISTS _rr3_alloc_v4(period_id uuid PRIMARY KEY,allocation_count bigint,matched_count bigint,generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_alloc_v4;
   -- A source of this allocation that is not in this scope's week slice is
   -- outside the scope or the week, which the original test refuses too.
   IF v_plan_used THEN
    INSERT INTO pg_temp._rr3_alloc_v4 SELECT a.period_id,a.allocation_count,a.matched_count,a.generated,a.unrounded,a.any_bad
     FROM pg_temp._rr3_plan_alloc a JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=a.period_id AND pc.id=a.cert_id;
    INSERT INTO pg_temp._rr3_wn_v4 SELECT (e->>0)::uuid,(e->>1)::uuid,(e->>2)::bigint FROM jsonb_array_elements(v_plan->'counts') e;
    INSERT INTO pg_temp._rr3_plan_nonhouse SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'nonhouse') e;
   ELSE
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
    count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),
    sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
    COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>pr.club_id OR rs.player_id<>pr.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id
      OR NULLIF(rs.agent_text,'')::uuid IS DISTINCT FROM pc.payer_user_id),false)
    FROM pg_temp._rr3_certs_v4 pc JOIN pg_temp._rr3_periods_v4 pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    LEFT JOIN pg_temp._rr3_week_v4 rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
    GROUP BY pc.period_id;
   INSERT INTO pg_temp._rr3_wn_v4 SELECT w.club_id,w.player_id,count(*) FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id;
   END IF;
   IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
     LEFT JOIN pg_temp._rr3_alloc_v4 ag ON ag.period_id=pr.id
     LEFT JOIN pg_temp._rr3_wn_v4 w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
     WHERE COALESCE((COALESCE(ag.allocation_count,0)=0 OR COALESCE(ag.allocation_count,0)<>COALESCE(ag.matched_count,0) OR COALESCE(ag.allocation_count,0)<>COALESCE(w.n,0)
       OR ag.generated IS DISTINCT FROM pc.rake_generated
       OR round(ag.unrounded,2) IS DISTINCT FROM pc.rakeback_amount
       OR pc.display_rate IS DISTINCT FROM (CASE WHEN ag.generated>0 THEN round(ag.unrounded/ag.generated,4) ELSE 0 END))
      OR COALESCE(ag.any_bad,false),false))=0 THEN
    INSERT INTO pg_temp._routed_player_items SELECT pr.id,pc.id,pr.club_id,pr.user_id,pc.payer_kind,pc.payer_user_id,pc.rakeback_amount,pc.rake_generated,pc.display_rate,pc.source_fingerprint,pr.status
     FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id;
    v4_ok:=true;
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_payable_earning_sources rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
     WHERE COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id
      OR NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid IS DISTINCT FROM c.payer_user_id)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 END IF;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 -- 20261003: when the set path admitted the book, _rr3_week_v4 holds exactly
 -- these rows (same predicate, read under this scope's week lock, which every
 -- accrual of the week shares), so they are not read a second time.
 PERFORM set_config('app.accounting_round3_plan_used',CASE WHEN v4_ok AND v_plan_used THEN 'on' ELSE '' END,true);
 IF (CASE WHEN v4_ok AND v_plan_used THEN EXISTS(SELECT 1 FROM pg_temp._rr3_plan_nonhouse rs
     WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
    WHERE COALESCE((rs.house_text)::boolean,false) IS FALSE
     AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)) END)
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 -- CHUNKED CLOSE (20261003, round 3 in batches): inside a chunked close attempt
 -- a period an earlier batch of THIS round paid is recognised by its own
 -- evidence and not paid again; outside one nothing is.
 v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_done(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_done;
 IF v_batched THEN
  INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i
   WHERE i.status='paid' AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id)=1
    AND EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.club_id=i.club_id AND pp.user_id=i.user_id
     AND pp.status='paid' AND pp.payout_amount=i.owed
     AND CASE WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text
       AND l.amount=i.owed AND l.club_id=i.club_id AND l.to_type='player_wallet' AND l.to_entity_id=i.user_id AND l.category='rakeback'
       AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
       AND l.metadata->>'certificate_id'=i.certificate_id::text AND l.metadata->>'payout_id'=pp.id::text
       AND l.metadata->>'source_fingerprint' IS NOT DISTINCT FROM i.fingerprint) ELSE true END);
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_todo(LIKE pg_temp._routed_player_items) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_todo;
 INSERT INTO pg_temp._routed_player_todo SELECT i.* FROM pg_temp._routed_player_items i
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_done d WHERE d.period_id=i.period_id);
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_now(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_now;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(delta) FROM(
  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_todo
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_todo WHERE payer_kind='agent') x GROUP BY club_id,user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_todo) ORDER BY id FOR NO KEY UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_todo WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_player_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_todo WHERE payer_kind='club' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','rakeback',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 v_stop:=clock_timestamp()+interval '90 seconds';
 FOR r IN SELECT * FROM pg_temp._routed_player_todo ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user;
    UPDATE public.club_members SET chip_balance=chip_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user AND chip_balance>=amount RETURNING chip_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user,'PLAYER','debit',amount,'rakeback','Weekly rakeback paid under recorded agreement',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,
     COALESCE(r.payer_user,r.club_id),'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player'),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   paid:=paid+amount;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
  INSERT INTO pg_temp._routed_player_now VALUES(r.period_id);
  IF v_batched AND clock_timestamp()>v_stop THEN EXIT; END IF;
 END LOOP;
 SELECT count(*) INTO v_remaining FROM pg_temp._routed_player_todo t WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_now n WHERE n.period_id=t.period_id);
 IF v_remaining>0 THEN
  -- A batch: every locked wallet must hold exactly what this batch paid it.
  UPDATE pg_temp._routed_player_wallets w SET delta=COALESCE((SELECT sum(x.delta) FROM(
   SELECT t.club_id,t.user_id,t.owed AS delta FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id
   UNION ALL SELECT t.club_id,t.payer_user,-t.owed FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id WHERE t.payer_kind='agent') x
   WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT cm.club_id,cm.user_id FROM public.club_members cm
  JOIN public.profiles dp ON dp.id=cm.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_player_wallets w WHERE w.club_id=cm.club_id AND w.user_id=cm.user_id) AND EXISTS(SELECT FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now done ON done.period_id=t.period_id WHERE t.club_id=cm.club_id AND (t.user_id=cm.user_id OR (t.payer_kind='agent' AND t.payer_user=cm.user_id))) ORDER BY cm.club_id,cm.user_id
 LOOP
  SELECT cm.chip_balance,coalesce(cm.held_chips,0),coalesce(cm.locked_chips,0)
   INTO STRICT v_deleted_before,v_deleted_held,v_deleted_locked FROM public.club_members cm
   WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'player_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-v_deleted_held-v_deleted_locked-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id
     AND cm.chip_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric
     AND coalesce(cm.held_chips,0)=v_deleted_held AND coalesce(cm.locked_chips,0)=v_deleted_locked)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 IF v_remaining>0 THEN
  RETURN jsonb_build_object('success',false,'batch_committed',true,'round',3,'routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
   'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'paid_periods',(SELECT count(*) FROM pg_temp._routed_player_done)+(SELECT count(*) FROM pg_temp._routed_player_now),
   'remaining',v_remaining,'source_fingerprint',fingerprint,'plan_used',v_plan_used);
 END IF;
 -- The round's totals include what earlier batches of it paid.
 SELECT COALESCE(sum(i.owed),0),count(*) INTO v_paid_before,v_payees_before FROM pg_temp._routed_player_items i
  JOIN pg_temp._routed_player_done d ON d.period_id=i.period_id WHERE i.owed>0;
 paid:=paid+v_paid_before;payees:=payees+v_payees_before;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$
;
$r3_definition$;
 EXECUTE $credit_definition$
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_wallet_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_club uuid;
BEGIN
 IF TG_TABLE_NAME='profiles' THEN
  -- Only clubs where the person holds free chips have anything to return.
  FOR v_club IN
   SELECT s.club_id FROM (
    SELECT m.club_id FROM public.club_members m WHERE m.user_id=NEW.id
      AND coalesce(m.chip_balance,0)-coalesce(m.held_chips,0)-coalesce(m.locked_chips,0) > 0
    UNION
    SELECT a.club_id FROM public.agents a WHERE a.user_id=NEW.id
      AND coalesce(a.agent_wallet_balance,0) > 0
   ) s ORDER BY s.club_id
  LOOP
   PERFORM public.fn_ca_deleted_wallet_bank_return(v_club,NEW.id,'wallets');
  END LOOP;
  RETURN NEW;
 END IF;
 -- Only the trusted owning stage may hold a pass-through credit until its
 -- original transfer and final net-balance assertions have completed. Each
 -- stage flushes these exact pinned recipients before returning success.
 -- A browser-set GUC, an agent wallet, or an unrelated row never defers.
 IF TG_TABLE_NAME='club_members' AND public.fn_caller_is_engine() IS TRUE
  AND nullif(current_setting('app.accounting_routing_context',true),'') IS NOT NULL THEN
  IF current_setting('app.deleted_wallet_routing_stage',true)='commission'
   AND to_regclass('pg_temp._routed_nodes') IS NOT NULL THEN
   IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE n.club_id=NEW.club_id AND n.user_id=NEW.user_id) THEN RETURN NEW; END IF;
  ELSIF current_setting('app.deleted_wallet_routing_stage',true)='rakeback'
   AND to_regclass('pg_temp._routed_player_wallets') IS NOT NULL THEN
   IF EXISTS(SELECT FROM pg_temp._routed_player_wallets w WHERE w.club_id=NEW.club_id AND w.user_id=NEW.user_id) THEN RETURN NEW; END IF;
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM public.profiles WHERE id=NEW.user_id AND status='deleted') THEN
  PERFORM public.fn_ca_deleted_wallet_bank_return(NEW.club_id,NEW.user_id,CASE WHEN TG_TABLE_NAME='agents' THEN 'agent_wallet' ELSE 'player_wallet' END);
 END IF;
 RETURN NEW;
END;
$function$
;
$credit_definition$;
 EXECUTE $bank_definition$
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_wallet_bank_return(p_club uuid, p_user uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '4s'
AS $function$
DECLARE
 v_player numeric:=0; v_agent numeric:=0; v_bank numeric; v_owner uuid; v_reserved numeric:=0;
 v_op uuid; v_amount numeric; v_source text; v_key text; v_saved jsonb:='{}'::jsonb;
 v_keys text[]:=ARRAY['app.ledger_category','app.ledger_counterparty',
 'app.ledger_counterparty_entity','app.ledger_counterparty_label','app.ledger_settlement',
 'app.ledger_idempotency_key','app.ledger_correlation','app.ledger_tournament','app.cash_original_debit_ledger','app.ledger_autoskip_clubs',
 'app.ledger_autoskip_club_members','app.ledger_autoskip_agents'];
BEGIN
 PERFORM 1 FROM public.profiles WHERE id=p_user AND status='deleted' FOR SHARE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('success',false,'reason','account_not_deleted');
 END IF;
 IF p_source NOT IN ('wallets','player_wallet','agent_wallet') OR p_source IS NULL THEN RAISE EXCEPTION 'unknown_deleted_wallet_source'; END IF;
 -- Agent-first for the explicit two-wallet lifecycle return. A live credit
 -- takes only its already-owned source row, never the other wallet.
 IF p_source IN ('wallets','agent_wallet') THEN
  SELECT greatest(coalesce(agent_wallet_balance,0),0) INTO v_agent
  FROM public.agents WHERE club_id=p_club AND user_id=p_user FOR UPDATE;
 END IF;
 IF p_source IN ('wallets','player_wallet') THEN
  SELECT greatest(coalesce(chip_balance,0)-coalesce(held_chips,0)-coalesce(locked_chips,0),0)
  INTO v_player FROM public.club_members WHERE club_id=p_club AND user_id=p_user FOR UPDATE;
 END IF;
 v_player:=coalesce(v_player,0); v_agent:=coalesce(v_agent,0);
 -- Published money owed to other players is not free money at account closure.
 -- The private reader locks existing periods NOWAIT and validates latest first.
 IF v_player>0 THEN
  v_reserved:=smarter_private.deleted_wallet_published_rakeback_reserve(p_club,p_user);
  v_player:=greatest(v_player-v_reserved,0);
 END IF;
 SELECT chip_treasury,owner_id INTO v_bank,v_owner FROM public.clubs
 WHERE id=p_club AND asset='chips' AND lifecycle_status='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','not_active_chip_club'); END IF;
 IF v_player+v_agent=0 THEN RETURN jsonb_build_object('success',true,'amount',0,'player_chips',0,'agent_chips',0,'reserved_rakeback',v_reserved,'bank_after',v_bank); END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'platform_is_frozen'; END IF;
 FOREACH v_key IN ARRAY v_keys LOOP
  v_saved:=v_saved||jsonb_build_object(v_key,coalesce(current_setting(v_key,true),''));
 END LOOP;
 FOREACH v_source IN ARRAY ARRAY['player_wallet','agent_wallet'] LOOP
  v_amount:=CASE WHEN v_source='player_wallet' THEN v_player ELSE v_agent END;
  IF v_amount=0 THEN CONTINUE; END IF;
  v_op:=gen_random_uuid();
  PERFORM set_config('app.ledger_autoskip_club_members','',true);
  PERFORM set_config('app.ledger_autoskip_agents','',true);
  PERFORM public.fn_ca_declare_ledger('club_bank_claim','club_treasury',p_club,NULL,
   'deleted_account_bank_return:'||v_op,ARRAY['clubs']);
  PERFORM set_config('app.ledger_correlation',v_op::text,true);
  PERFORM set_config('app.ledger_settlement','',true);
  PERFORM set_config('app.ledger_tournament','',true);
  IF v_source='player_wallet' THEN
   UPDATE public.club_members SET chip_balance=chip_balance-v_amount,updated_at=now()
   WHERE club_id=p_club AND user_id=p_user;
  ELSE
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_amount,updated_at=now()
   WHERE club_id=p_club AND user_id=p_user;
  END IF;
  UPDATE public.clubs SET chip_treasury=coalesce(chip_treasury,0)+v_amount,updated_at=now()
  WHERE id=p_club RETURNING chip_treasury INTO v_bank;
  INSERT INTO public.chip_transactions
   (club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,balance_after)
  VALUES(p_club,p_user,v_owner,v_amount,'club_bank_claim','Deleted Account Chips Returned To Club Bank',
   jsonb_build_object('op_id',v_op,'source',v_source,'direction','into_bank',
    'reason','deleted_account','bank_after',v_bank)
    ||CASE WHEN public.fn_caller_is_engine() IS TRUE AND nullif(current_setting('app.accounting_routing_context',true),'') IS NOT NULL
      THEN jsonb_build_object('accounting_routing_context',current_setting('app.accounting_routing_context',true)) ELSE '{}'::jsonb END,v_bank);
 END LOOP;
 FOREACH v_key IN ARRAY v_keys LOOP PERFORM set_config(v_key,v_saved->>v_key,true); END LOOP;
 RETURN jsonb_build_object('success',true,'amount',v_player+v_agent,
  'player_chips',v_player,'agent_chips',v_agent,'reserved_rakeback',v_reserved,'bank_after',v_bank);
END;
$function$
;
$bank_definition$;
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)','299975706a6b2ad943909e56a967d88c','16b74eb4a36d36b904175fda51ec1c17','{postgres=X/postgres}',ARRAY['search_path=public']),
 ('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)','d880a99b18d966c092f5d5fb6f2ee98b','53fdf97d6727ae71c4513bf0bdbbcb22','{postgres=X/postgres}',ARRAY['search_path=public']),
 ('public.fn_ca_deleted_wallet_credit()','dbd7c02c8cd647c413cfec866c4e4570','d01fd46873c4243c46793c1ef1d314de','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp']),
 ('public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text)','975a6eb235c2d0a6e0f7e84043bb3d28','a8ca12d5f4c45bf4a9d508ae1a598aee','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp','lock_timeout=4s'])
 ) pins(sig,full_hash,body_hash,acl,config) LOOP
  IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure(r.sig)
   AND md5(pg_get_functiondef(p.oid))=r.full_hash AND md5(p.prosrc)=r.body_hash
   AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
   AND p.proacl::text=r.acl AND p.proconfig=r.config) THEN
   RAISE EXCEPTION 'deleted_weekly_installed_authority_changed %',r.sig;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)')
  AND md5(p.prosrc)='bac28580767de41b0a852e4a427b810c' AND p.prorettype='numeric'::regtype
  AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
  AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public']) THEN
  RAISE EXCEPTION 'deleted_weekly_private_reserve_authority_changed'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
  OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM generation THEN
  RAISE EXCEPTION 'deleted_weekly_inventory_generation_changed'; END IF;
END $deleted_weekly$;
COMMIT;
