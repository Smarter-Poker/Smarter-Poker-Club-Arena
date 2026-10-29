-- @live-proof: md5(pg_get_functiondef('smarter_private.admit_own_agent_source(text,uuid)'::regprocedure))='dbac86129f9285e95a50408959f50c9f' AND md5(pg_get_functiondef('smarter_private.assert_own_agent_scope_interpreted(text,uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure))='e1fb96151324d44215c10047f7604ddd' AND md5(pg_get_functiondef('ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure))='30452e1de3d5c3a5bb0d63b4c803b3db' AND md5(pg_get_functiondef('fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)'::regprocedure))='62bd1db4a493c3f86ca90f32eaca456a' AND md5(pg_get_functiondef('fn_accounting_tournament_commission_source_guard()'::regprocedure))='a27f5faacd2c469df32f4b5e9692113c' AND md5(pg_get_functiondef('fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='dce90bd407404e6bf8e135874b7b9209' AND md5(pg_get_functiondef('fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='737ffac96388517d170c9962174f0222' AND md5(pg_get_functiondef('fn_ca_rakeback_payout_leg_is_documented()'::regprocedure))='27b613b98de1d922d0ee65e9259c0cea' AND md5(pg_get_functiondef('fn_ca_settlement_correctness_check()'::regprocedure))='295c3580a4f411fe18b33a3c8486b0e6' AND md5(pg_get_functiondef('fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))='ced29c928d73b73be75d9e94604a2f7a' AND md5(pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='9960208f5b5398132a8e702497bbb3ba' AND md5(pg_get_functiondef('fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure))='1d8486415e6213f4ec848de0b1dba74b' AND md5(pg_get_functiondef('fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure))='487fb5a310d17a1464d87211e7d9dd54' AND md5(pg_get_functiondef('fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='acc58329cf6eb0e50ca47afea3bdf60f' AND md5(pg_get_functiondef('fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='cbf5dc2e01fada46b4f04625f00282f9' AND md5(pg_get_functiondef('fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='3e86c68bae02fb88d651ba5498620db8' AND md5(pg_get_functiondef('smarter_private.own_agent_destination_contract(jsonb,uuid,uuid,timestamp with time zone)'::regprocedure))='65d809f307db4bea0ead0dcd7a3d1534' AND md5(pg_get_functiondef('smarter_private.own_agent_interpreted_contract(jsonb,uuid,uuid,numeric,uuid,timestamp with time zone)'::regprocedure))='038e7a69161b7d9b8434fe270fe45f59' AND md5(pg_get_functiondef('smarter_private.prepare_own_agent_interpretation(uuid,uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure))='a86b1158f63c3cd912b2fb70cdd0ba23' AND md5(pg_get_functiondef('smarter_private.rakeback_certificate_wallets(bigint)'::regprocedure))='984721591c0295a6ca5c5552ec7bfae0' AND md5(pg_get_functiondef('smarter_private.rakeback_wallet_payout_complete(uuid,bigint)'::regprocedure))='0f5fbe00efb06f9a49dcfae37d5830cc' AND md5(pg_get_functiondef('smarter_private.rakeback_wallet_plan(jsonb,numeric)'::regprocedure))='48f1c18a1e83272bad0d0b1e1371ce42' AND md5(pg_get_functiondef('smarter_private.record_rakeback_wallet_contracts()'::regprocedure))='e0ba664285b5b6cc885fd6a2357d8596' AND md5(pg_get_functiondef('smarter_private.weekly_payout_prepare_due()'::regprocedure))='71e651b7e956674a7d288e0fe49ff3af' AND EXISTS(SELECT FROM pg_trigger WHERE tgname='zz_ca_own_agent_rakeback_leg_documented'AND tgrelid='public.chip_ledger'::regclass AND tgenabled='O')
-- @install-window: daily-maintenance
-- Own playing earnings use their observed historical AGENT agreement.
-- Original v3 paid receipts/ABI remain authoritative; only unpaid R0 admits
-- versioned interpretations. New typed destination receipts are cold sidecars.
-- Trigger DDL uses the original daily-window applier. No money runs at install.
BEGIN;
CREATE TEMP TABLE _own_agent_install_metadata(signature text PRIMARY KEY,metadata jsonb NOT NULL)ON COMMIT DROP;
CREATE TEMP TABLE _own_agent_install_views(name text PRIMARY KEY,metadata jsonb NOT NULL)ON COMMIT DROP;
DO $pre$
DECLARE r record;p pg_proc%ROWTYPE;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'THEN RAISE EXCEPTION 'own_agent_installer_postgres_required';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028162126')THEN RAISE EXCEPTION 'own_agent_owned_phase_dependency_missing';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true
 OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM 'original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'THEN RAISE EXCEPTION 'own_agent_original_inventory_authority_changed';END IF;
 FOR r IN SELECT*FROM jsonb_to_recordset($owners$[{"signature":"ca_player_stats_financial_report(uuid,uuid,integer,text,text)","md5":"79d56064bddddd2025c17310127a62e5","acl":["postgres=X/postgres","service_role=X/postgres","authenticated=X/postgres"],"config":["search_path=public"]},{"signature":"fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)","md5":"440c0bc501e1c2094b8d4c947533c08d","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"fn_accounting_tournament_commission_source_guard()","md5":"7bfe57c82e08e6a939a16c0c27c7a28d","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone)","md5":"01abfa84da1dbe701503ad1da7585d0b","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public","enable_indexscan=off"]},{"signature":"fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone)","md5":"d4cac33feea3669be963d453fa82eb0f","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public","enable_indexscan=off","enable_nestloop=off"]},{"signature":"fn_ca_rakeback_payout_leg_is_documented()","md5":"acd6934686f69e1647302357cfd99a3f","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"fn_ca_settlement_correctness_check()","md5":"aff58a0089c75f8e152e77e9d96fb7c8","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])","md5":"4a835bd96653c977e5519f6dcfd7a7c6","acl":["postgres=X/postgres"],"config":["search_path=public","statement_timeout=300s"]},{"signature":"fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)","md5":"62c444b0953cced8a4f3144fc86af51b","acl":["postgres=X/postgres"],"config":["search_path=public"]},{"signature":"fn_rakeback_split_check(uuid,date,date,uuid[])","md5":"4255ae4df6902f370d13dc69632277bb","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"fn_rakeback_split_write(uuid,date,date,uuid[])","md5":"d7d52bfca1f480a869ca8018efe3a854","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)","md5":"c69a291c3347a6b27fbc62016411d7b2","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)","md5":"5b50ed269444dfe82b2bb15782ad50c0","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)","md5":"236228d068e90194a306b81d0f6c88fd","acl":["postgres=X/postgres","service_role=X/postgres"],"config":["search_path=public"]},{"signature":"smarter_private.weekly_payout_prepare_due()","md5":"340403efcb909853831de1c46b6e278b","acl":["postgres=X/postgres"],"config":["search_path=pg_catalog, public"]}]$owners$::jsonb)AS x(signature text,md5 text,acl jsonb,config jsonb)LOOP
  SELECT*INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(r.signature);
  IF md5(pg_get_functiondef(p.oid))IS DISTINCT FROM r.md5 OR pg_get_userbyid(p.proowner)<>'postgres'
  OR to_jsonb(p.proacl)IS DISTINCT FROM r.acl OR to_jsonb(p.proconfig)IS DISTINCT FROM r.config THEN RAISE EXCEPTION 'own_agent_owner_preimage_changed:%',r.signature;END IF;
  INSERT INTO pg_temp._own_agent_install_metadata VALUES(r.signature,to_jsonb(p)-'prosrc');
 END LOOP;
 FOR r IN SELECT*FROM jsonb_to_recordset($views$[{"name":"accounting_effective_cash_rake_sources","md5":"283ece5420f330326e0a618a0cee6c23"},{"name":"accounting_payable_earning_sources","md5":"29a96f8b683f5d1e3b31459442e2f9e1"}]$views$::jsonb)AS x(name text,md5 text)LOOP
  IF md5(pg_get_viewdef(('public.'||r.name)::regclass,true))IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'own_agent_effective_view_preimage_changed:%',r.name;END IF;
  INSERT INTO pg_temp._own_agent_install_views SELECT r.name,to_jsonb(c)FROM pg_class c WHERE c.oid=('public.'||r.name)::regclass;
 END LOOP;
END $pre$;

-- Maintained owner: supabase/accounting/own-agent-v1/earning-contract.sql
CREATE OR REPLACE FUNCTION public.fn_accounting_earning_contract(p_club_id uuid, p_player_id uuid, p_rake numeric, p_game_union_id uuid, p_terms_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE member jsonb;agent jsonb;terms jsonb;chain jsonb;remaining numeric;rate numeric;amount numeric;
 seen uuid[];agent_id uuid;parent_id uuid;agent_user uuid;direct_user uuid;union_count int;coordinator_union uuid;union_agreement jsonb;union_house boolean;
BEGIN
 -- Private EXECUTE grants admit only trusted source owners, including the
 -- registration trigger running for a human. Public wrappers verify actors.
 IF p_club_id IS NULL OR p_player_id IS NULL OR p_terms_at IS NULL OR NOT isfinite(p_terms_at) OR p_terms_at>clock_timestamp()
  OR p_rake IS NULL OR p_rake<0 OR p_rake<>round(p_rake,2) OR p_rake::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'invalid_accounting_earning_contract' USING ERRCODE='22023'; END IF;
  SELECT count(*),(array_agg((uc.after_terms->>'union_id')::uuid))[1],
   (jsonb_agg(jsonb_build_object('history_id',uc.id,'observed_at',uc.observed_at,'terms',uc.after_terms)))->0
   INTO union_count,coordinator_union,union_agreement FROM (
    SELECT DISTINCT ON(h.entity_key) h.id,h.observed_at,h.after_terms FROM public.accounting_agreement_history h
     WHERE h.entity_type='union_clubs' AND h.club_id=p_club_id AND h.observed_at<=p_terms_at
     ORDER BY h.entity_key,h.observed_at DESC,h.id DESC) uc
    WHERE uc.after_terms IS NOT NULL AND uc.after_terms->>'club_id'=p_club_id::text;
  SELECT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS TRUE
   AND p_game_union_id IS NOT NULL AND (c.id=p_game_union_id OR c.union_id=p_game_union_id)) INTO union_house;
  IF union_house THEN coordinator_union:=p_game_union_id;union_agreement:=NULL; END IF;
  IF union_count>1 OR (p_game_union_id IS NOT NULL AND NOT union_house AND (union_count<>1 OR coordinator_union IS DISTINCT FROM p_game_union_id))
  THEN RAISE EXCEPTION 'cash_commission_earning_club_not_observed' USING ERRCODE='23514'; END IF;
  member:=public.fn_accounting_terms_at('club_members',p_club_id::text||':'||p_player_id::text,p_terms_at);
  terms:=member->'terms';
  IF terms IS NULL OR terms='null'::jsonb OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'user_id' IS DISTINCT FROM p_player_id::text
   OR (terms->>'status' IS NULL OR terms->>'status' NOT IN('active','approved')) OR COALESCE((terms->>'is_active')::boolean,true)=false
  THEN RAISE EXCEPTION 'cash_commission_membership_not_active_at_earning' USING ERRCODE='23514'; END IF;
  direct_user:=NULLIF(terms->>'agent_id','')::uuid; agent:=NULL;
  -- An agent's own historical agreement covers their playing account too.
  -- A promotion without its observed agent row still uses the original upline.
  IF terms->>'role' IN ('super_agent','agent','sub_agent') AND NOT COALESCE(
    (terms->>'player_rakeback_pct')::numeric=0.70 AND EXISTS(SELECT 1 FROM public.clubs owner_club
      WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user),false) THEN
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,p_player_id,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active') THEN agent:=NULL; ELSE RAISE; END IF;
   END;
  END IF;
  IF agent IS NOT NULL AND agent->'terms' IS NOT NULL AND agent->'terms'<>'null'::jsonb THEN
   NULL; -- The unchanged hierarchy loop validates the own agreement and parents.
  ELSIF (terms->>'player_rakeback_pct')::numeric=0.70 AND EXISTS(
    SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user
  ) THEN
   -- Explicit direct-owner seventy percent deals are club-funded.
   agent:=NULL;
  ELSIF direct_user IS NOT NULL THEN
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,direct_user,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    -- An owner is not required to carry an agent agreement. Retain the real
    -- observed player deal during reassignment as well as after its rate edit.
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active')
       AND EXISTS(SELECT 1 FROM public.clubs owner_club
         WHERE owner_club.id=p_club_id AND owner_club.owner_id=direct_user)
    THEN agent:=NULL; ELSE RAISE; END IF;
   END;
  ELSE
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,p_player_id,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active') THEN agent:=NULL; ELSE RAISE; END IF; END;
  END IF;
  remaining:=p_rake;chain:='[]';seen:=ARRAY[]::uuid[];
  WHILE agent IS NOT NULL AND agent->'terms' IS NOT NULL AND agent->'terms'<>'null'::jsonb LOOP
   terms:=agent->'terms'; agent_id:=(terms->>'id')::uuid;agent_user:=(terms->>'user_id')::uuid;
   IF agent_id IS NULL OR agent_user IS NULL OR agent_id=ANY(seen) OR cardinality(seen)>=64
    OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'status' IS DISTINCT FROM 'active'
    OR terms->>'role' IS NULL OR terms->>'role' NOT IN('super_agent','agent','sub_agent')
   THEN RAISE EXCEPTION 'cash_commission_hierarchy_invalid_at_earning' USING ERRCODE='23514'; END IF;
   seen:=array_append(seen,agent_id);
   rate:=(terms->>'commission_rate')::numeric;
   IF rate>1 THEN rate:=rate/100; END IF;
   IF rate IS NULL OR rate<0 OR rate>1 OR rate::text IN('NaN','Infinity','-Infinity')
   THEN RAISE EXCEPTION 'cash_commission_rate_invalid_at_earning' USING ERRCODE='23514'; END IF;
   -- Preserve the installed agreement model: each upline rate applies to the
   -- remaining rake after the preceding tier. Round each payable to cents.
   amount:=round(remaining*rate,2);
   chain:=chain||jsonb_build_array(jsonb_build_object('agent_id',agent_id,'user_id',agent_user,
    'role',terms->>'role','depth',cardinality(seen),'rake_basis',p_rake,'remaining_basis',remaining,
    'rate',rate,'amount',amount,'agreement',agent));
   remaining:=remaining-amount;
   parent_id:=NULLIF(terms->>'parent_agent_id','')::uuid;
   IF parent_id IS NULL THEN agent:=NULL; ELSE agent:=public.fn_accounting_terms_at('agents',parent_id::text,p_terms_at); END IF;
  END LOOP;
 RETURN jsonb_build_object('player_id',p_player_id,'club_id',p_club_id,'union_id',p_game_union_id,
  'coordinator_union_id',coordinator_union,'rake_credit',p_rake,'membership',member,'tiers',chain,
  'club_residual',remaining,'union_agreement',union_agreement,'is_union_house',union_house,'terms_at',p_terms_at);
END $function$;

-- Maintained owner: supabase/accounting/own-agent-v1/destination-contract.sql
-- The explicit owner-funded seventy-percent benefit is retained in full.
-- An observed own-agent agreement selects its historical AGENT destination;
-- promotion before that agreement remains the original PLAYER destination.
CREATE OR REPLACE FUNCTION smarter_private.own_agent_destination_contract(
 p_contract jsonb,p_club uuid,p_player uuid,p_terms_at timestamptz
)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $destination$
DECLARE member jsonb:=p_contract#>'{membership,terms}'; own jsonb; terms jsonb;
BEGIN
 IF member->>'role'NOT IN('super_agent','agent','sub_agent')OR member->>'role'IS NULL
  OR(member->>'player_rakeback_pct')::numeric IS DISTINCT FROM .70
  OR jsonb_array_length(p_contract->'tiers')<>0
  OR NOT EXISTS(SELECT FROM public.clubs c WHERE c.id=p_club AND c.owner_id=NULLIF(member->>'agent_id','')::uuid)
 THEN RETURN NULL;END IF;
 BEGIN own:=public.fn_accounting_agent_terms_at(p_club,p_player,p_terms_at);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active')THEN RETURN NULL;ELSE RAISE;END IF;
 END;
 terms:=own->'terms';
 IF terms IS NULL OR terms='null'::jsonb THEN RETURN NULL;END IF;
 IF terms->>'club_id'IS DISTINCT FROM p_club::text OR terms->>'user_id'IS DISTINCT FROM p_player::text
  OR terms->>'status'IS DISTINCT FROM'active'OR COALESCE(terms->>'role','')NOT IN('super_agent','agent','sub_agent')
  OR NULLIF(terms->>'id','')IS NULL OR(own->>'history_id')::bigint IS NULL OR(own->>'observed_at')::timestamptz>p_terms_at
 THEN RAISE EXCEPTION 'owner_agent_destination_contract_invalid' USING ERRCODE='55000';END IF;
 RETURN own;
END $destination$;
REVOKE ALL ON FUNCTION smarter_private.own_agent_destination_contract(jsonb,uuid,uuid,timestamptz)FROM PUBLIC,anon,authenticated,service_role;

-- Maintained owner: supabase/accounting/own-agent-v1/unpaid-interpretation.sql
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

-- Maintained owner: supabase/accounting/own-agent-v1/effective-views.sql
CREATE OR REPLACE VIEW public.accounting_effective_cash_rake_sources AS SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,coalesce(a.admitted_contract,s.contract)contract,greatest(s.recorded_at,a.admitted_at)recorded_at FROM ( SELECT s.id,
    s.rake_record_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    COALESCE(a.admitted_contract, s.contract) AS contract,
    GREATEST(s.recorded_at, a.admitted_at) AS recorded_at
   FROM accounting_cash_rake_sources s
     LEFT JOIN accounting_cash_atomic_contract_admissions a ON a.source_id = s.id
  WHERE NOT (EXISTS ( SELECT
           FROM accounting_cash_funding_contract_admissions f
          WHERE f.source_id = s.id))
UNION ALL
 SELECT s.id,
    s.rake_record_id,
    s.player_id,
    f.funding_club_id AS club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    f.admitted_contract AS contract,
    GREATEST(s.recorded_at, a.admitted_at, f.admitted_at) AS recorded_at
   FROM accounting_cash_funding_contract_admissions f
     JOIN accounting_cash_rake_sources s ON s.id = f.source_id
     LEFT JOIN accounting_cash_atomic_contract_admissions a ON a.source_id = s.id
)s LEFT JOIN public.accounting_own_agent_interpretations a ON a.source_type='cash_rake_accrual'AND a.source_id=s.id;
CREATE VIEW public.accounting_effective_tournament_fee_sources AS SELECT s.id,s.rake_record_id,s.tournament_id,s.player_id,s.club_id,s.union_id,s.coordinator_union_id,s.game_type,s.registration_id,s.source_charge_ledger_id,s.source_entitlement_id,s.charged_at,s.rake_credit,coalesce(a.admitted_contract,s.contract)AS contract,greatest(s.recorded_at,a.admitted_at)AS recorded_at FROM public.accounting_tournament_fee_sources s LEFT JOIN public.accounting_own_agent_interpretations a ON a.source_type='tournament_fee_accrual'AND a.source_id=s.id;
REVOKE ALL ON public.accounting_effective_tournament_fee_sources FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE VIEW public.accounting_payable_earning_sources AS  SELECT 'cash_rake_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    NULL::uuid AS tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    s.contract
   FROM accounting_effective_cash_rake_sources s
     LEFT JOIN fn_ca_launch_accounting_club_cutoffs() bd(club_id, cutoff_at) ON bd.club_id = s.club_id
  WHERE bd.cutoff_at IS NULL OR s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at >= bd.cutoff_at
UNION ALL
 SELECT 'tournament_fee_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    s.tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    rs.recognized_at AS earned_at,
    s.rake_credit,
    s.contract
   FROM public.accounting_effective_tournament_fee_sources s
     JOIN accounting_tournament_recognized_sources rs ON rs.source_id = s.id AND rs.tournament_id = s.tournament_id
     JOIN accounting_tournament_fee_recognitions r ON r.tournament_id = s.tournament_id
     LEFT JOIN fn_ca_launch_accounting_club_cutoffs() bd(club_id, cutoff_at) ON bd.club_id = s.club_id
  WHERE (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at >= bd.cutoff_at) AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at >= bd.cutoff_at) AND rs.disposition = 'earned'::text AND r.status = 'recognized'::text AND rs.rake_credit = s.rake_credit AND rs.recognized_at = r.recognized_at AND NOT s.union_id IS DISTINCT FROM r.union_id;

-- Restate the exact original view ACLs for static admission and preserve them at installation.
REVOKE ALL ON public.accounting_effective_cash_rake_sources FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.accounting_payable_earning_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_payable_earning_sources TO service_role;

-- Maintained owner: supabase/accounting/own-agent-v1/typed-receipts.sql
-- New interpretation evidence is separate from every original v3 row shape.
-- No foreign keys to game, club or wallet tables. Trigger DDL is installed
-- only by the existing daily-maintenance migration route.
CREATE TABLE public.accounting_rakeback_wallet_contracts(
 calculation_id bigint NOT NULL,payer_kind text NOT NULL CHECK(payer_kind IN('club','agent')),
 payer_entity_id uuid NOT NULL,payer_user_id uuid,destination_kind text NOT NULL CHECK(destination_kind IN('player_wallet','agent_wallet')),
 amount numeric NOT NULL CHECK(amount>=0 AND amount=round(amount,2)AND amount::text NOT IN('NaN','Infinity','-Infinity')),unrounded numeric NOT NULL CHECK(unrounded>=0 AND unrounded::text NOT IN('NaN','Infinity','-Infinity')),
 rake numeric NOT NULL CHECK(rake>=0 AND rake=round(rake,2)AND rake::text NOT IN('NaN','Infinity','-Infinity')),source_count bigint NOT NULL CHECK(source_count>0),source_fingerprint text NOT NULL,
 PRIMARY KEY(calculation_id,payer_kind,payer_entity_id,destination_kind),CHECK((payer_kind='agent')=(payer_user_id IS NOT NULL))
);
CREATE TABLE public.accounting_rakeback_wallet_transfers(
 payout_id uuid NOT NULL,calculation_id bigint NOT NULL,period_id uuid NOT NULL,payer_kind text NOT NULL CHECK(payer_kind IN('club','agent')),
 payer_entity_id uuid NOT NULL,destination_kind text NOT NULL CHECK(destination_kind IN('player_wallet','agent_wallet')),
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)AND amount::text NOT IN('NaN','Infinity','-Infinity')),ledger_id uuid NOT NULL UNIQUE,wallet_transaction_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(payout_id,payer_kind,payer_entity_id,destination_kind)
);
ALTER TABLE public.accounting_rakeback_wallet_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_rakeback_wallet_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_rakeback_wallet_contracts,public.accounting_rakeback_wallet_transfers FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER own_agent_wallet_contract_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_wallet_contracts FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_wallet_contract_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_wallet_contracts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_wallet_transfer_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_wallet_transfers FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER own_agent_wallet_transfer_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_wallet_transfers FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION smarter_private.rakeback_wallet_plan(p_allocations jsonb,p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $plan$
DECLARE original jsonb;result jsonb;
BEGIN
 original:=smarter_private.rakeback_payer_plan(p_allocations,p_amount);
 IF EXISTS(SELECT FROM jsonb_array_elements(p_allocations)a WHERE a?'destination_kind'AND(a->>'destination_kind'IS DISTINCT FROM'agent_wallet'OR a->>'interpretation_version'IS DISTINCT FROM'own-agent-v1'OR jsonb_typeof(a->'destination_agreement')IS DISTINCT FROM'object'))THEN RAISE EXCEPTION 'rakeback_wallet_destination_invalid' USING ERRCODE='23514';END IF;
 WITH groups AS(
  SELECT a->>'payer_kind'kind,NULLIF(a->>'payer_user_id','')::uuid payer,coalesce(a->>'destination_kind','player_wallet')destination,
   sum((a->>'rake_credit')::numeric)rake,sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)unrounded,count(*)n
  FROM jsonb_array_elements(p_allocations)a GROUP BY 1,2,3
 ),cents AS(
  SELECT g.*,floor(g.unrounded*100)whole,row_number()OVER(PARTITION BY g.kind,g.payer ORDER BY g.unrounded*100-floor(g.unrounded*100)DESC,g.destination)rank,
   (p->>'amount')::numeric*100-sum(floor(g.unrounded*100))OVER(PARTITION BY g.kind,g.payer)extra
  FROM groups g JOIN jsonb_array_elements(original)p ON p->>'payer_kind'=g.kind AND NULLIF(p->>'payer_user_id','')::uuid IS NOT DISTINCT FROM g.payer
 )SELECT jsonb_agg(jsonb_build_object('payer_kind',kind,'payer_user_id',payer,'destination_kind',destination,'rake',rake,'unrounded',unrounded,'source_count',n,'amount',(whole+CASE WHEN rank<=extra THEN 1 ELSE 0 END)/100)ORDER BY kind,payer NULLS FIRST,destination)INTO result FROM cents;
 IF(SELECT sum((p->>'amount')::numeric)FROM jsonb_array_elements(result)p)IS DISTINCT FROM p_amount THEN RAISE EXCEPTION 'rakeback_wallet_plan_not_conserved' USING ERRCODE='23514';END IF;
 RETURN result;
END $plan$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_wallet_plan(jsonb,numeric)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.record_rakeback_wallet_contracts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $record$
DECLARE allocation jsonb;actual jsonb;authority jsonb;plan jsonb;n int;
BEGIN
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(NEW.source_allocations)a WHERE a?'destination_kind')THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT FROM public.rakeback_periods r WHERE r.id=NEW.period_id AND r.status='pending')THEN RAISE EXCEPTION 'typed_wallet_certificate_requires_unpaid_period' USING ERRCODE='23514';END IF;
 FOR allocation IN SELECT a FROM jsonb_array_elements(NEW.source_allocations)a WHERE a?'destination_kind'LOOP
  SELECT count(*),(jsonb_agg(to_jsonb(s)))->0 INTO n,actual FROM public.accounting_payable_earning_sources s WHERE s.source_type=allocation->>'source_type'AND s.source_id=(allocation->>'source_id')::uuid;
  IF n<>1 OR actual->>'club_id'IS DISTINCT FROM NEW.club_id::text OR actual->>'player_id'IS DISTINCT FROM NEW.player_id::text THEN RAISE EXCEPTION 'typed_wallet_source_identity_changed' USING ERRCODE='23514';END IF;
  authority:=smarter_private.own_agent_destination_contract(actual->'contract',NEW.club_id,NEW.player_id,(allocation->>'agreement_at')::timestamptz);
  IF authority IS NULL OR authority IS DISTINCT FROM allocation->'destination_agreement'OR allocation->>'interpretation_version'IS DISTINCT FROM'own-agent-v1'OR allocation->>'destination_kind'IS DISTINCT FROM'agent_wallet'OR(allocation->>'rate')::numeric IS DISTINCT FROM .70 OR actual#>>'{contract,membership,terms,role}'NOT IN('super_agent','agent','sub_agent')THEN RAISE EXCEPTION 'typed_wallet_historical_destination_not_observed' USING ERRCODE='23514';END IF;
 END LOOP;
 plan:=smarter_private.rakeback_wallet_plan(NEW.source_allocations,NEW.rakeback_amount);
 INSERT INTO public.accounting_rakeback_wallet_contracts(calculation_id,payer_kind,payer_entity_id,payer_user_id,destination_kind,amount,unrounded,rake,source_count,source_fingerprint)
 SELECT NEW.id,p->>'payer_kind',coalesce(NULLIF(p->>'payer_user_id','')::uuid,NEW.club_id),NULLIF(p->>'payer_user_id','')::uuid,p->>'destination_kind',(p->>'amount')::numeric,(p->>'unrounded')::numeric,(p->>'rake')::numeric,(p->>'source_count')::bigint,NEW.source_fingerprint FROM jsonb_array_elements(plan)p;
 RETURN NULL;
END $record$;
REVOKE ALL ON FUNCTION smarter_private.record_rakeback_wallet_contracts()FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_accounting_rakeback_wallet_contracts AFTER INSERT ON public.accounting_rakeback_period_calculations FOR EACH ROW EXECUTE FUNCTION smarter_private.record_rakeback_wallet_contracts();

CREATE FUNCTION smarter_private.rakeback_certificate_wallets(p_calculation bigint)
RETURNS TABLE(payer_kind text,payer_user uuid,payer_entity uuid,owed numeric,destination_kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $payers$
DECLARE c public.accounting_rakeback_period_calculations%ROWTYPE;plan jsonb;
BEGIN
 SELECT*INTO STRICT c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(c.source_allocations)a WHERE a?'destination_kind')THEN
  RETURN QUERY SELECT g.payer_kind,g.payer_user,g.payer_entity,g.owed,'player_wallet'::text FROM smarter_private.rakeback_certificate_payers(p_calculation)g;RETURN;
 END IF;
 -- Preserve and verify the original per-payer contract and cent allocation.
 PERFORM*FROM smarter_private.rakeback_certificate_payers(p_calculation);
 plan:=smarter_private.rakeback_wallet_plan(c.source_allocations,c.rakeback_amount);
 IF(SELECT count(*)FROM public.accounting_rakeback_wallet_contracts w WHERE w.calculation_id=c.id)<>jsonb_array_length(plan)
 OR EXISTS(SELECT FROM jsonb_array_elements(plan)p LEFT JOIN public.accounting_rakeback_wallet_contracts w ON w.calculation_id=c.id AND w.payer_kind=p->>'payer_kind'AND w.payer_entity_id=coalesce(NULLIF(p->>'payer_user_id','')::uuid,c.club_id)AND w.destination_kind=p->>'destination_kind'WHERE w.calculation_id IS NULL OR w.amount IS DISTINCT FROM(p->>'amount')::numeric OR w.unrounded IS DISTINCT FROM(p->>'unrounded')::numeric OR w.rake IS DISTINCT FROM(p->>'rake')::numeric OR w.source_count IS DISTINCT FROM(p->>'source_count')::bigint OR w.source_fingerprint IS DISTINCT FROM c.source_fingerprint OR w.payer_user_id=c.player_id)
 THEN RAISE EXCEPTION 'typed_wallet_contract_disagrees' USING ERRCODE='23514';END IF;
 RETURN QUERY SELECT w.payer_kind,w.payer_user_id,w.payer_entity_id,w.amount,w.destination_kind FROM public.accounting_rakeback_wallet_contracts w WHERE w.calculation_id=c.id ORDER BY w.payer_kind,w.payer_entity_id,w.destination_kind;
END $payers$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_certificate_wallets(bigint)FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.rakeback_wallet_payout_complete(p_payout uuid,p_calculation bigint)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $complete$
DECLARE pp public.rakeback_period_payouts%ROWTYPE;c public.accounting_rakeback_period_calculations%ROWTYPE;
BEGIN
 SELECT*INTO pp FROM public.rakeback_period_payouts WHERE id=p_payout;
 SELECT*INTO c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF pp.id IS NULL OR c.id IS NULL OR pp.status IS DISTINCT FROM'paid'OR pp.rakeback_period_id IS DISTINCT FROM c.period_id OR pp.club_id IS DISTINCT FROM c.club_id OR pp.user_id IS DISTINCT FROM c.player_id OR pp.payout_amount IS DISTINCT FROM c.rakeback_amount
 OR NOT EXISTS(SELECT FROM public.rakeback_periods r WHERE r.id=c.period_id AND r.status='paid')
 OR NOT EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts w WHERE w.calculation_id=c.id AND w.destination_kind='agent_wallet')THEN RETURN false;END IF;
 IF(SELECT count(*)FROM public.accounting_rakeback_wallet_transfers t WHERE t.payout_id=pp.id)<>(SELECT count(*)FROM smarter_private.rakeback_certificate_wallets(c.id)g WHERE g.owed>0)THEN RETURN false;END IF;
 RETURN NOT EXISTS(
 SELECT FROM smarter_private.rakeback_certificate_wallets(c.id)g
 LEFT JOIN public.accounting_rakeback_wallet_transfers t ON t.payout_id=pp.id AND t.payer_kind=g.payer_kind AND t.payer_entity_id=g.payer_entity AND t.destination_kind=g.destination_kind
 LEFT JOIN public.chip_ledger l ON l.id=t.ledger_id LEFT JOIN public.wallet_transactions w ON w.id=t.wallet_transaction_id
 CROSS JOIN LATERAL(SELECT CASE WHEN g.payer_kind='club'OR g.payer_user IS NULL OR(l.from_type='club_treasury'AND l.metadata->>'owner_share_payer'=g.payer_user::text)THEN'club_treasury'ELSE'agent_wallet'END kind)funded
 WHERE g.owed>0 AND(t.payout_id IS NULL OR t.calculation_id IS DISTINCT FROM c.id OR t.period_id IS DISTINCT FROM c.period_id OR t.amount IS DISTINCT FROM g.owed
 OR l.amount IS DISTINCT FROM g.owed OR l.club_id IS DISTINCT FROM c.club_id OR l.from_type IS DISTINCT FROM funded.kind OR l.from_entity_id IS DISTINCT FROM CASE WHEN funded.kind='club_treasury'THEN c.club_id ELSE g.payer_user END
 OR l.to_type IS DISTINCT FROM g.destination_kind OR l.to_entity_id IS DISTINCT FROM c.player_id OR l.category IS DISTINCT FROM'rakeback'OR l.status IS DISTINCT FROM'posted'
 OR l.idempotency_key IS DISTINCT FROM'round3-period:own-agent-v1:'||c.period_id||':payer:'||g.payer_kind||':'||g.payer_entity||':destination:'||g.destination_kind
 OR l.metadata?'certificate_kind'OR l.metadata->>'routing_version'IS DISTINCT FROM'3'
 OR l.metadata->>'accounting_scope_kind'IS DISTINCT FROM CASE WHEN c.coordinator_union_id IS NULL THEN'club'ELSE'union'END
 OR l.metadata->>'accounting_scope_id'IS DISTINCT FROM coalesce(c.coordinator_union_id,c.club_id)::text
 OR(l.metadata->>'period_start')::timestamptz IS DISTINCT FROM(c.period_start::timestamp AT TIME ZONE'America/Los_Angeles')
 OR(l.metadata->>'period_end')::timestamptz IS DISTINCT FROM((c.period_end+1)::timestamp AT TIME ZONE'America/Los_Angeles')
 OR l.metadata->>'wallet_transaction_id'IS DISTINCT FROM t.wallet_transaction_id::text
 OR l.metadata->>'paid_from'IS DISTINCT FROM funded.kind
 OR l.metadata->>'payee_role_at_transfer'IS DISTINCT FROM CASE WHEN g.destination_kind='agent_wallet'THEN'agent'ELSE'player'END
 OR l.metadata->>'wallet_destination_version'IS DISTINCT FROM'own-agent-v1'OR l.metadata->>'destination_kind'IS DISTINCT FROM g.destination_kind
 OR l.metadata->>'certificate_id'IS DISTINCT FROM c.id::text OR l.metadata->>'payout_id'IS DISTINCT FROM pp.id::text OR l.metadata->>'period_id'IS DISTINCT FROM c.period_id::text OR l.metadata->>'source_fingerprint'IS DISTINCT FROM c.source_fingerprint
 OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM g.owed OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM g.owed
 OR w.user_id IS DISTINCT FROM c.player_id OR w.type IS DISTINCT FROM'credit'OR w.amount IS DISTINCT FROM g.owed OR w.wallet_type IS DISTINCT FROM CASE WHEN g.destination_kind='agent_wallet'THEN'BUSINESS'ELSE'PLAYER'END
 OR w.category IS DISTINCT FROM'rakeback'OR w.related_entity_id IS DISTINCT FROM pp.id OR w.balance_after IS DISTINCT FROM l.post_to_balance
 OR(SELECT count(*)FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id AND i.status='paid'AND i.chips_transferred AND i.message_sent AND i.net_amount=g.owed AND i.gross_amount=g.owed AND i.deductions=0)<>1));
EXCEPTION WHEN check_violation OR data_exception OR no_data_found THEN RETURN false;
END $complete$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_wallet_payout_complete(uuid,bigint)FROM PUBLIC,anon,authenticated,service_role;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_accounting_tournament_commission_source_guard.sql
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_commission_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE s record;matches int;BEGIN
 IF NEW.source_type='tournament_fee_accrual' THEN
  SELECT f.*,r.recognized_at,r.disposition,b.status accounting_status INTO s FROM public.accounting_effective_tournament_fee_sources f
   JOIN public.accounting_tournament_recognized_sources r ON r.source_id=f.id
   JOIN public.accounting_tournament_fee_recognitions b ON b.tournament_id=r.tournament_id WHERE f.id=NEW.source_id;
  IF NOT FOUND OR s.disposition IS DISTINCT FROM 'earned' OR s.accounting_status IS DISTINCT FROM 'recognized'
   OR NEW.club_id IS DISTINCT FROM s.club_id OR NEW.created_at IS DISTINCT FROM s.recognized_at THEN
   RAISE EXCEPTION 'tournament_commission_recognized_source_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(s.contract->'tiers')t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'tournament_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('tournament_fee','tournament_rake_settlement') THEN
  RAISE EXCEPTION 'tournament_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END$function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_accounting_union_earned_plan_sets.sql
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_sets(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
 SET enable_indexscan TO 'off'
AS $function$
DECLARE
 res record;
BEGIN
 -- THE EARNED PLAN, READ AS SETS (20261003). The same six source proofs,
 -- the same conservation test and the same totals, fingerprint and basis as
 -- fn_accounting_union_earned_plan_v3, computed in one statement that reads
 -- each source row of the window once (v3 reads the week's sources four
 -- times and probes three tables per bank receipt). This function only ever
 -- CERTIFIES: it returns NULL whenever a proof finds anything, a value it
 -- reads cannot be cast, or anything else raises, and the caller then runs
 -- v3, which refuses exactly as it always refused. Where it is stricter than
 -- v3 (a rake record outside the cash-positive set, a NULL check result) it
 -- only sends the book to v3.
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN NULL;
 END IF;
 BEGIN
  EXECUTE $q$
  WITH tw AS MATERIALIZED (
   SELECT t.id,t.created_at,t.amount FROM public.union_wallet_transactions t
    WHERE t.union_id=$1 AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
     AND t.created_at>=$2 AND t.created_at<$3
  ), cw AS MATERIALIZED (
   SELECT c.rake_record_id,c.union_transaction_id,c.banked_at,c.amount,c.club_ledger_id
    FROM public.accounting_cash_bank_receipts c WHERE c.union_id=$1 AND c.banked_at>=$2 AND c.banked_at<$3
  ), fw AS MATERIALIZED (
   SELECT f.tournament_id,f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.status,f.bank_journal_id
    FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=$1 AND f.recognized_at>=$2 AND f.recognized_at<$3
  ), tour_keys AS MATERIALIZED (
   -- The tournament branch of accounting_payable_earning_sources, keyed: its
   -- recognized sources of the window whose recognition is this union's.
   SELECT rs.source_id,rs.tournament_id,rs.recognized_at,rs.rake_credit
    FROM public.accounting_tournament_recognized_sources rs
    JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=rs.tournament_id
    WHERE rs.recognized_at>=$2 AND rs.recognized_at<$3 AND rs.disposition='earned'
     AND r.status='recognized' AND rs.recognized_at=r.recognized_at AND r.union_id=$1
  ), raw AS (
   SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.rake_record_id,NULL::uuid AS tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.contract,'cash'::text AS game_type,NULL::boolean AS terms_match
    FROM public.accounting_effective_cash_rake_sources s WHERE s.union_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3
   UNION ALL
   SELECT 'tournament_fee_accrual'::text,s.id,s.rake_record_id,s.tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,k.recognized_at,s.rake_credit,s.contract,COALESCE(s.game_type,'cash'),
    (public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)=(s.contract->>'terms_at')::timestamptz)
    FROM public.accounting_effective_tournament_fee_sources s
    JOIN tour_keys k ON k.source_id=s.id AND k.tournament_id=s.tournament_id AND k.rake_credit=s.rake_credit
    WHERE s.id=ANY(ARRAY(SELECT source_id FROM tour_keys)) AND s.union_id=$1
  ), detoasted AS (
   -- contract is stored compressed; || '{}' hands back the same object once
   -- decompressed, so the many reads below do not decompress it again.
   SELECT r.*,r.contract||'{}'::jsonb AS cj FROM raw r OFFSET 0
  ), sources AS (
   SELECT s.*,s.cj->'union_agreement' AS agreement,(s.cj->>'terms_at')::timestamptz AS terms_at,
    COALESCE((s.cj->>'is_union_house')::boolean,false) AS is_house
    FROM detoasted s OFFSET 0
  ), checked AS (
   SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,s.agreement->'terms' AS terms,
    COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
     WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
     WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
     s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
    FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
    OFFSET 0
  ), src AS MATERIALIZED (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.club_id,s.earned_at,s.rake_credit,s.game_type,s.rate,s.is_house,
    (s.cj->>'is_union_house')::boolean AS house_flag,
    md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.cj)::text) AS row_md5,
    (s.cj->>'club_id' IS DISTINCT FROM s.club_id::text OR s.cj->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.cj->>'union_id' IS DISTINCT FROM $1::text OR s.coordinator_union_id IS DISTINCT FROM $1
     OR (s.cj->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
     OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
     OR (s.source_type='tournament_fee_accrual' AND s.terms_match IS NOT TRUE)
     OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
       WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=$1 OR c.union_id=$1))))
     OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.terms
       OR s.terms->>'club_id' IS DISTINCT FROM s.club_id::text OR s.terms->>'union_id' IS DISTINCT FROM $1::text
       OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
       OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
        AND h.club_id=s.club_id AND h.entity_key=s.terms->>'id')
       OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
         WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
       OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')))) AS agreement_bad
    FROM checked s
  ), rw AS MATERIALIZED (
   SELECT r.id,r.rake_amount,r.created_at FROM public.rake_records r
    WHERE r.created_at>=$2 AND r.created_at<$3 AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
  ), bw AS MATERIALIZED (
   SELECT b.rake_record_id,b.status,b.earned_at FROM public.accounting_cash_accrual_batches b
    WHERE b.earned_at>=$2 AND b.earned_at<$3
  ), xw AS MATERIALIZED (
   SELECT s.rake_record_id,count(*) AS n,sum(s.rake_credit) AS total,min(s.earned_at) AS min_e,max(s.earned_at) AS max_e
    FROM src s WHERE s.source_type='cash_rake_accrual' GROUP BY s.rake_record_id
  ), counts AS (
   SELECT
    (SELECT count(*) FROM tw t LEFT JOIN cw c ON c.union_transaction_id=t.id LEFT JOIN fw f ON f.union_wallet_transaction_id=t.id
      WHERE (c.rake_record_id IS NULL)=(f.tournament_id IS NULL)
       OR (c.rake_record_id IS NOT NULL AND (c.amount IS DISTINCT FROM t.amount OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions f2 WHERE f2.union_wallet_transaction_id=t.id)))
       OR (f.tournament_id IS NOT NULL AND (f.net_rake IS DISTINCT FROM t.amount OR f.recognized_at IS DISTINCT FROM t.created_at
         OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts c2 WHERE c2.union_transaction_id=t.id)))
       OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity')) AS q1,
    (SELECT count(*) FROM (SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount FROM cw c
        UNION ALL SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake FROM fw f WHERE f.net_rake>0) s
      LEFT JOIN tw t ON t.id=s.bank_id AND t.created_at=s.earned_at AND t.amount IS NOT DISTINCT FROM s.amount
      WHERE t.id IS NULL) AS q2,
    (SELECT count(*) FROM cw c LEFT JOIN rw r ON r.id=c.rake_record_id LEFT JOIN bw b ON b.rake_record_id=c.rake_record_id
       LEFT JOIN xw x ON x.rake_record_id=c.rake_record_id
      WHERE r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
       OR b.rake_record_id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR b.earned_at IS DISTINCT FROM r.created_at
       OR x.n IS NULL OR x.total IS DISTINCT FROM c.amount OR x.min_e IS DISTINCT FROM c.banked_at OR x.max_e IS DISTINCT FROM c.banked_at
       OR (SELECT count(*) FROM public.accounting_effective_cash_rake_sources s2 WHERE s2.rake_record_id=c.rake_record_id)<>x.n) AS q3,
    (SELECT count(*) FROM fw f LEFT JOIN (SELECT s.tournament_id,s.earned_at,count(*) AS n,sum(s.rake_credit) AS total FROM src s
        WHERE s.source_type='tournament_fee_accrual' GROUP BY s.tournament_id,s.earned_at) x
       ON x.tournament_id=f.tournament_id AND x.earned_at=f.recognized_at
      WHERE f.net_rake>0 AND (f.status IS DISTINCT FROM 'recognized' OR x.n IS NULL OR x.total IS DISTINCT FROM f.net_rake)) AS q4,
    (SELECT count(*) FROM src s
       LEFT JOIN cw c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
       LEFT JOIN fw f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
      WHERE (s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.banked_at IS DISTINCT FROM s.earned_at))
       OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.recognized_at IS DISTINCT FROM s.earned_at
         OR f.status IS DISTINCT FROM 'recognized'))
       OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS q5,
    (SELECT count(*) FROM src s WHERE s.agreement_bad IS NOT FALSE) AS q6
  ), basis AS (
   SELECT club_id,game_type,sum(rake_credit) AS rake_in,
    CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
    trunc(sum(rake_credit*rate),2) AS payout FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type
  )
  SELECT k.q1,k.q2,k.q3,k.q4,k.q5,k.q6,
   (SELECT COALESCE(sum(amount),0) FROM tw) AS bank_total,
   (SELECT COALESCE(sum(rake_credit),0) FROM src) AS source_total,
   (SELECT COALESCE(sum(rake_credit) FILTER(WHERE house_flag),0) FROM src) AS house_total,
   (SELECT md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),'')) FROM src) AS fingerprint,
   (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') FROM basis b) AS detail
  FROM counts k
  $q$ INTO res USING p_union_id,p_start,p_end;
 EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
 END;
 IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0
  OR res.bank_total IS NULL OR res.source_total IS DISTINCT FROM res.bank_total THEN
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',res.bank_total,'earned_rake',res.source_total,'house_rake',res.house_total,'source_fingerprint',res.fingerprint,'basis_detail',res.detail);
END
$function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_accounting_union_earned_plan_window.sql
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
 SET enable_indexscan TO 'off'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
 res record;
BEGIN
 -- ONE WINDOW OF THE EARNED PLAN (chunked close, 20261003): the set path
 -- below, derived from fn_accounting_union_earned_plan_sets, over one window
 -- p_start..p_end of a closed week. A passing window returns its raw sums, its
 -- club/game basis sums and every source's row md5 with its id, which
 -- fn_accounting_union_earned_plan_combine adds up into the week's plan.
 -- Anything else returns no row. The set path's own header follows.
 -- THE EARNED PLAN, READ AS SETS (20261003). The same six source proofs,
 -- the same conservation test and the same totals, fingerprint and basis as
 -- fn_accounting_union_earned_plan_v3, computed in one statement that reads
 -- each source row of the window once (v3 reads the week's sources four
 -- times and probes three tables per bank receipt). This function only ever
 -- CERTIFIES: it returns NULL whenever a proof finds anything, a value it
 -- reads cannot be cast, or anything else raises, and the caller then runs
 -- v3, which refuses exactly as it always refused. Where it is stricter than
 -- v3 (a rake record outside the cash-positive set, a NULL check result) it
 -- only sends the book to v3.
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN;
 END IF;
 -- THE WINDOW IS JOINED BY HASH, NEVER BY NESTED LOOP (20261020). The joins
 -- below are equality joins of materialized CTEs, and the newest windows are
 -- read before ANALYZE has seen their rows, so the planner estimates one row
 -- per CTE and rescans one CTE once per row of another: 9,409 bank receipts
 -- x 9,409 accrual groups and 37,172 sources x 9,409 receipts for Midway's
 -- 2026-10-19 15:00 window, 105 s warm for one two-hour window (measured
 -- read-only on production, 2026-10-20). enable_nestloop = off holds every
 -- join to hash or merge: the same rows, 3.0 s. The recognition join of
 -- tour_keys also states the window its equality already implies
 -- (rs.recognized_at = r.recognized_at, rs in [p_start, p_end)), so it reads
 -- the window's recognitions instead of all of them. Same result, row for row.
 BEGIN
  EXECUTE $q$
  WITH tw AS MATERIALIZED (
   SELECT t.id,t.created_at,t.amount FROM public.union_wallet_transactions t
    WHERE t.union_id=$1 AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
     AND t.created_at>=$2 AND t.created_at<$3
  ), cw AS MATERIALIZED (
   SELECT c.rake_record_id,c.union_transaction_id,c.banked_at,c.amount,c.club_ledger_id
    FROM public.accounting_cash_bank_receipts c WHERE c.union_id=$1 AND c.banked_at>=$2 AND c.banked_at<$3
  ), fw AS MATERIALIZED (
   SELECT f.tournament_id,f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.status,f.bank_journal_id
    FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=$1 AND f.recognized_at>=$2 AND f.recognized_at<$3
  ), tour_keys AS MATERIALIZED (
   -- The tournament branch of accounting_payable_earning_sources, keyed: its
   -- recognized sources of the window whose recognition is this union's.
   SELECT rs.source_id,rs.tournament_id,rs.recognized_at,rs.rake_credit
    FROM public.accounting_tournament_recognized_sources rs
    JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=rs.tournament_id
    WHERE rs.recognized_at>=$2 AND rs.recognized_at<$3 AND rs.disposition='earned'
     AND r.status='recognized' AND rs.recognized_at=r.recognized_at AND r.union_id=$1
     AND r.recognized_at>=$2 AND r.recognized_at<$3
  ), raw AS (
   SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.rake_record_id,NULL::uuid AS tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.contract,'cash'::text AS game_type,NULL::boolean AS terms_match
    FROM public.accounting_effective_cash_rake_sources s WHERE s.union_id=$1 AND s.earned_at>=$2 AND s.earned_at<$3
   UNION ALL
   SELECT 'tournament_fee_accrual'::text,s.id,s.rake_record_id,s.tournament_id,s.player_id,s.club_id,
    s.union_id,s.coordinator_union_id,k.recognized_at,s.rake_credit,s.contract,COALESCE(s.game_type,'cash'),
    (public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)=(s.contract->>'terms_at')::timestamptz)
    FROM public.accounting_effective_tournament_fee_sources s
    JOIN tour_keys k ON k.source_id=s.id AND k.tournament_id=s.tournament_id AND k.rake_credit=s.rake_credit
    WHERE s.id=ANY(ARRAY(SELECT source_id FROM tour_keys)) AND s.union_id=$1
  ), detoasted AS (
   -- contract is stored compressed; || '{}' hands back the same object once
   -- decompressed, so the many reads below do not decompress it again.
   SELECT r.*,r.contract||'{}'::jsonb AS cj FROM raw r OFFSET 0
  ), sources AS (
   SELECT s.*,s.cj->'union_agreement' AS agreement,(s.cj->>'terms_at')::timestamptz AS terms_at,
    COALESCE((s.cj->>'is_union_house')::boolean,false) AS is_house
    FROM detoasted s OFFSET 0
  ), checked AS (
   SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,s.agreement->'terms' AS terms,
    COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
     WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
     WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
     s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
    FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
    OFFSET 0
  ), src AS MATERIALIZED (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.club_id,s.earned_at,s.rake_credit,s.game_type,s.rate,s.is_house,
    (s.cj->>'is_union_house')::boolean AS house_flag,
    md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.cj)::text) AS row_md5,
    (s.cj->>'club_id' IS DISTINCT FROM s.club_id::text OR s.cj->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.cj->>'union_id' IS DISTINCT FROM $1::text OR s.coordinator_union_id IS DISTINCT FROM $1
     OR (s.cj->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
     OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
     OR (s.source_type='tournament_fee_accrual' AND s.terms_match IS NOT TRUE)
     OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
       WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=$1 OR c.union_id=$1))))
     OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.terms
       OR s.terms->>'club_id' IS DISTINCT FROM s.club_id::text OR s.terms->>'union_id' IS DISTINCT FROM $1::text
       OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
       OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
        AND h.club_id=s.club_id AND h.entity_key=s.terms->>'id')
       OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
         WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
       OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')))) AS agreement_bad
    FROM checked s
  ), rw AS MATERIALIZED (
   SELECT r.id,r.rake_amount,r.created_at FROM public.rake_records r
    WHERE r.created_at>=$2 AND r.created_at<$3 AND r.rake_amount>0 AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
  ), bw AS MATERIALIZED (
   SELECT b.rake_record_id,b.status,b.earned_at FROM public.accounting_cash_accrual_batches b
    WHERE b.earned_at>=$2 AND b.earned_at<$3
  ), xw AS MATERIALIZED (
   SELECT s.rake_record_id,count(*) AS n,sum(s.rake_credit) AS total,min(s.earned_at) AS min_e,max(s.earned_at) AS max_e
    FROM src s WHERE s.source_type='cash_rake_accrual' GROUP BY s.rake_record_id
  ), source_cardinalities AS MATERIALIZED (
   SELECT s2.rake_record_id,count(*) AS n
    FROM public.accounting_effective_cash_rake_sources s2
    WHERE s2.rake_record_id=ANY(ARRAY(SELECT c0.rake_record_id FROM cw c0))
    GROUP BY s2.rake_record_id
  ), counts AS (
   SELECT
    (SELECT count(*) FROM tw t LEFT JOIN cw c ON c.union_transaction_id=t.id LEFT JOIN fw f ON f.union_wallet_transaction_id=t.id
      WHERE (c.rake_record_id IS NULL)=(f.tournament_id IS NULL)
       OR (c.rake_record_id IS NOT NULL AND (c.amount IS DISTINCT FROM t.amount OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions f2 WHERE f2.union_wallet_transaction_id=t.id)))
       OR (f.tournament_id IS NOT NULL AND (f.net_rake IS DISTINCT FROM t.amount OR f.recognized_at IS DISTINCT FROM t.created_at
         OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM public.accounting_cash_bank_receipts c2 WHERE c2.union_transaction_id=t.id)))
       OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity')) AS q1,
    (SELECT count(*) FROM (SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount FROM cw c
        UNION ALL SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake FROM fw f WHERE f.net_rake>0) s
      LEFT JOIN tw t ON t.id=s.bank_id AND t.created_at=s.earned_at AND t.amount IS NOT DISTINCT FROM s.amount
      WHERE t.id IS NULL) AS q2,
    (SELECT count(*) FROM cw c LEFT JOIN rw r ON r.id=c.rake_record_id LEFT JOIN bw b ON b.rake_record_id=c.rake_record_id
       LEFT JOIN xw x ON x.rake_record_id=c.rake_record_id
       LEFT JOIN source_cardinalities all_sources ON all_sources.rake_record_id=c.rake_record_id
      WHERE r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
       OR b.rake_record_id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR b.earned_at IS DISTINCT FROM r.created_at
       OR x.n IS NULL OR x.total IS DISTINCT FROM c.amount OR x.min_e IS DISTINCT FROM c.banked_at OR x.max_e IS DISTINCT FROM c.banked_at
       OR COALESCE(all_sources.n,0)<>x.n) AS q3,
    (SELECT count(*) FROM fw f LEFT JOIN (SELECT s.tournament_id,s.earned_at,count(*) AS n,sum(s.rake_credit) AS total FROM src s
        WHERE s.source_type='tournament_fee_accrual' GROUP BY s.tournament_id,s.earned_at) x
       ON x.tournament_id=f.tournament_id AND x.earned_at=f.recognized_at
      WHERE f.net_rake>0 AND (f.status IS DISTINCT FROM 'recognized' OR x.n IS NULL OR x.total IS DISTINCT FROM f.net_rake)) AS q4,
    (SELECT count(*) FROM src s
       LEFT JOIN cw c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
       LEFT JOIN fw f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
      WHERE (s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.banked_at IS DISTINCT FROM s.earned_at))
       OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.recognized_at IS DISTINCT FROM s.earned_at
         OR f.status IS DISTINCT FROM 'recognized'))
       OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS q5,
    (SELECT count(*) FROM src s WHERE s.agreement_bad IS NOT FALSE) AS q6
  ), basis AS (
   SELECT club_id,game_type,sum(rake_credit) AS rake_in,
    CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
    trunc(sum(rake_credit*rate),2) AS payout FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type
  )
  SELECT k.q1,k.q2,k.q3,k.q4,k.q5,k.q6,
   (SELECT sum(amount) FROM tw) AS bank_sum,
   (SELECT sum(rake_credit) FROM src) AS source_sum,
   (SELECT sum(rake_credit) FILTER(WHERE house_flag) FROM src) AS house_sum,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',p.club_id,'game_type',p.game_type,'rake_in',p.rake_in,'weighted',p.weighted) ORDER BY p.club_id,p.game_type),'[]')
     FROM (SELECT club_id,game_type,sum(rake_credit) AS rake_in,sum(rake_credit*rate) AS weighted FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type) p) AS basis_part,
   (SELECT count(*) FROM src WHERE source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS other_types,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_md5,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_md5
  FROM counts k
  $q$ INTO res USING p_union_id,p_start,p_end;
 EXCEPTION WHEN OTHERS THEN
  RETURN;
 END;
 -- The week's conservation test (sources = bank) is the combine's: a window
 -- may hold a bank row whose sources are in it and still differ in its sums.
 IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0 OR res.other_types<>0 THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT jsonb_build_object('bank_sum',res.bank_sum,'source_sum',res.source_sum,'house_sum',res.house_sum,'basis',res.basis_part),
  res.cash_ids,res.cash_md5,res.fee_ids,res.fee_md5;
END
$function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_rakeback_split_check.sql
CREATE OR REPLACE FUNCTION public.fn_rakeback_split_check(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- One page of fn_calculate_cash_rakeback_periods' loop, checked and not
-- written (20261003): its plan query for the page's players and every refusal
-- of its loop body, in its order, up to the certified-period test (both built
-- from its text by this migration). The first refusal is returned with its
-- player; otherwise the page's player count, how many already hold a
-- certificate of the same fingerprint, and a digest.
DECLARE
 v_from timestamptz; v_to timestamptz; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
 n integer:=0; n_same integer:=0; dg text:='';
BEGIN
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 BEGIN
 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,
    s.contract AS source_contract,s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,COALESCE(r.member->>'role' IN('super_agent','agent','sub_agent') AND r.direct->>'user_id'=r.player_id::text,false) AS own_play,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL OR COALESCE(r.member->>'role' IN('super_agent','agent','sub_agent') AND r.direct->>'user_id'=r.player_id::text,false) THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent,smarter_private.own_agent_destination_contract(r.source_contract,p_club_id,r.player_id,r.agreement_at) AS destination_agreement
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN COALESCE((p.member->>'player_rakeback_explicit')::boolean,false) OR p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.own_play THEN 0::numeric WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE (e.own_play OR e.member_agent IS NOT NULL) AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM CASE WHEN e.own_play THEN e.player_id::text ELSE e.member_agent::text END OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM CASE WHEN e.own_play THEN e.player_id::text ELSE e.member_agent::text END
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active'
    OR (e.own_play AND (e.direct->>'agent_id' IS DISTINCT FROM e.recorded_agent->>'id' OR COALESCE(e.recorded_agent->>'role','') NOT IN('super_agent','agent','sub_agent') OR e.direct->>'role' IS DISTINCT FROM e.recorded_agent->>'role'
      OR (e.direct->>'rate')::numeric IS DISTINCT FROM CASE WHEN (e.recorded_agent->>'commission_rate')::numeric>1 THEN (e.recorded_agent->>'commission_rate')::numeric/100 ELSE (e.recorded_agent->>'commission_rate')::numeric END
      OR (e.direct->>'rake_basis')::numeric IS DISTINCT FROM e.rake_credit OR (e.direct->>'remaining_basis')::numeric IS DISTINCT FROM e.rake_credit
      OR (e.direct->>'amount')::numeric IS DISTINCT FROM round(e.rake_credit*(e.direct->>'rate')::numeric,2))))) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR ((e.own_play OR e.member_agent IS NOT NULL) AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent)||CASE WHEN e.destination_agreement IS NOT NULL THEN jsonb_build_object('destination_kind','agent_wallet','destination_agreement',e.destination_agreement,'interpretation_version','own-agent-v1')ELSE '{}'::jsonb END ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<1 THEN RAISE EXCEPTION 'historical_rakeback_payer_required' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=CASE WHEN player.payer_count>1 THEN NULL ELSE player.payer_user END;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN player.payer_count>1 THEN 'split' WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
  END IF;
  n:=n+1;
  IF existing.id IS NOT NULL AND certificate.source_fingerprint=plan->>'source_fingerprint' THEN n_same:=n_same+1; END IF;
  dg:=md5(dg||player.player_id::text||':'||fingerprint);
 END LOOP;
 EXCEPTION WHEN SQLSTATE '55000' THEN
  RETURN jsonb_build_object('reason',SQLERRM,'player_id',player.player_id);
 END;
 RETURN jsonb_build_object('players',n,'same',n_same,'digest',dg);
END
$function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_rakeback_split_write.sql
CREATE OR REPLACE FUNCTION public.fn_rakeback_split_write(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- One page of fn_calculate_cash_rakeback_periods' loop (20261003): its plan
-- query for the page's players and its loop body, verbatim (built from its
-- text by this migration). Called only after every page passed
-- fn_rakeback_split_check.
DECLARE
 v_from timestamptz; v_to timestamptz; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
BEGIN
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,
    s.contract AS source_contract,s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,COALESCE(r.member->>'role' IN('super_agent','agent','sub_agent') AND r.direct->>'user_id'=r.player_id::text,false) AS own_play,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL OR COALESCE(r.member->>'role' IN('super_agent','agent','sub_agent') AND r.direct->>'user_id'=r.player_id::text,false) THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent,smarter_private.own_agent_destination_contract(r.source_contract,p_club_id,r.player_id,r.agreement_at) AS destination_agreement
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN COALESCE((p.member->>'player_rakeback_explicit')::boolean,false) OR p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.own_play THEN 0::numeric WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE (e.own_play OR e.member_agent IS NOT NULL) AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM CASE WHEN e.own_play THEN e.player_id::text ELSE e.member_agent::text END OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM CASE WHEN e.own_play THEN e.player_id::text ELSE e.member_agent::text END
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active'
    OR (e.own_play AND (e.direct->>'agent_id' IS DISTINCT FROM e.recorded_agent->>'id' OR COALESCE(e.recorded_agent->>'role','') NOT IN('super_agent','agent','sub_agent') OR e.direct->>'role' IS DISTINCT FROM e.recorded_agent->>'role'
      OR (e.direct->>'rate')::numeric IS DISTINCT FROM CASE WHEN (e.recorded_agent->>'commission_rate')::numeric>1 THEN (e.recorded_agent->>'commission_rate')::numeric/100 ELSE (e.recorded_agent->>'commission_rate')::numeric END
      OR (e.direct->>'rake_basis')::numeric IS DISTINCT FROM e.rake_credit OR (e.direct->>'remaining_basis')::numeric IS DISTINCT FROM e.rake_credit
      OR (e.direct->>'amount')::numeric IS DISTINCT FROM round(e.rake_credit*(e.direct->>'rate')::numeric,2))))) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR ((e.own_play OR e.member_agent IS NOT NULL) AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent)||CASE WHEN e.destination_agreement IS NOT NULL THEN jsonb_build_object('destination_kind','agent_wallet','destination_agreement',e.destination_agreement,'interpretation_version','own-agent-v1')ELSE '{}'::jsonb END ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<1 THEN RAISE EXCEPTION 'historical_rakeback_payer_required' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=CASE WHEN player.payer_count>1 THEN NULL ELSE player.payer_user END;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN player.payer_count>1 THEN 'split' WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN PERFORM smarter_private.ensure_rakeback_payer_contracts(certificate.id); confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN jsonb_build_object('written',written,'confirmed',confirmed);
END
$function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_settle_accounting_commission_stage.sql
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE foreign_legacy_deferred boolean:=false;prior_plan jsonb;prior_node record;prior_saved_context text;scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;agent_skip text;owner_retained numeric:=0;v4_ok boolean:=true;v_comb jsonb;
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
 PERFORM smarter_private.assert_own_agent_scope_interpreted(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
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
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
    AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
   OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
     AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
  THEN
   IF p_scope_kind='club'AND source_count=0 THEN foreign_legacy_deferred:=true;
   ELSE RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000';END IF;
 END IF;
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
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN
   IF p_scope_kind='club'AND source_count=0 THEN foreign_legacy_deferred:=true;
   ELSE RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000';END IF;
 END IF;
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
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1)
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
 -- COMMISSION LANDS IN AGENT WALLETS; THE OWNER'S SHARE STAYS IN THE CLUB BANK
 -- (20261022, Dan). The club owner (clubs.owner_id) is never paid commission
 -- into any personal wallet: the owner's own tier is not moved out of
 -- clubs.chip_treasury at all, and what the recorded hierarchy passes down
 -- through the owner is paid to the child agent straight from the club bank.
 -- Every other payee is credited in agents.agent_wallet_balance, never in
 -- club_members.chip_balance.
 CREATE TEMP TABLE IF NOT EXISTS _routed_owner_nodes(club_id uuid,user_id uuid,own_amount numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_owner_nodes;
 INSERT INTO pg_temp._routed_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payee_user WHERE e.payer_user IS NOT NULL)
 THEN RAISE EXCEPTION 'routed_commission_owner_below_agent' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges_paid(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges_paid;
 INSERT INTO pg_temp._routed_edges_paid(club_id,payer_user,payee_user,amount,role,sort_order)
 SELECT e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user,sum(e.amount),min(e.role),min(e.sort_order)
  FROM pg_temp._routed_edges e LEFT JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payer_user
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes p WHERE p.club_id=e.club_id AND p.user_id=e.payee_user)
  GROUP BY e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role,sort_order)
  SELECT club_id,payer_user,payee_user,amount,role,sort_order FROM pg_temp._routed_edges_paid;
 SELECT COALESCE(sum(own_amount),0) INTO owner_retained FROM pg_temp._routed_owner_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total+owner_retained<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE
   (CASE WHEN EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) THEN 0 ELSE n.own_amount END) IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_owner_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- Only a fully proved empty original plan may reconcile canonical foreign
 -- paid rows. The private validator writes no public state or receipt.
 IF foreign_legacy_deferred THEN
  IF p_scope_kind IS DISTINCT FROM 'club'OR source_count IS DISTINCT FROM 0 OR fingerprint IS DISTINCT FROM md5('')
   OR node_count IS DISTINCT FROM 0 OR own_total IS DISTINCT FROM 0 OR direct_total IS DISTINCT FROM 0 OR downstream_total IS DISTINCT FROM 0 OR owner_retained IS DISTINCT FROM 0
  THEN RAISE EXCEPTION 'zero_standalone_full_original_empty_plan_required' USING ERRCODE='23514';END IF;
  CREATE TEMP TABLE IF NOT EXISTS _routed_zero_standalone_context(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,source_count int,fingerprint text)ON COMMIT DROP;
  TRUNCATE pg_temp._routed_zero_standalone_context;
  INSERT INTO pg_temp._routed_zero_standalone_context VALUES(p_scope_kind,p_scope_id,p_period_start,p_period_end,source_count,fingerprint);
  PERFORM smarter_private.zero_standalone_foreign_commissions_proven(p_scope_id,p_period_start,p_period_end);
  TRUNCATE pg_temp._routed_zero_standalone_context;
 END IF;
 -- Original tiers, entitlement rows, complete hierarchy and full gross
 -- conservation have already been proved. Remove only the subject's own
 -- discharged share, preserving every descendant's genuine pass-through.
 CREATE TEMP TABLE IF NOT EXISTS _routed_prior_discharge_context(stage_round int,period_start timestamptz,period_end timestamptz,club_ids uuid[],source_fingerprint text)ON COMMIT DROP;
 TRUNCATE pg_temp._routed_prior_discharge_context;
 INSERT INTO pg_temp._routed_prior_discharge_context VALUES(2,p_period_start,p_period_end,scope.club_ids,fingerprint);
 PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
  prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_node IN SELECT n.* FROM pg_temp._routed_nodes n JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=n.club_id AND q.beneficiary_id=n.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end
  WHERE 'commission'=ANY(q.roles)AND n.own_amount>0 ORDER BY n.club_id,n.user_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission',prior_node.club_id,prior_node.user_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_commission_instruction_required';END IF;
  UPDATE pg_temp._routed_edges SET amount=amount-(prior_plan->>'amount')::numeric WHERE club_id=prior_node.club_id AND payee_user=prior_node.user_id AND payer_user IS NULL;
  IF NOT FOUND OR EXISTS(SELECT FROM pg_temp._routed_edges WHERE amount<0)THEN RAISE EXCEPTION 'existing_transfer_commission_edge_not_conserved';END IF;
 END LOOP;
 DELETE FROM pg_temp._routed_edges WHERE amount=0;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id)
  AND n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)
  IS DISTINCT FROM COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)-COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'existing_transfer_commission_adjusted_plan_not_conserved';END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing agent wallet (agents row) and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_clubs) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_nodes n ON n.club_id=a.club_id AND n.user_id=a.user_id
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_nodes n SET opening_balance=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=n.club_id AND a.user_id=n.user_id
  AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND (n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','commission',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT agent_wallet_balance INTO payee_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND agent_wallet_balance>=v_edge.amount RETURNING agent_wallet_balance INTO payer_after;
  END IF;
  UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING agent_wallet_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  -- Agent wallets are journalled by the chip_ledger leg and its receipt below,
  -- exactly as every other agent-wallet door; no player-wallet transaction.
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'agent_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'agent_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)FROM pg_temp._routed_nodes n WHERE n.club_id=v_edge.club_id AND n.user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL,'paid_to','agent_wallet'),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n LEFT JOIN public.agents a ON a.club_id=n.club_id AND a.user_id=n.user_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND a.agent_wallet_balance IS DISTINCT FROM n.opening_balance+n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0))
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT a.club_id,a.user_id FROM public.agents a
  JOIN public.profiles dp ON dp.id=a.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_edges e WHERE e.club_id=a.club_id AND e.payee_user=a.user_id AND e.amount>0) ORDER BY a.club_id,a.user_id
 LOOP
  SELECT a.agent_wallet_balance INTO STRICT v_deleted_before FROM public.agents a
   WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'agent_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.agents a WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id
     AND a.agent_wallet_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count-(SELECT count(*)::int FROM pg_temp._routed_owner_nodes),'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'owner_retained_in_club_bank',owner_retained,'paid_to','agent_wallet',
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_settle_accounting_commission_stage_v3.sql
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage_v3(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE foreign_legacy_deferred boolean:=false;prior_plan jsonb;prior_node record;prior_saved_context text;scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;agent_skip text;owner_retained numeric:=0;
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
 PERFORM smarter_private.assert_own_agent_scope_interpreted(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_type text,source_id uuid,club_id uuid,contract jsonb,earned_at timestamptz,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 INSERT INTO pg_temp._routed_sources SELECT source_type,source_id,club_id,contract,earned_at FROM public.accounting_payable_earning_sources
  WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 SELECT count(*),md5(COALESCE(string_agg(md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text),'' ORDER BY source_type,source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN
   IF p_scope_kind='club'AND source_count=0 THEN foreign_legacy_deferred:=true;
   ELSE RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_type,source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_type,v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_type=ac.source_type AND s.source_id=ac.source_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=s.source_type AND t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth))>0;
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
 -- COMMISSION LANDS IN AGENT WALLETS; THE OWNER'S SHARE STAYS IN THE CLUB BANK
 -- (20261022, Dan). The club owner (clubs.owner_id) is never paid commission
 -- into any personal wallet: the owner's own tier is not moved out of
 -- clubs.chip_treasury at all, and what the recorded hierarchy passes down
 -- through the owner is paid to the child agent straight from the club bank.
 -- Every other payee is credited in agents.agent_wallet_balance, never in
 -- club_members.chip_balance.
 CREATE TEMP TABLE IF NOT EXISTS _routed_owner_nodes(club_id uuid,user_id uuid,own_amount numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_owner_nodes;
 INSERT INTO pg_temp._routed_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payee_user WHERE e.payer_user IS NOT NULL)
 THEN RAISE EXCEPTION 'routed_commission_owner_below_agent' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges_paid(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges_paid;
 INSERT INTO pg_temp._routed_edges_paid(club_id,payer_user,payee_user,amount,role,sort_order)
 SELECT e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user,sum(e.amount),min(e.role),min(e.sort_order)
  FROM pg_temp._routed_edges e LEFT JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payer_user
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes p WHERE p.club_id=e.club_id AND p.user_id=e.payee_user)
  GROUP BY e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role,sort_order)
  SELECT club_id,payer_user,payee_user,amount,role,sort_order FROM pg_temp._routed_edges_paid;
 SELECT COALESCE(sum(own_amount),0) INTO owner_retained FROM pg_temp._routed_owner_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total+owner_retained<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE
   (CASE WHEN EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) THEN 0 ELSE n.own_amount END) IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_owner_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- Only a fully proved empty original plan may reconcile canonical foreign
 -- paid rows. The private validator writes no public state or receipt.
 IF foreign_legacy_deferred THEN
  IF p_scope_kind IS DISTINCT FROM 'club'OR source_count IS DISTINCT FROM 0 OR fingerprint IS DISTINCT FROM md5('')
   OR node_count IS DISTINCT FROM 0 OR own_total IS DISTINCT FROM 0 OR direct_total IS DISTINCT FROM 0 OR downstream_total IS DISTINCT FROM 0 OR owner_retained IS DISTINCT FROM 0
  THEN RAISE EXCEPTION 'zero_standalone_full_original_empty_plan_required' USING ERRCODE='23514';END IF;
  CREATE TEMP TABLE IF NOT EXISTS _routed_zero_standalone_context(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,source_count int,fingerprint text)ON COMMIT DROP;
  TRUNCATE pg_temp._routed_zero_standalone_context;
  INSERT INTO pg_temp._routed_zero_standalone_context VALUES(p_scope_kind,p_scope_id,p_period_start,p_period_end,source_count,fingerprint);
  PERFORM smarter_private.zero_standalone_foreign_commissions_proven(p_scope_id,p_period_start,p_period_end);
  TRUNCATE pg_temp._routed_zero_standalone_context;
 END IF;
 -- Original tiers, entitlement rows, complete hierarchy and full gross
 -- conservation have already been proved. Remove only the subject's own
 -- discharged share, preserving every descendant's genuine pass-through.
 CREATE TEMP TABLE IF NOT EXISTS _routed_prior_discharge_context(stage_round int,period_start timestamptz,period_end timestamptz,club_ids uuid[],source_fingerprint text)ON COMMIT DROP;
 TRUNCATE pg_temp._routed_prior_discharge_context;
 INSERT INTO pg_temp._routed_prior_discharge_context VALUES(2,p_period_start,p_period_end,scope.club_ids,fingerprint);
 PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
  prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_node IN SELECT n.* FROM pg_temp._routed_nodes n JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=n.club_id AND q.beneficiary_id=n.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end
  WHERE 'commission'=ANY(q.roles)AND n.own_amount>0 ORDER BY n.club_id,n.user_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission',prior_node.club_id,prior_node.user_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_commission_instruction_required';END IF;
  UPDATE pg_temp._routed_edges SET amount=amount-(prior_plan->>'amount')::numeric WHERE club_id=prior_node.club_id AND payee_user=prior_node.user_id AND payer_user IS NULL;
  IF NOT FOUND OR EXISTS(SELECT FROM pg_temp._routed_edges WHERE amount<0)THEN RAISE EXCEPTION 'existing_transfer_commission_edge_not_conserved';END IF;
 END LOOP;
 DELETE FROM pg_temp._routed_edges WHERE amount=0;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id)
  AND n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)
  IS DISTINCT FROM COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)-COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'existing_transfer_commission_adjusted_plan_not_conserved';END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing agent wallet (agents row) and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_nodes n ON n.club_id=a.club_id AND n.user_id=a.user_id
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_nodes n SET opening_balance=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=n.club_id AND a.user_id=n.user_id
  AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND (n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT agent_wallet_balance INTO payee_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND agent_wallet_balance>=v_edge.amount RETURNING agent_wallet_balance INTO payer_after;
  END IF;
  UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING agent_wallet_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  -- Agent wallets are journalled by the chip_ledger leg and its receipt below,
  -- exactly as every other agent-wallet door; no player-wallet transaction.
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'agent_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'agent_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)FROM pg_temp._routed_nodes n WHERE n.club_id=v_edge.club_id AND n.user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL,'paid_to','agent_wallet'),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n LEFT JOIN public.agents a ON a.club_id=n.club_id AND a.user_id=n.user_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND a.agent_wallet_balance IS DISTINCT FROM n.opening_balance+n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0))
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count-(SELECT count(*)::int FROM pg_temp._routed_owner_nodes),'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'owner_retained_in_club_bank',owner_retained,'paid_to','agent_wallet',
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_settle_accounting_rakeback_stage.sql
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE prior_plan jsonb;prior_item record;prior_saved_context text;legacy_paid_cash_replay boolean:=false;scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;agent_skip text;v4_ok boolean:=false;
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
 PERFORM smarter_private.assert_own_agent_scope_interpreted(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);
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
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  -- The identical certificate tests are read once per close as one set
  -- (fn_standalone_foreign_certificate_periods), never once per period.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND rp.id IN(SELECT foreign_set.period_id FROM public.fn_standalone_foreign_certificate_periods(
      p_scope_kind,standalone_club,from_date,to_date,p_period_start,p_period_end)foreign_set))
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
   OR pc.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR pc.payer_kind NOT IN('agent','club','split')
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
    (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END)::text,rs.contract->>'is_union_house'
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
      OR (pc.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id)) OR (pc.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR NULLIF(rs.agent_text,'')::uuid IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid),false)
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
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  -- The identical certificate tests are read once per close as one set
  -- (fn_standalone_foreign_certificate_periods), never once per period.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND rp.id IN(SELECT foreign_set.period_id FROM public.fn_standalone_foreign_certificate_periods(
      p_scope_kind,standalone_club,from_date,to_date,p_period_start,p_period_end)foreign_set))
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
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club','split')
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
      OR (c.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id)) OR (c.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END) IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid)
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
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN pg_temp._routed_player_items i ON i.period_id=a.obligation_id WHERE a.obligation_role='player'AND NOT smarter_private.existing_rakeback_transfer_complete('player',i.period_id)) OR previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed AND(CASE WHEN EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts wc WHERE wc.calculation_id=i.certificate_id) THEN smarter_private.rakeback_wallet_payout_complete(pp.id,i.certificate_id) WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) ELSE true END)))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 -- CHUNKED CLOSE (20261003, round 3 in batches): inside a chunked close attempt
 -- a period an earlier batch of THIS round paid is recognised by its own
 -- evidence and not paid again; outside one nothing is.
  PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);
 v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_done(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_done;
 IF EXISTS(SELECT FROM pg_temp._routed_player_items i JOIN smarter_private.existing_rakeback_transfer_allocations a ON a.obligation_role='player'AND a.obligation_id=i.period_id WHERE NOT smarter_private.existing_rakeback_transfer_complete('player',i.period_id)) THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
 INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i JOIN smarter_private.existing_rakeback_transfer_allocations a ON a.obligation_role='player'AND a.obligation_id=i.period_id WHERE smarter_private.existing_rakeback_transfer_complete('player',i.period_id);
 IF v_batched THEN
  INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i
   WHERE i.status='paid' AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id)=1
    AND EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.club_id=i.club_id AND pp.user_id=i.user_id
     AND pp.status='paid' AND pp.payout_amount=i.owed
     AND CASE WHEN EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts wc WHERE wc.calculation_id=i.certificate_id) THEN smarter_private.rakeback_wallet_payout_complete(pp.id,i.certificate_id) WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text
       AND l.amount=i.owed AND l.club_id=i.club_id AND l.to_type='player_wallet' AND l.to_entity_id=i.user_id AND l.category='rakeback'
       AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
       AND l.metadata->>'certificate_id'=i.certificate_id::text AND l.metadata->>'payout_id'=pp.id::text
       AND l.metadata->>'source_fingerprint' IS NOT DISTINCT FROM i.fingerprint) ELSE true END) ON CONFLICT DO NOTHING;
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
 -- Discharge only owner-confirmed actual transfers AFTER the original whole
 -- source/certificate/refusal checks and BEFORE new wallet funding is planned.
 prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_item IN SELECT i.* FROM pg_temp._routed_player_todo i JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=i.club_id AND q.beneficiary_id=i.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end WHERE 'player'=ANY(q.roles)
  ORDER BY i.club_id,i.user_id,i.period_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player',prior_item.club_id,prior_item.user_id,prior_item.period_id,prior_item.certificate_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_player_instruction_required';END IF;
  INSERT INTO pg_temp._routed_player_done VALUES(prior_item.period_id)ON CONFLICT DO NOTHING;
  DELETE FROM pg_temp._routed_player_todo WHERE period_id=prior_item.period_id;
  UPDATE pg_temp._routed_player_items SET status='paid'WHERE period_id=prior_item.period_id;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 -- RAKEBACK IS PAID FROM WHERE COMMISSION LANDS (20261022, Dan). A real agent
 -- pays its players from its agent wallet (agents.agent_wallet_balance), where
 -- its weekly commission is credited. A share the certificate records for the
 -- club owner, or for no agent, is paid from the club bank, never from the
 -- owner's wallet. The certificate's payer identity is unchanged.
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_funding(period_id uuid,payer_kind text,payer_user uuid,payer_entity uuid,owed numeric,club_id uuid,funded_from text,destination_kind text,typed_wallet boolean,PRIMARY KEY(period_id,payer_kind,payer_entity,destination_kind)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_funding;
 INSERT INTO pg_temp._routed_player_funding SELECT i.period_id,fp.payer_kind,fp.payer_user,fp.payer_entity,fp.owed,i.club_id,
  CASE WHEN fp.payer_kind='club' OR fp.payer_user IS NULL OR fp.payer_user=owner_club.owner_id THEN 'club_treasury' ELSE 'agent_wallet' END,fp.destination_kind,EXISTS(SELECT FROM public.accounting_rakeback_wallet_contracts wc WHERE wc.calculation_id=i.certificate_id)
 FROM pg_temp._routed_player_todo i JOIN public.clubs owner_club ON owner_club.id=i.club_id
 CROSS JOIN LATERAL smarter_private.rakeback_certificate_wallets(i.certificate_id)fp;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.owed IS DISTINCT FROM(SELECT sum(fp.owed)FROM pg_temp._routed_player_funding fp WHERE fp.period_id=i.period_id))
 THEN RAISE EXCEPTION 'routed_rakeback_payer_funding_not_conserved' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT f.club_id,i.user_id,sum(f.owed) FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_todo i ON i.period_id=f.period_id WHERE f.owed>0 AND f.destination_kind='player_wallet' GROUP BY f.club_id,i.user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_agent_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_agent_wallets;
 INSERT INTO pg_temp._routed_agent_wallets(club_id,user_id,delta)
 SELECT x.club_id,x.user_id,sum(x.delta) FROM(SELECT club_id,payer_user user_id,-owed delta FROM pg_temp._routed_player_funding WHERE funded_from='agent_wallet' UNION ALL SELECT f.club_id,i.user_id,f.owed FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_todo i ON i.period_id=f.period_id WHERE f.destination_kind='agent_wallet')x GROUP BY x.club_id,x.user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_todo) ORDER BY id FOR NO KEY UPDATE;
 FOR r IN SELECT i.* FROM pg_temp._routed_player_todo i WHERE EXISTS(SELECT FROM pg_temp._routed_player_funding f WHERE f.period_id=i.period_id AND f.owed>0 AND f.destination_kind='player_wallet')
  AND NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=i.club_id AND cm.user_id=i.user_id)
  ORDER BY i.club_id,i.user_id,i.period_id LOOP
  PERFORM smarter_private.preserve_historical_rakeback_wallet(r.period_id,r.certificate_id,p_period_start,p_period_end);
 END LOOP;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_agent_wallets w ON w.club_id=a.club_id AND w.user_id=a.user_id
  ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_agent_wallets w SET opening=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=w.club_id AND a.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_agent_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_agent_wallet_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_funding WHERE funded_from='agent_wallet' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_agent_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_funding WHERE funded_from='club_treasury' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','rakeback',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 v_stop:=CASE WHEN v_batched THEN LEAST(clock_timestamp()+interval '90 seconds',NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz) ELSE clock_timestamp()+interval '90 seconds' END;
 FOR r IN SELECT * FROM pg_temp._routed_player_todo ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
   PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3);
   amount:=r.owed;
   INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   FOR g IN SELECT * FROM pg_temp._routed_player_funding WHERE period_id=r.period_id ORDER BY payer_kind,payer_entity,destination_kind LOOP
    amount:=g.owed;
    IF amount=0 THEN CONTINUE; END IF;
   IF g.destination_kind='agent_wallet' THEN
    SELECT agent_wallet_balance INTO player_before FROM public.agents WHERE club_id=r.club_id AND user_id=r.user_id;
   ELSE
    SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   END IF;
   IF g.funded_from='club_treasury' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=r.club_id AND user_id=g.payer_user;
    UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=g.payer_user AND agent_wallet_balance>=amount RETURNING agent_wallet_balance INTO payer_after;
   END IF;
   IF g.destination_kind='agent_wallet' THEN
    UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING agent_wallet_balance INTO player_after;
   ELSE
    UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   END IF;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   -- A debit of an agent wallet or the club bank is journalled by its leg below.
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,CASE WHEN g.destination_kind='agent_wallet' THEN 'BUSINESS' ELSE 'PLAYER' END,'credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   IF NOT g.typed_wallet AND r.payer_kind<>'split' THEN
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   END IF;
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN g.funded_from='club_treasury' THEN 'club_treasury' ELSE 'agent_wallet' END,
     CASE WHEN g.funded_from='club_treasury' THEN r.club_id ELSE g.payer_user END,g.destination_kind,r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     CASE WHEN g.typed_wallet THEN 'round3-period:own-agent-v1:'||r.period_id::text||':payer:'||g.payer_kind||':'||g.payer_entity::text||':destination:'||g.destination_kind ELSE 'round3-period:v3:'||r.period_id::text||CASE WHEN r.payer_kind='split' THEN ':payer:'||g.payer_kind||':'||g.payer_entity::text ELSE '' END END,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer',CASE WHEN g.destination_kind='agent_wallet' THEN 'agent' ELSE 'player' END,
       'paid_from',g.funded_from,'owner_share_payer',CASE WHEN g.payer_kind='agent' AND g.funded_from='club_treasury' THEN g.payer_user END)||CASE WHEN g.typed_wallet THEN jsonb_build_object('wallet_destination_version','own-agent-v1','destination_kind',g.destination_kind) ELSE '{}'::jsonb END,
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   IF g.typed_wallet THEN
    INSERT INTO public.accounting_rakeback_wallet_transfers(payout_id,calculation_id,period_id,payer_kind,payer_entity_id,destination_kind,amount,ledger_id,wallet_transaction_id)
    VALUES(payout_id,r.certificate_id,r.period_id,g.payer_kind,g.payer_entity,g.destination_kind,amount,ledger_id,wallet_id);
   ELSIF r.payer_kind='split' THEN
    INSERT INTO public.accounting_rakeback_payer_transfers(payout_id,calculation_id,period_id,payer_kind,payer_entity_id,amount,ledger_id,wallet_transaction_id)
    VALUES(payout_id,r.certificate_id,r.period_id,g.payer_kind,g.payer_entity,amount,ledger_id,wallet_id);
   END IF;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   END LOOP;
   paid:=paid+r.owed;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
  INSERT INTO pg_temp._routed_player_now VALUES(r.period_id);
  IF v_batched AND clock_timestamp()>v_stop
    AND NOT smarter_private.weekly_payout_owns_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,3) THEN EXIT; END IF;
 END LOOP;
 SELECT count(*) INTO v_remaining FROM pg_temp._routed_player_todo t WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_now n WHERE n.period_id=t.period_id);
 IF v_remaining>0 THEN
  -- A batch: every locked wallet must hold exactly what this batch paid it.
  UPDATE pg_temp._routed_player_wallets w SET delta=COALESCE((SELECT sum(x.delta) FROM(
   SELECT t.club_id,t.user_id,f.owed AS delta FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id JOIN pg_temp._routed_player_funding f ON f.period_id=t.period_id WHERE f.destination_kind='player_wallet'
   ) x
   WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
  UPDATE pg_temp._routed_agent_wallets w SET delta=COALESCE((SELECT sum(x.delta)FROM(SELECT f.club_id,f.payer_user user_id,-f.owed delta FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_now n ON n.period_id=f.period_id WHERE f.funded_from='agent_wallet' UNION ALL SELECT f.club_id,t.user_id,f.owed FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_now n ON n.period_id=f.period_id JOIN pg_temp._routed_player_todo t ON t.period_id=f.period_id WHERE f.destination_kind='agent_wallet')x WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_agent_wallets w LEFT JOIN public.agents a ON a.club_id=w.club_id AND a.user_id=w.user_id
   WHERE a.agent_wallet_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_agent_wallet_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT cm.club_id,cm.user_id FROM public.club_members cm
  JOIN public.profiles dp ON dp.id=cm.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_player_wallets w WHERE w.club_id=cm.club_id AND w.user_id=cm.user_id) AND EXISTS(SELECT FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now done ON done.period_id=t.period_id WHERE t.club_id=cm.club_id AND t.user_id=cm.user_id) ORDER BY cm.club_id,cm.user_id
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
 FOR v_deleted IN
  SELECT a.club_id,a.user_id FROM public.agents a
  JOIN public.profiles dp ON dp.id=a.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_agent_wallets w WHERE w.club_id=a.club_id AND w.user_id=a.user_id)
   AND EXISTS(SELECT FROM pg_temp._routed_player_funding f JOIN pg_temp._routed_player_now done ON done.period_id=f.period_id
    WHERE f.club_id=a.club_id AND ((f.funded_from='agent_wallet' AND f.payer_user=a.user_id) OR(f.destination_kind='agent_wallet' AND EXISTS(SELECT FROM pg_temp._routed_player_todo t WHERE t.period_id=f.period_id AND t.user_id=a.user_id)))) ORDER BY a.club_id,a.user_id
 LOOP
  SELECT a.agent_wallet_balance INTO STRICT v_deleted_before FROM public.agents a
   WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'agent_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.agents a WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id
     AND a.agent_wallet_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric)
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
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'player'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;

-- Maintained owner: supabase/accounting/own-agent-v1/deferred-proof.sql
CREATE OR REPLACE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m        jsonb := COALESCE(NEW.metadata,'{}'::jsonb);
  v_period uuid; v_cert bigint; v_payout uuid;
  v_kind   text; v_scope uuid; v_start timestamptz; v_end timestamptz;
  v_docs   int;
  v_legacy_operation uuid;
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key)='' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' carries no idempotency key';
  END IF;
  IF m->>'routing_version' IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has no routed accounting identity';
  END IF;
  BEGIN
    v_period:=(m->>'period_id')::uuid;   v_cert :=(m->>'certificate_id')::bigint;
    v_payout:=(m->>'payout_id')::uuid;   v_kind :=m->>'accounting_scope_kind';
    v_scope :=(m->>'accounting_scope_id')::uuid;
    v_start :=(m->>'period_start')::timestamptz;
    v_end   :=(m->>'period_end')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has an unreadable routed accounting identity';
  END;
  IF v_period IS NULL OR v_cert IS NULL OR v_payout IS NULL OR v_kind IS NULL
     OR v_scope IS NULL OR v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' is missing part of its period, certificate or payout identity';
  END IF;

  -- The settlement run a disputing player is shown the payment under.
  IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind=v_kind AND r.scope_id=v_scope AND r.period_start=v_start
      AND r.period_end=v_end AND r.round_no=3 AND r.routing_version=3)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
      JOIN public.rakeback_period_payouts pp ON pp.id=v_payout AND pp.rakeback_period_id=c.period_id
      JOIN public.rakeback_periods rp ON rp.id=c.period_id
      WHERE NOT(m ? 'certificate_kind') AND c.id=v_cert AND c.accounting_version=2
       AND c.period_id=v_period AND c.club_id=NEW.club_id AND c.player_id=NEW.to_entity_id
       AND pp.club_id=c.club_id AND pp.user_id=c.player_id AND pp.status='paid' AND pp.payout_amount=c.rakeback_amount
       AND rp.status='paid' AND rp.club_id=c.club_id AND rp.user_id=c.player_id
       AND c.period_start=(v_start AT TIME ZONE 'America/Los_Angeles')::date
       AND c.period_end=(v_end AT TIME ZONE 'America/Los_Angeles')::date-1 AND c.period_end=c.period_start+6
       AND v_end<=now()-interval '5 minutes' AND v_start=public.fn_union_week_start(v_start)
       AND v_end=public.fn_union_week_start(v_start+interval '8 days')
       AND m->>'source_fingerprint'=c.source_fingerprint
       AND((v_kind='union' AND c.coordinator_union_id=v_scope)
         OR(v_kind='club' AND c.coordinator_union_id IS NULL AND c.club_id=v_scope))) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no routed settlement run';
  END IF;

  IF m->>'wallet_destination_version'='own-agent-v1' THEN
    IF m?'certificate_kind'OR NOT smarter_private.rakeback_wallet_payout_complete(v_payout,v_cert)
     OR NOT EXISTS(SELECT FROM public.accounting_rakeback_wallet_transfers t WHERE t.payout_id=v_payout AND t.calculation_id=v_cert AND t.period_id=v_period AND t.ledger_id=NEW.id AND t.amount=NEW.amount AND t.destination_kind=NEW.to_type)
    THEN RAISE EXCEPTION 'typed_rakeback_payout_leg_undocumented' USING ERRCODE='23514';END IF;
    RETURN NULL;
  END IF;
  IF NEW.to_type='agent_wallet' THEN RAISE EXCEPTION 'typed_rakeback_payout_leg_undocumented' USING ERRCODE='23514';END IF;

  IF EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.id=v_cert AND c.payer_kind='split') THEN
    IF NOT smarter_private.split_rakeback_payout_complete(v_payout,v_cert)
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=v_payout AND t.calculation_id=v_cert AND t.period_id=v_period AND t.ledger_id=NEW.id AND t.amount=NEW.amount)
    THEN RAISE EXCEPTION 'split_rakeback_payout_leg_undocumented' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp
    WHERE pp.id=v_payout AND pp.rakeback_period_id=v_period AND pp.club_id=NEW.club_id
      AND pp.user_id=NEW.to_entity_id AND pp.status='paid' AND pp.payout_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching paid rakeback period payout';
  END IF;

  IF m ? 'certificate_kind' THEN
    -- The only other certificate kind is the owner-authorized legacy one. It
    -- must name its operation, and the certificate must be that operation's.
    IF m->>'certificate_kind' IS DISTINCT FROM 'owner_legacy_v1' THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names an unknown certificate kind';
    END IF;
    BEGIN v_legacy_operation:=(m->>'legacy_operation_id')::uuid;
    EXCEPTION WHEN OTHERS THEN v_legacy_operation:=NULL; END;
    IF v_legacy_operation IS NULL OR NOT EXISTS(SELECT 1 FROM public.accounting_legacy_rakeback_certificates c
      JOIN public.accounting_owner_legacy_operations o ON o.operation_id=c.operation_id
      WHERE c.id=v_cert AND c.operation_id=v_legacy_operation AND c.period_id=v_period AND c.club_id=NEW.club_id
        AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount
        AND o.period_start=v_start AND o.period_end=v_end) THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names no matching owner legacy certificate';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
    WHERE c.id=v_cert AND c.period_id=v_period AND c.club_id=NEW.club_id
      AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching rakeback certificate';
  END IF;

  SELECT count(*) INTO v_docs FROM public.settlement_invoices i
   WHERE i.source_ledger_id=NEW.id AND i.status='paid' AND i.chips_transferred
     AND i.gross_amount=NEW.amount AND i.net_amount=NEW.amount;
  IF v_docs<>1 THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has '||v_docs::text||' source-linked paid receipts, expected exactly 1';
  END IF;
  RETURN NULL;
END $function$
;
-- Existing PLAYER trigger remains unchanged. AGENT destination now receives
-- the same deferred full certificate/payment/invoice proof.
CREATE CONSTRAINT TRIGGER zz_ca_own_agent_rakeback_leg_documented
AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN(NEW.status='posted' AND NEW.category='rakeback' AND NEW.to_type='agent_wallet')
EXECUTE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)VALUES('chip_ledger','zz_ca_own_agent_rakeback_leg_documented','Deferred exact typed own-agent certificate, payout, wallet transaction and paid invoice proof; original PLAYER predicate retained.');

-- Maintained owner: supabase/accounting/own-agent-v1/ca_player_stats_financial_report.sql
CREATE OR REPLACE FUNCTION public.ca_player_stats_financial_report(p_user uuid, p_club_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_asset text DEFAULT 'chips'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_days integer; v_tz text; v_from timestamptz; v_to timestamptz;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'unknown stats asset' USING ERRCODE='22023'; END IF;
  IF p_club_id IS NOT NULL THEN PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset); END IF;
  SELECT b.range_days,b.range_tz,b.from_at,b.to_at INTO v_days,v_tz,v_from,v_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
  RETURN (WITH eligible AS MATERIALIZED (
    SELECT DISTINCT c.id FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
    WHERE m.user_id=p_user AND m.status IN ('active','approved')
      AND coalesce(c.lifecycle_status,'active')<>'retired' AND coalesce(c.asset,'chips')=p_asset
      AND (p_club_id IS NULL OR c.id=p_club_id)
  ), tx AS MATERIALIZED (
    SELECT w.id,w.created_at,w.related_entity_id tournament_id,t.club_id,w.type,w.category,
      round(w.amount,2) amount,w.balance_after,w.description
    FROM public.wallet_transactions w JOIN public.tournaments t ON t.id=w.related_entity_id
    JOIN eligible e ON e.id=t.club_id
    WHERE w.user_id=p_user AND p_asset='chips'
      AND lower(w.category) IN ('tournament_buyin','rebuy','addon','refund','tournament_refund',
        'tournament_prize','tournament_winnings','tournament_cashout','bounty','ticket_issue',
        'ticket_redeem','correction','reversal','prize_reversal')
      AND (v_from IS NULL OR w.created_at>=v_from) AND (v_to IS NULL OR w.created_at<v_to)
  ), categories AS (
    SELECT lower(category) category,lower(type) direction,count(*)::integer entries,round(sum(amount),2) amount
    FROM tx GROUP BY 1,2
  ), tournament_totals AS (
    SELECT count(*)::integer journal_rows,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='debit'),0),2) debits,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='credit'),0),2) credits,
      round(coalesce(sum(CASE WHEN lower(type)='credit' THEN amount
        WHEN lower(type)='debit' THEN -amount ELSE 0 END),0),2) net
    FROM tx
  ), periods AS MATERIALIZED (
    SELECT r.id,r.club_id,r.period_start,r.period_end,r.rake_generated,r.rakeback_rate,
      coalesce(r.rakeback_amount,r.rakeback_earned,0) amount,r.status,r.paid_at,
      r.deferred_reason,r.deferred_at,r.defer_count
    FROM public.rakeback_periods r JOIN eligible e ON e.id=r.club_id
    WHERE r.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR r.period_end>=v_from) AND (v_to IS NULL OR r.period_start<v_to)
  ), payouts AS MATERIALIZED (
    SELECT p.id,p.rakeback_period_id,p.club_id,p.payout_amount,p.currency,p.status,p.paid_at,
      p.wallet_transaction_id,p.failure_reason,p.created_at,
      smarter_private.existing_rakeback_transfer_player_receipt(p.rakeback_period_id)AS existing_transfer_discharge,
      CASE WHEN EXISTS(SELECT FROM public.accounting_rakeback_wallet_transfers t WHERE t.payout_id=p.id) THEN
       coalesce((SELECT jsonb_agg(jsonb_build_object('wallet_transaction_id',t.wallet_transaction_id,'amount',t.amount,'destination_kind',t.destination_kind,'wallet_destination_version','own-agent-v1')ORDER BY t.payer_kind,t.payer_entity_id,t.destination_kind)
       FROM public.accounting_rakeback_wallet_transfers t WHERE t.payout_id=p.id AND t.period_id=p.rakeback_period_id),'[]'::jsonb)
      ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('wallet_transaction_id',t.wallet_transaction_id,'amount',t.amount)ORDER BY t.payer_kind,t.payer_entity_id)
       FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=p.id AND t.period_id=p.rakeback_period_id),'[]'::jsonb) END AS wallet_transactions
    FROM public.rakeback_period_payouts p JOIN eligible e ON e.id=p.club_id
    WHERE p.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR coalesce(p.paid_at,p.created_at)>=v_from)
      AND (v_to IS NULL OR coalesce(p.paid_at,p.created_at)<v_to)
  ) SELECT jsonb_build_object('contract_version',2,'scope',jsonb_build_object(
      'target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,'range_days',v_days,
      'range_tz',v_tz,'visibility','owner'),'generated_at',now(),
    'availability',jsonb_build_object(
      'tournament_wallet',p_asset='chips','rakeback',p_asset='chips',
      'bankroll_ledger',false,'bankroll_reason','no_club_scoped_authoritative_player_balance_series',
      'cash_sessions',false,'cash_sessions_reason','session_identity_has_no_final_stack_or_hand_foreign_key'),
    'tournament_wallet',jsonb_build_object('source','wallet_transactions',
      'totals',(SELECT to_jsonb(tournament_totals) FROM tournament_totals),
      'categories',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY category,direction) FROM categories c),'[]'::jsonb),
      'entries',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY created_at DESC,id DESC) FROM
        (SELECT * FROM tx ORDER BY created_at DESC,id DESC LIMIT 250) x),'[]'::jsonb),
      'capped',(SELECT count(*)>250 FROM tx)),
    'rakeback',jsonb_build_object('source','rakeback_periods+rakeback_period_payouts',
      'pending_amount',coalesce((SELECT round(sum(amount),2) FROM periods WHERE status='pending'),0),
      'paid_amount',coalesce((SELECT round(sum(payout_amount),2) FROM payouts WHERE status='paid'),0),
      'periods',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY period_end DESC,id DESC) FROM periods p),'[]'::jsonb),
      'payout_receipts',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY coalesce(paid_at,created_at) DESC,id DESC) FROM payouts p),'[]'::jsonb)),
    'bankroll',jsonb_build_object('available',false,'series','[]'::jsonb),
    'cash_sessions',jsonb_build_object('available',false,'sessions','[]'::jsonb)));
END;$function$;

-- Maintained owner: supabase/accounting/own-agent-v1/fn_ca_settlement_correctness_check.sql
CREATE OR REPLACE FUNCTION public.fn_ca_settlement_correctness_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0;
BEGIN
  -- B. Cross-club direct postings (last 60 min)
  FOR r IN
    SELECT l.id, l.from_type, l.from_entity_id, l.to_type, l.to_entity_id, l.amount, l.category
    FROM public.chip_ledger l
    WHERE l.created_at > now() - interval '60 minutes'
      AND l.from_type IN ('club_treasury','club_wallet')
      AND l.to_type   IN ('club_treasury','club_wallet')
      AND l.from_entity_id IS DISTINCT FROM l.to_entity_id
      AND l.category NOT IN ('treasury_transfer','pnl_settlement','horse_funding','correction')
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:cross_club', 'cross_club_posting', 'warning',
      'cross-club:' || COALESCE(r.from_entity_id::text,'?') || ':' || COALESCE(r.to_entity_id::text,'?'),
      r.amount, NULL, NULL, 'ledger', 'chip_ledger', NULL,
      r.from_entity_id, NULL, NULL, NULL, NULL, NULL, NULL, ARRAY[r.id],
      'chips moved directly between two different clubs (' || r.category || ', '
        || r.from_type || '→' || r.to_type || ') outside the allowed cross-club categories',
      NULL, jsonb_build_object('ledger_row', r.id, 'category', r.category));
    n := n + 1;
  END LOOP;

  -- C1. Rakeback over-attribution (last 24 h)
  FOR r IN
    WITH attributed AS MATERIALIZED (
      SELECT rr.id AS record_id, rr.club_id, rr.rake_amount, round(sum(ra.rake_amount),2) AS attributed
      FROM public.rake_records rr
      JOIN public.rake_attributions ra ON ra.rake_record_id = rr.id
      WHERE rr.created_at > now() - interval '24 hours'
      GROUP BY rr.id, rr.club_id, rr.rake_amount
      HAVING round(sum(ra.rake_amount),2) > round(rr.rake_amount,2) + 0.01
    )
    SELECT * FROM attributed LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'warning',
      'rakeback-overattr:' || r.record_id::text,
      round(r.attributed - r.rake_amount, 2), r.rake_amount, r.attributed,
      'reporting', 'rake_attributions', r.record_id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rake attributions exceed the rake actually collected for this record - the rakeback chain would over-accrue',
      NULL, jsonb_build_object('rake_record_id', r.record_id));
    n := n + 1;
  END LOOP;

  -- C2. Rakeback over-payout (paid more than the player contributed, last 7 d)
  FOR r IN
    SELECT p.id, p.club_id, p.user_id, p.payout_amount, p.user_rake_contribution
    FROM public.rakeback_period_payouts p
    WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days'
      AND p.payout_amount > COALESCE(p.user_rake_contribution, 0) + 0.01
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'critical',
      'rakeback-overpay:' || r.id::text,
      round(r.payout_amount - COALESCE(r.user_rake_contribution,0), 2),
      r.user_rake_contribution, r.payout_amount,
      'settlement', 'rakeback_period_payouts', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a rakeback payout exceeds the player''s ENTIRE rake contribution - impossible under any percentage',
      NULL, jsonb_build_object('payout_id', r.id, 'user_id', r.user_id));
    n := n + 1;
  END LOOP;

  -- C3. Rakeback dual-write evidence gaps (last 7 d)
  /* A ZERO PAYOUT HAS NO MONEY SIDE TO POINT AT (2026-10-03). The routed
     and legacy rakeback stages write one 'paid' payout row per certified
     period, including a period whose rakeback rounds to 0.00 (0.08 of rake
     at 5% is 0.004), and move chips only when the amount is above zero. A
     0.00 row therefore never has a wallet transaction, and asking it for one
     filed a permanent evidence warning (period payout e7f0b9bc, 2026-10-02).
     Only a payout or transfer that moved chips owes an evidence pointer. */
  FOR r IN
    SELECT 'period_payout' AS src, p.id, p.club_id FROM public.rakeback_period_payouts p
     WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days' AND p.wallet_transaction_id IS NULL
       AND p.payout_amount > 0
       AND NOT EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='player'AND a.obligation_id=p.rakeback_period_id AND smarter_private.existing_rakeback_transfer_complete('player',p.rakeback_period_id))
       AND NOT EXISTS(SELECT 1 FROM(SELECT c.id,c.payer_kind FROM public.accounting_rakeback_period_calculations c
        WHERE c.period_id=p.rakeback_period_id ORDER BY c.id DESC LIMIT 1)cert
        WHERE ((cert.payer_kind='split' AND smarter_private.split_rakeback_payout_complete(p.id,cert.id)) OR smarter_private.rakeback_wallet_payout_complete(p.id,cert.id)))
    UNION ALL
    SELECT 'distribution', d.id, d.club_id FROM public.rakeback_distributions d
     WHERE d.status IN ('transferred','paid') AND d.transferred_at > now() - interval '7 days'
       AND d.chip_transfer_id IS NULL
       AND d.rakeback_amount > 0
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'reporting_mismatch', 'warning',
      'rakeback-evidence:' || r.src || ':' || r.id::text,
      0, NULL, NULL, 'reporting', 'rakeback_' || r.src, r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rakeback marked paid/transferred with no linked wallet/chip transaction - the money side has no evidence pointer',
      NULL, jsonb_build_object('kind', r.src, 'row_id', r.id));
    n := n + 1;
  END LOOP;

  -- D. Ticket conservation
  FOR r IN
    SELECT t.id, t.club_id, t.status, t.value,
           CASE WHEN t.status='redeemed' AND t.redeemed_at IS NULL THEN 'redeemed_without_timestamp'
                WHEN t.status='cancelled' AND t.cancelled_at IS NULL THEN 'cancelled_without_timestamp'
                WHEN t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0 THEN 'active_nonpositive_value'
           END AS why
    FROM public.tournament_tickets t
    WHERE (t.status='redeemed' AND t.redeemed_at IS NULL)
       OR (t.status='cancelled' AND t.cancelled_at IS NULL)
       OR (t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:tickets', 'reporting_mismatch', 'warning',
      'ticket:' || r.id::text,
      COALESCE(r.value,0), NULL, NULL, 'reporting', 'tournament_tickets', r.id, r.club_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'ticket conservation violation: ' || r.why,
      NULL, jsonb_build_object('ticket_id', r.id, 'status', r.status, 'why', r.why));
    n := n + 1;
  END LOOP;

  -- E. Insurance pair-match (net must equal payout − premium; last 24 h)
  FOR r IN
    SELECT i.id, i.club_id, i.union_id, i.premium, i.payout, i.net_result
    FROM public.insurance_transactions i
    WHERE i.created_at > now() - interval '24 hours'
      AND round(COALESCE(i.payout,0) - COALESCE(i.premium,0), 2) <> round(COALESCE(i.net_result,0), 2)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:insurance', 'reporting_mismatch', 'warning',
      'insurance-pair:' || r.id::text,
      round((COALESCE(r.payout,0) - COALESCE(r.premium,0)) - COALESCE(r.net_result,0), 2),
      round(COALESCE(r.payout,0) - COALESCE(r.premium,0), 2), r.net_result,
      'reporting', 'insurance_transactions', r.id, r.club_id, r.union_id,
      NULL, NULL, NULL, NULL, NULL, NULL,
      'insurance row does not pair: net_result must equal payout minus premium exactly',
      NULL, jsonb_build_object('insurance_id', r.id));
    n := n + 1;
  END LOOP;

  -- F. Ticket VALUE conservation (phase 2b): every redeemed/cancelled
  -- ticket must have exactly one credit receipt of exactly its value.
  FOR r IN
    SELECT t.id, t.club_id, t.value, t.status,
           (SELECT count(*) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipts,
           (SELECT COALESCE(sum(ct.amount),0) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipt_value
    FROM public.tournament_tickets t
    WHERE t.status IN ('redeemed','cancelled')
      AND COALESCE(t.redeemed_at, t.cancelled_at) > now() - interval '24 hours'
    LIMIT 50
  LOOP
    IF r.receipts <> 1 OR round(r.receipt_value,2) <> round(r.value,2) THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:ticket_value', 'reporting_mismatch', 'warning',
        'ticket-value:' || r.id::text,
        round(r.receipt_value - r.value, 2), r.value, r.receipt_value,
        'settlement', 'tournament_tickets', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'ticket value conservation broken: ' || r.status || ' ticket worth ' || r.value
          || ' has ' || r.receipts || ' receipt(s) totalling ' || r.receipt_value,
        NULL, jsonb_build_object('ticket_id', r.id));
      n := n + 1;
    END IF;
  END LOOP;

  -- G. All-player atomic coverage: both windows count the same hand identities.
  -- The common commit receipt covers ordinary and diamond hands. The existing
  -- claims metadata keys remain compatible, and now mean matched receipts.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    /* THE HOUR FIRST, THE DAY ONLY WHEN THE HOUR ACCUSES (2026-10-03).
       An incident needs BOTH the 24-hour adoption gate and the 1-hour
       shortfall. Reading the day first materialised ~885,000 hands and as
       many receipts every hour and was cancelled in 3 of 6 runs. The hour is
       read alone (the same hands: created_at > now() - 60 min is inside the
       24 h set, and a receipt that matches a hand's hand_number is inside the
       set's hand_number range by construction; hand_atomic_commits.hand_id is
       unique, so the join cannot duplicate). The day is read, exactly as
       before, only when the hour would fire; otherwise its counts stay NULL
       and the gate below is false, which is the verdict the hour already
       gave. Measured: 17.3 s for the hour on production. */
    SELECT count(*), count(c.hand_id)
      INTO v_hands_1h, v_claims_1h
      FROM public.hand_history h
      LEFT JOIN public.hand_atomic_commits c
        ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
     WHERE h.created_at>now()-interval '60 minutes';
    IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
      WITH recent AS MATERIALIZED (
        SELECT id,table_id,hand_number,created_at
        FROM public.hand_history WHERE created_at>now()-interval '24 hours'
      ), receipts AS MATERIALIZED (
        SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
        WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                              AND (SELECT max(hand_number) FROM recent)
      )
      SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h
      INTO v_hands_24h,v_claims_24h
      FROM recent h LEFT JOIN receipts c
       ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number;
    END IF;
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'hand_atomic_commits',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - matching atomic hand receipts are missing',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  --  H. THE SETTLER'S WATERMARK IS THE UNION CASCADE'S GATE (2026-09-21)
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- fn_process_weekly_accounting_scope raises
  -- `weekly_rake_source_not_fully_accrued` when any cash rake record inside
  -- the week being settled still sits above
  -- daemon_state.rakeback_settler.high_water_mark. That refusal is correct and
  -- must stay - settling a week on a source that is not fully accrued posts an
  -- understated week. What was missing is that the CONDITION causing it was
  -- invisible.
  --
  -- Measured 2026-09-21T15:26:06Z: the watermark was 2026-09-21T14:34:09Z, 52
  -- minutes stale, with 985 rake_records above it, while
  -- engine.smarter.poker/health reported settlementStatus "ok" and
  -- blockedSettlementCount 0, and fn_settler_lag_check - which nothing in the
  -- codebase or the cron schedule ever called - returned healthy:true.
  --
  -- No new job, timer, watcher or repair loop: this hourly settlement
  -- correctness check already runs and already raises durable, deduped,
  -- escalatable incidents. It now also asks the settler probe, and the probe
  -- now knows what the settler's interval is and what the cascade needs.
  DECLARE
    v_settler jsonb;
    v_blocked boolean;
  BEGIN
    v_settler := public.fn_settler_lag_check();
    IF COALESCE((v_settler->>'healthy')::boolean, true) IS NOT TRUE THEN
      v_blocked := COALESCE((v_settler->>'week_settlement_blocked')::boolean, false);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:settler_lag', 'settlement_error',
        CASE WHEN v_blocked THEN 'critical' ELSE 'warning' END,
        'settler-lag:' || CASE WHEN v_blocked THEN 'blocking:' ELSE 'stalled:' END
          || to_char(now(), 'YYYY-MM-DD-HH24'),
        0, NULL, NULLIF(v_settler->>'backlog_rows','')::numeric,
        'settlement', 'daemon_state', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        CASE WHEN v_blocked THEN
          'the union weekly cascade WILL refuse this week: '
            || COALESCE(v_settler->>'week_unaccrued_rows','?')
            || ' cash rake record(s) inside the week now due to settle are still above the'
            || ' rakeback settler watermark (' || COALESCE(v_settler->>'cursor','?')
            || '). fn_process_weekly_accounting_scope raises'
            || ' weekly_rake_source_not_fully_accrued on exactly this state and settles nothing.'
        ELSE
          'the rakeback settler watermark has not advanced for '
            || COALESCE(v_settler->>'last_save_minutes_ago','?') || ' minute(s) while '
            || COALESCE(v_settler->>'backlog_rows','?') || ' rake record(s) wait above it.'
            || ' The settler interval is ' || COALESCE(v_settler->>'interval_minutes','?')
            || ' minutes, so the drain has skipped a cycle - and a watermark left behind the'
            || ' week end blocks the whole union settlement cascade.'
        END,
        NULL, v_settler);
      n := n + 1;
    END IF;
  END;

  RETURN n;
END $function$;

-- Maintained owner: supabase/accounting/own-agent-v1/weekly_payout_prepare_due.sql
CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_prepare_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE n timestamptz:=smarter_private.weekly_payout_clock();e timestamptz:=public.fn_union_week_start(n);
 due timestamptz:=public.fn_union_accounting_run_at(e);cutover timestamptz;plan jsonb;item jsonb;preparation jsonb;
 problems jsonb:='[]'::jsonb;had_windows boolean;began timestamptz:=clock_timestamp();work_deadline timestamptz;saved_preparation_deadline text;r public.weekly_accounting_payout_pauses%ROWTYPE;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 SELECT cutover_period_end INTO STRICT cutover FROM smarter_private.weekly_payout_phase_configuration WHERE singleton;
 IF e<cutover OR n<e OR n>=due THEN RETURN NULL;END IF;
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('statement_timeout')::interval IS DISTINCT FROM interval '240 seconds'
 THEN RAISE EXCEPTION 'weekly_payout_original_bounded_tick_required' USING ERRCODE='55000';END IF;
 plan:=smarter_private.weekly_payout_scope_plan(e,n);
 IF jsonb_array_length(plan)=0 THEN RETURN NULL;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(plan) LOOP
  IF clock_timestamp()-began>interval '30 seconds' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('reason','preparation_budget','scope',item));EXIT;
  END IF;
  PERFORM public.fn_weekly_accounting_attempt_begin(item->>'kind'='union');
  BEGIN
   -- Continue only this original R0 transition while its immutable source
   -- reviews prove positive progress. No other failure/result is retried.
   work_deadline:=LEAST(began+interval '30 seconds',NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz,due);
   saved_preparation_deadline:=current_setting('app.weekly_accounting_preparation_deadline',true);
   PERFORM set_config('app.weekly_accounting_preparation_deadline',work_deadline::text,true);
   LOOP
   preparation:=public.fn_prepare_accounting_week(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
    CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
    EXIT WHEN NOT(coalesce(jsonb_array_length(preparation->'problems'),0)=1
      AND preparation#>>'{problems,0,reason}'='own_agent_source_interpretation_in_progress'
      AND coalesce((preparation#>>'{problems,0,source_check,reviewed}')::int,0)>0);
    EXIT WHEN preparation#>>'{problems,0,source_check,budget_exhausted}'='true'OR clock_timestamp()>=work_deadline;
   END LOOP;
   PERFORM set_config('app.weekly_accounting_preparation_deadline',coalesce(saved_preparation_deadline,''),true);
   had_windows:=false;
   IF preparation->>'success'='true' THEN
    had_windows:=public.fn_accounting_close_windows_pending(CASE WHEN item->>'kind'='union' THEN (item->>'id')::uuid END,
     CASE WHEN item->>'kind'='club' THEN (item->>'id')::uuid END,(item->>'period_start')::timestamptz,(item->>'period_end')::timestamptz);
   END IF;
   IF preparation->>'success' IS DISTINCT FROM 'true' OR had_windows THEN
    problems:=problems||jsonb_build_array(jsonb_build_object('scope',item,'preparation',preparation,'windows_pending',had_windows));
   END IF;
  EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('app.weekly_accounting_preparation_deadline',coalesce(saved_preparation_deadline,''),true);
   problems:=problems||jsonb_build_array(jsonb_build_object('scope',item,'error',SQLERRM,'sqlstate',SQLSTATE));
  END;
  PERFORM public.fn_weekly_accounting_attempt_end();
 END LOOP;
 IF jsonb_array_length(problems)>0 THEN
  RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_preparing','problems',problems);
 END IF;
 INSERT INTO public.weekly_accounting_payout_pauses(period_start,period_end,announced_at,money_starts_at,money_deadline_at,expires_at,scope_plan)
 VALUES(public.fn_union_prev_week_start(e),e,due-interval '2 minutes',due,due+interval '240 seconds',due+interval '5 minutes',plan)
 ON CONFLICT(period_start,period_end)DO NOTHING;
 SELECT * INTO STRICT r FROM public.weekly_accounting_payout_pauses p WHERE p.period_end=e;
 IF r.scope_plan IS DISTINCT FROM plan THEN RAISE EXCEPTION 'weekly_payout_prepared_scope_changed' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('success',false,'owns_tick',true,'advanced',true,'stage','weekly_payout_prepared','run_id',r.run_id);
END $function$;

-- Exact deltas to the complete maintained owners; original runtime locks remain unchanged.
DO $original_owners$ DECLARE r record;x jsonb;d text;BEGIN FOR r IN SELECT*FROM jsonb_to_recordset($deltas$[{"signature":"fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])","preimage":"4a835bd96653c977e5519f6dcfd7a7c6","replacements":[{"old":"  WITH receipts AS (\n   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,\n    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,\n    s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,\n    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,\n    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake\n   FROM public.accounting_payable_earning_sources s\n","new":"  WITH receipts AS (\n   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,\n    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,\n    s.contract AS source_contract,s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,\n    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,\n    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake\n   FROM public.accounting_payable_earning_sources s\n"},{"old":"   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to\n     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))\n  ), parsed AS (\n   SELECT r.*,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid\n     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,\n    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,\n    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL\n      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,\n    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,\n    mh.id AS member_history_id,ah.id AS agent_history_id,\n    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent\n   FROM receipts r\n   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref\n    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at\n","new":"   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to\n     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))\n  ), parsed AS (\n   SELECT r.*,COALESCE(r.member->>'role' IN('super_agent','agent','sub_agent') AND r.direct->>'user_id'=r.player_id::text,false) AS own_play,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid\n     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,\n    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,\n    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL\n      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,\n    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL OR COALESCE(r.member->>'role' IN('super_agent','agent','sub_agent') AND r.direct->>'user_id'=r.player_id::text,false) THEN (r.direct->>'rate')::numeric END AS cap_rate,\n    mh.id AS member_history_id,ah.id AS agent_history_id,\n    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent,smarter_private.own_agent_destination_contract(r.source_contract,p_club_id,r.player_id,r.agreement_at) AS destination_agreement\n   FROM receipts r\n   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref\n    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at\n"},{"old":"    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate\n   FROM parsed p\n  ), effective AS (\n   SELECT r.*,CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate\n   FROM rates r\n  )\n  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,\n   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member\n    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text\n    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,\n   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL\n    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent\n    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'\n    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text\n    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,\n   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')\n    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1\n    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,\n   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,\n   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,\n   min(e.member_agent::text)::uuid AS payer_user,\n","new":"    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate\n   FROM parsed p\n  ), effective AS (\n   SELECT r.*,CASE WHEN r.own_play THEN 0::numeric WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate\n   FROM rates r\n  )\n  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,\n   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member\n    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text\n    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,\n   count(*) FILTER(WHERE (e.own_play OR e.member_agent IS NOT NULL) AND (e.direct IS NULL OR e.agent_history_id IS NULL\n    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent\n    OR e.direct->>'user_id' IS DISTINCT FROM CASE WHEN e.own_play THEN e.player_id::text ELSE e.member_agent::text END OR e.direct->>'depth' IS DISTINCT FROM '1'\n    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM CASE WHEN e.own_play THEN e.player_id::text ELSE e.member_agent::text END\n    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active'\n    OR (e.own_play AND (e.direct->>'agent_id' IS DISTINCT FROM e.recorded_agent->>'id' OR COALESCE(e.recorded_agent->>'role','') NOT IN('super_agent','agent','sub_agent') OR e.direct->>'role' IS DISTINCT FROM e.recorded_agent->>'role'\n      OR (e.direct->>'rate')::numeric IS DISTINCT FROM CASE WHEN (e.recorded_agent->>'commission_rate')::numeric>1 THEN (e.recorded_agent->>'commission_rate')::numeric/100 ELSE (e.recorded_agent->>'commission_rate')::numeric END\n      OR (e.direct->>'rake_basis')::numeric IS DISTINCT FROM e.rake_credit OR (e.direct->>'remaining_basis')::numeric IS DISTINCT FROM e.rake_credit\n      OR (e.direct->>'amount')::numeric IS DISTINCT FROM round(e.rake_credit*(e.direct->>'rate')::numeric,2))))) AS invalid_agents,\n   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')\n    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1\n    OR ((e.own_play OR e.member_agent IS NOT NULL) AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,\n   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,\n   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,\n   min(e.member_agent::text)::uuid AS payer_user,\n"},{"old":"    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,\n    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,\n    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,\n    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations\n  FROM effective e GROUP BY e.player_id ORDER BY e.player_id\n LOOP\n  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;\n","new":"    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,\n    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,\n    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,\n    'payer_user_id',e.member_agent)||CASE WHEN e.destination_agreement IS NOT NULL THEN jsonb_build_object('destination_kind','agent_wallet','destination_agreement',e.destination_agreement,'interpretation_version','own-agent-v1')ELSE '{}'::jsonb END ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations\n  FROM effective e GROUP BY e.player_id ORDER BY e.player_id\n LOOP\n  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;\n"}]},{"signature":"fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)","preimage":"62c444b0953cced8a4f3144fc86af51b","replacements":[{"old":"   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,\n   'problems',jsonb_build_array(jsonb_build_object('reason','cash_source_refusals_pending',\n    'source_check',source_check)));\n END IF;\n -- Rakeback is due before club-book settlement (owner, 2026-10-26).\n -- Keep the closed book, source queue, recorded contracts and calculation\n","new":"   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,\n   'problems',jsonb_build_array(jsonb_build_object('reason','cash_source_refusals_pending',\n    'source_check',source_check)));\n END IF;\n -- The original R0 transition qualifies historical interpretation before any\n -- source-plan reuse or payer stage. Each bounded batch commits no money.\n source_check:=smarter_private.prepare_own_agent_interpretation(p_union_id,p_club_id,p_from,p_to);\n IF source_check->>'ready'IS DISTINCT FROM'true'THEN\n  RETURN jsonb_build_object('success',false,'accounting_version',3,'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,'problems',jsonb_build_array(jsonb_build_object('reason','own_agent_source_interpretation_in_progress','source_check',source_check)));\n END IF;\n -- Rakeback is due before club-book settlement (owner, 2026-10-26).\n -- Keep the closed book, source queue, recorded contracts and calculation\n"}]}]$deltas$::jsonb)AS p(signature text,preimage text,replacements jsonb)LOOP d:=pg_get_functiondef(to_regprocedure(r.signature));IF md5(d)IS DISTINCT FROM r.preimage THEN RAISE EXCEPTION 'own_agent_original_delta_preimage_changed:%',r.signature;END IF;FOR x IN SELECT value FROM jsonb_array_elements(r.replacements)LOOP IF(length(d)-length(replace(d,x->>'old','')))/length(x->>'old')<>1 THEN RAISE EXCEPTION 'own_agent_original_delta_not_exact:%',r.signature;END IF;d:=replace(d,x->>'old',x->>'new');END LOOP;EXECUTE d;END LOOP;END $original_owners$;
REVOKE ALL ON FUNCTION public.ca_player_stats_financial_report(uuid,uuid,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_financial_report(uuid,uuid,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_financial_report(uuid,uuid,integer,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_commission_source_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_rakeback_payout_leg_is_documented() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_settlement_correctness_check() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_settlement_correctness_check() FROM service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_correctness_check() TO service_role;
REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_rakeback_split_check(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_split_check(uuid,date,date,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_rakeback_split_write(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_split_write(uuid,date,date,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_prepare_due() FROM PUBLIC,anon,authenticated,service_role;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check','migration 20261028184531 own-agent typed wallet receipts');
DO $post$
DECLARE r record;
BEGIN
 FOR r IN SELECT*FROM jsonb_to_recordset($postimages$[{"signature":"smarter_private.admit_own_agent_source(text,uuid)","md5":"dbac86129f9285e95a50408959f50c9f"},{"signature":"smarter_private.assert_own_agent_scope_interpreted(text,uuid,timestamp with time zone,timestamp with time zone,integer)","md5":"e1fb96151324d44215c10047f7604ddd"},{"signature":"ca_player_stats_financial_report(uuid,uuid,integer,text,text)","md5":"30452e1de3d5c3a5bb0d63b4c803b3db"},{"signature":"fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)","md5":"62bd1db4a493c3f86ca90f32eaca456a"},{"signature":"fn_accounting_tournament_commission_source_guard()","md5":"a27f5faacd2c469df32f4b5e9692113c"},{"signature":"fn_accounting_union_earned_plan_sets(uuid,timestamp with time zone,timestamp with time zone)","md5":"dce90bd407404e6bf8e135874b7b9209"},{"signature":"fn_accounting_union_earned_plan_window(uuid,timestamp with time zone,timestamp with time zone)","md5":"737ffac96388517d170c9962174f0222"},{"signature":"fn_ca_rakeback_payout_leg_is_documented()","md5":"27b613b98de1d922d0ee65e9259c0cea"},{"signature":"fn_ca_settlement_correctness_check()","md5":"295c3580a4f411fe18b33a3c8486b0e6"},{"signature":"fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])","md5":"ced29c928d73b73be75d9e94604a2f7a"},{"signature":"fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)","md5":"9960208f5b5398132a8e702497bbb3ba"},{"signature":"fn_rakeback_split_check(uuid,date,date,uuid[])","md5":"1d8486415e6213f4ec848de0b1dba74b"},{"signature":"fn_rakeback_split_write(uuid,date,date,uuid[])","md5":"487fb5a310d17a1464d87211e7d9dd54"},{"signature":"fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)","md5":"acc58329cf6eb0e50ca47afea3bdf60f"},{"signature":"fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)","md5":"cbf5dc2e01fada46b4f04625f00282f9"},{"signature":"fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)","md5":"3e86c68bae02fb88d651ba5498620db8"},{"signature":"smarter_private.own_agent_destination_contract(jsonb,uuid,uuid,timestamp with time zone)","md5":"65d809f307db4bea0ead0dcd7a3d1534"},{"signature":"smarter_private.own_agent_interpreted_contract(jsonb,uuid,uuid,numeric,uuid,timestamp with time zone)","md5":"038e7a69161b7d9b8434fe270fe45f59"},{"signature":"smarter_private.prepare_own_agent_interpretation(uuid,uuid,timestamp with time zone,timestamp with time zone,integer)","md5":"a86b1158f63c3cd912b2fb70cdd0ba23"},{"signature":"smarter_private.rakeback_certificate_wallets(bigint)","md5":"984721591c0295a6ca5c5552ec7bfae0"},{"signature":"smarter_private.rakeback_wallet_payout_complete(uuid,bigint)","md5":"0f5fbe00efb06f9a49dcfae37d5830cc"},{"signature":"smarter_private.rakeback_wallet_plan(jsonb,numeric)","md5":"48f1c18a1e83272bad0d0b1e1371ce42"},{"signature":"smarter_private.record_rakeback_wallet_contracts()","md5":"e0ba664285b5b6cc885fd6a2357d8596"},{"signature":"smarter_private.weekly_payout_prepare_due()","md5":"71e651b7e956674a7d288e0fe49ff3af"}]$postimages$::jsonb)AS x(signature text,md5 text)LOOP
  IF md5(pg_get_functiondef(to_regprocedure(r.signature)))IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'own_agent_owner_postimage_changed:%',r.signature;END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_temp._own_agent_install_metadata m LEFT JOIN pg_proc p ON p.oid=to_regprocedure(m.signature)WHERE(to_jsonb(p)-'prosrc')IS DISTINCT FROM m.metadata)THEN RAISE EXCEPTION 'own_agent_original_owner_metadata_changed';END IF;
 IF EXISTS(SELECT FROM pg_temp._own_agent_install_views m LEFT JOIN pg_class c ON c.oid=('public.'||m.name)::regclass WHERE to_jsonb(c)IS DISTINCT FROM m.metadata)THEN RAISE EXCEPTION 'own_agent_original_view_metadata_changed';END IF;
 IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private'AND p.proname IN('own_agent_destination_contract','rakeback_wallet_plan','record_rakeback_wallet_contracts','rakeback_certificate_wallets','rakeback_wallet_payout_complete','own_agent_interpreted_contract','admit_own_agent_source','prepare_own_agent_interpretation','assert_own_agent_scope_interpreted')AND(pg_get_userbyid(p.proowner)<>'postgres'OR NOT p.prosecdef OR p.proacl::text IS DISTINCT FROM'{postgres=X/postgres}'))THEN RAISE EXCEPTION 'own_agent_private_owner_or_acl_changed';END IF;
 IF NOT EXISTS(SELECT FROM ca_guard_defs WHERE proname='fn_ca_settlement_correctness_check'AND def_hash=md5(pg_get_functiondef('fn_ca_settlement_correctness_check()'::regprocedure)))THEN RAISE EXCEPTION 'own_agent_correctness_declaration_missing';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM 'original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20'THEN RAISE EXCEPTION 'own_agent_original_inventory_authority_changed';END IF;
END $post$;
COMMIT;
