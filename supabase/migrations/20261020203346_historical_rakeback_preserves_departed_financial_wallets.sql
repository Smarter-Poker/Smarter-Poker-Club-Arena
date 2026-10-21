-- @live-proof: md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='4803071b28b2ad86c84291d9db9d5a2e'
-- @live-proof: md5(pg_get_functiondef('public.fn_require_explicit_club_membership_source()'::regprocedure))='ea458fa4c9177544002cb8f40fdcbd73'
-- @live-proof: md5(pg_get_functiondef('public.fn_audit_club_entry_mutation()'::regprocedure))='551c99f71d70848ef8115bbcfb5b7c71'
-- @live-proof: md5(pg_get_functiondef('smarter_private.historical_rakeback_wallet_admission(uuid,bigint,timestamptz,timestamptz)'::regprocedure))='5452bda6bd3c6e6880a5350b6ddd7750'
-- @live-proof: md5(pg_get_functiondef('smarter_private.preserve_historical_rakeback_wallet(uuid,bigint,timestamptz,timestamptz)'::regprocedure))='b4cdc75b354df1b73a34a26433a419ca'
-- Published positive rakeback outlives a physically removed membership. R3
-- previously refused the whole book on NULL wallet opening (47 Pilot players,
-- 22.67 owed). Preserve a zero-opening, departed financial wallet inside the
-- original R3 transaction, never active membership or a replacement payout.
-- Deployment dependency: activate and verify the connected engine club-channel
-- access fix before installing this migration. No historical money is changed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $preflight$
DECLARE generation text; owners jsonb;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
 OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
 OR nullif(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'historical_wallet_operator_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL
 OR nullif(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'historical_wallet_freeze_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'historical_wallet_scheduler_owned'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261020203346') THEN RAISE EXCEPTION 'historical_wallet_history_replay'; END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF generation IS NULL OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'historical_wallet_source_inventory_changed'; END IF;
 PERFORM set_config('app.historical_wallet_install_generation',generation,true);
 IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))<>'fa489e420cf45112efe0b1e709fb4827'
 OR md5(pg_get_functiondef('public.fn_require_explicit_club_membership_source()'::regprocedure))<>'f694fef84a37560028281eead6f45257'
 OR md5(pg_get_functiondef('public.fn_audit_club_entry_mutation()'::regprocedure))<>'d26149a3b10aa00618a98f5076ebf079' THEN RAISE EXCEPTION 'historical_wallet_preimage_changed'; END IF;
 SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl) ORDER BY p.oid) INTO owners
 FROM pg_catalog.pg_proc p WHERE p.oid IN('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure,
 'public.fn_require_explicit_club_membership_source()'::regprocedure,'public.fn_audit_club_entry_mutation()'::regprocedure);
 IF EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.oid IN('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure,
 'public.fn_require_explicit_club_membership_source()'::regprocedure,'public.fn_audit_club_entry_mutation()'::regprocedure)
 AND (pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]))
 OR EXISTS(SELECT FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 WHERE p.oid IN('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure,
 'public.fn_require_explicit_club_membership_source()'::regprocedure,'public.fn_audit_club_entry_mutation()'::regprocedure)
 AND (a.grantee=0 OR pg_get_userbyid(a.grantee) NOT IN('postgres','service_role') OR a.is_grantable
 OR (p.oid='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure AND pg_get_userbyid(a.grantee)<>'postgres')))
 THEN RAISE EXCEPTION 'historical_wallet_owner_authority_changed'; END IF;
 PERFORM set_config('app.historical_wallet_install_owners',owners::text,true);
 IF to_regprocedure('smarter_private.historical_rakeback_wallet_admission(uuid,bigint,timestamptz,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'historical_wallet_owner_already_exists'; END IF;
END $preflight$;

CREATE FUNCTION smarter_private.historical_rakeback_wallet_admission(p_period uuid,p_certificate bigint,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','public' AS $function$
DECLARE r public.rakeback_periods%ROWTYPE; c public.accounting_rakeback_period_calculations%ROWTYPE;
 n bigint; distinct_n bigint; generated numeric; unrounded numeric; source_n bigint; bad boolean;
BEGIN
 IF public.fn_caller_is_engine() IS DISTINCT FROM true OR public.fn_platform_frozen() IS DISTINCT FROM false
 OR p_period IS NULL OR p_certificate IS NULL OR p_start IS NULL OR p_end IS NULL
 OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start IS DISTINCT FROM public.fn_union_week_start(p_start) OR p_end IS DISTINCT FROM public.fn_union_week_start(p_start+interval '8 days') THEN RAISE EXCEPTION 'historical_wallet_admission_refused' USING ERRCODE='42501'; END IF;
 IF to_regclass('pg_temp._routed_player_todo') IS NULL OR to_regclass('pg_temp._routed_player_funding') IS NULL
 OR NOT EXISTS(SELECT FROM pg_catalog.pg_class WHERE oid=to_regclass('pg_temp._routed_player_todo') AND pg_get_userbyid(relowner)='postgres')
 OR NOT EXISTS(SELECT FROM pg_catalog.pg_class WHERE oid=to_regclass('pg_temp._routed_player_funding') AND pg_get_userbyid(relowner)='postgres')
 THEN RAISE EXCEPTION 'historical_wallet_native_stage_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.rakeback_periods WHERE id=p_period FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'historical_wallet_period_required'; END IF;
 SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
 IF NOT FOUND OR c.id IS DISTINCT FROM p_certificate OR c.accounting_version IS DISTINCT FROM 2
 OR r.status IS DISTINCT FROM 'pending' OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
 OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
 OR r.period_start IS DISTINCT FROM (p_start AT TIME ZONE 'America/Los_Angeles')::date
 OR r.period_end IS DISTINCT FROM ((p_end AT TIME ZONE 'America/Los_Angeles')::date-1)
 OR c.rake_generated IS NULL OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
 OR c.rakeback_amount IS NULL OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
 OR c.display_rate IS NULL OR c.display_rate IS DISTINCT FROM r.rakeback_rate
 OR c.rakeback_amount<=0 OR c.rakeback_amount>c.rake_generated OR c.rakeback_amount<>round(c.rakeback_amount,2)
 OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.source_fingerprint IS NULL OR c.source_fingerprint!~'^[0-9a-f]{32}$'
 OR jsonb_typeof(c.source_allocations) IS DISTINCT FROM 'array'
 OR EXISTS(SELECT FROM public.rakeback_period_payouts WHERE rakeback_period_id=r.id)
 OR NOT EXISTS(SELECT FROM public.profiles WHERE id=r.user_id)
 OR NOT EXISTS(SELECT FROM public.clubs WHERE id=r.club_id AND asset='chips' AND lifecycle_status='active')
 THEN RAISE EXCEPTION 'historical_wallet_latest_positive_certificate_required'; END IF;
 IF NOT EXISTS(SELECT FROM pg_temp._routed_player_todo WHERE period_id=p_period AND certificate_id=p_certificate AND club_id=r.club_id AND user_id=r.user_id AND owed=c.rakeback_amount AND owed>0)
 OR EXISTS(SELECT FROM pg_temp._routed_player_funding WHERE club_id=r.club_id AND payer_kind='agent' AND payer_user=r.user_id)
 THEN RAISE EXCEPTION 'historical_wallet_payer_restoration_refused'; END IF;
 SELECT count(*),count(DISTINCT ROW(a->>'source_type',a->>'source_id')),
 sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
 coalesce(bool_or(s.source_id IS NULL OR s.club_id IS DISTINCT FROM r.club_id OR s.player_id IS DISTINCT FROM r.user_id
 OR s.coordinator_union_id IS DISTINCT FROM c.coordinator_union_id OR s.earned_at<p_start OR s.earned_at>=p_end
 OR s.rake_credit IS DISTINCT FROM (a->>'rake_credit')::numeric OR s.rake_record_id IS DISTINCT FROM (a->>'rake_record_id')::uuid
 OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1 OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
 OR h.id IS NULL OR h.entity_type IS DISTINCT FROM 'club_members' OR h.entity_key IS DISTINCT FROM r.club_id::text||':'||r.user_id::text
 OR h.after_terms IS DISTINCT FROM s.contract#>'{membership,terms}' OR h.observed_at>s.earned_at
 OR s.contract#>>'{membership,terms,club_id}' IS DISTINCT FROM r.club_id::text
 OR s.contract#>>'{membership,terms,user_id}' IS DISTINCT FROM r.user_id::text),true)
 INTO n,distinct_n,generated,unrounded,bad
 FROM jsonb_array_elements(c.source_allocations)a
 LEFT JOIN LATERAL(SELECT s.* FROM public.accounting_payable_earning_sources s WHERE s.source_type=a->>'source_type' AND s.source_id=(a->>'source_id')::uuid OFFSET 0)s ON true
 LEFT JOIN LATERAL(SELECT h.* FROM public.accounting_agreement_history h WHERE h.id=(s.contract#>>'{membership,history_id}')::bigint OFFSET 0)h ON true;
 SELECT count(*) INTO source_n FROM public.accounting_payable_earning_sources s WHERE s.club_id=r.club_id AND s.player_id=r.user_id
 AND s.coordinator_union_id IS NOT DISTINCT FROM c.coordinator_union_id AND s.earned_at>=p_start AND s.earned_at<p_end;
 IF n=0 OR n<>distinct_n OR n<>source_n OR generated IS DISTINCT FROM c.rake_generated OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
 OR bad IS DISTINCT FROM false THEN RAISE EXCEPTION 'historical_wallet_original_history_required'; END IF;
 RETURN jsonb_build_object('club_id',r.club_id,'user_id',r.user_id,'certificate_id',c.id,'period_id',r.id,'source_fingerprint',c.source_fingerprint);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.historical_rakeback_wallet_admission(uuid,bigint,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.preserve_historical_rakeback_wallet(p_period uuid,p_certificate bigint,p_start timestamptz,p_end timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','public' AS $function$
DECLARE admission jsonb; cid uuid; uid uuid; saved text; saved_period text; saved_cert text; saved_start text; saved_end text;
BEGIN
 admission:=smarter_private.historical_rakeback_wallet_admission(p_period,p_certificate,p_start,p_end);
 cid:=(admission->>'club_id')::uuid;uid:=(admission->>'user_id')::uuid;
 IF to_regclass('pg_temp._routed_player_todo') IS NULL OR to_regclass('pg_temp._routed_player_funding') IS NULL THEN RAISE EXCEPTION 'historical_wallet_native_stage_required'; END IF;
 IF NOT EXISTS(SELECT FROM pg_temp._routed_player_todo WHERE period_id=p_period AND certificate_id=p_certificate AND club_id=cid AND user_id=uid AND owed>0)
 OR EXISTS(SELECT FROM pg_temp._routed_player_funding WHERE club_id=cid AND payer_kind='agent' AND payer_user=uid) THEN RAISE EXCEPTION 'historical_wallet_payer_restoration_refused'; END IF;
 PERFORM public.fn_club_membership_lock(uid);
 IF EXISTS(SELECT FROM public.club_members WHERE club_id=cid AND user_id=uid) THEN RETURN; END IF;
 saved:=current_setting('app.club_membership_source',true);saved_period:=current_setting('app.historical_rakeback_period',true);
 saved_cert:=current_setting('app.historical_rakeback_certificate',true);saved_start:=current_setting('app.historical_rakeback_start',true);saved_end:=current_setting('app.historical_rakeback_end',true);
 PERFORM set_config('app.club_membership_source','historical_rakeback_wallet',true);
 PERFORM set_config('app.historical_rakeback_period',p_period::text,true);PERFORM set_config('app.historical_rakeback_certificate',p_certificate::text,true);
 PERFORM set_config('app.historical_rakeback_start',p_start::text,true);PERFORM set_config('app.historical_rakeback_end',p_end::text,true);
 INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,departed_at,departure_reason,chip_balance,promo_balance,held_chips,locked_chips,credit_limit,credit_used,commission_rate,rakeback_rate,player_rakeback_pct,agent_id,parent_agent_id)
 VALUES(cid,uid,'player','suspended',false,'departed',clock_timestamp(),'historical_rakeback:'||p_period::text||':'||p_certificate::text,0,0,0,0,0,0,0,0,0,NULL,NULL);
 PERFORM set_config('app.club_membership_source',coalesce(saved,''),true);PERFORM set_config('app.historical_rakeback_period',coalesce(saved_period,''),true);
 PERFORM set_config('app.historical_rakeback_certificate',coalesce(saved_cert,''),true);PERFORM set_config('app.historical_rakeback_start',coalesce(saved_start,''),true);PERFORM set_config('app.historical_rakeback_end',coalesce(saved_end,''),true);
 IF NOT EXISTS(SELECT FROM public.club_members WHERE club_id=cid AND user_id=uid AND role='player' AND status='suspended' AND is_active=false AND membership_lifecycle_status='departed'
 AND chip_balance=0 AND promo_balance=0 AND held_chips=0 AND locked_chips=0 AND credit_limit=0 AND credit_used=0 AND agent_id IS NULL AND parent_agent_id IS NULL) THEN RAISE EXCEPTION 'historical_wallet_insert_shape_changed'; END IF;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.preserve_historical_rakeback_wallet(uuid,bigint,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- This branch does not trust the source marker: the original immutable earning
-- history and latest published obligation independently decide admission.
CREATE OR REPLACE FUNCTION public.fn_require_explicit_club_membership_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $function$
DECLARE v_source text:=coalesce(current_setting('app.club_membership_source',true),''); admission jsonb;
BEGIN
 IF v_source='historical_rakeback_wallet' THEN
  admission:=smarter_private.historical_rakeback_wallet_admission(nullif(current_setting('app.historical_rakeback_period',true),'')::uuid,
   nullif(current_setting('app.historical_rakeback_certificate',true),'')::bigint,nullif(current_setting('app.historical_rakeback_start',true),'')::timestamptz,nullif(current_setting('app.historical_rakeback_end',true),'')::timestamptz);
  IF NEW.club_id IS DISTINCT FROM(admission->>'club_id')::uuid OR NEW.user_id IS DISTINCT FROM(admission->>'user_id')::uuid
  OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'suspended' OR NEW.is_active IS DISTINCT FROM false
  OR NEW.membership_lifecycle_status IS DISTINCT FROM 'departed' OR NEW.departed_at IS NULL
  OR NEW.departure_reason IS DISTINCT FROM 'historical_rakeback:'||(admission->>'period_id')||':'||(admission->>'certificate_id')
  OR NEW.chip_balance IS DISTINCT FROM 0::numeric OR NEW.promo_balance IS DISTINCT FROM 0::numeric
  OR NEW.held_chips IS DISTINCT FROM 0::numeric OR NEW.locked_chips IS DISTINCT FROM 0
  OR NEW.credit_limit IS DISTINCT FROM 0::numeric OR NEW.credit_used IS DISTINCT FROM 0::numeric
  OR NEW.commission_rate IS DISTINCT FROM 0::numeric OR NEW.rakeback_rate IS DISTINCT FROM 0::numeric OR NEW.player_rakeback_pct IS DISTINCT FROM 0::numeric
  OR NEW.agent_id IS NOT NULL OR NEW.parent_agent_id IS NOT NULL
  THEN RAISE EXCEPTION 'historical_wallet_source_shape_refused' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF v_source NOT IN('join_club','club_owner_create','union_owner_membership') THEN
  RAISE EXCEPTION 'MEMBERSHIP_REQUIRES_JOIN: Club Members Can Only Be Added Through Join A Club' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;

DO $wire$
DECLARE d text; old text:=$old$ PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id$old$;
BEGIN
 d:=pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure);
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'historical_wallet_native_anchor_changed'; END IF;
 d:=replace(d,old,$new$ FOR r IN SELECT i.* FROM pg_temp._routed_player_todo i WHERE i.owed>0
  AND NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=i.club_id AND cm.user_id=i.user_id)
  ORDER BY i.club_id,i.user_id,i.period_id LOOP
  PERFORM smarter_private.preserve_historical_rakeback_wallet(r.period_id,r.certificate_id,p_period_start,p_period_end);
 END LOOP;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id$new$);
 EXECUTE d;
 d:=pg_get_functiondef('public.fn_audit_club_entry_mutation()'::regprocedure);
 old:=$old$    v_action:=CASE WHEN TG_OP='INSERT' THEN 'club_join_'||NEW.status ELSE 'club_join_status_changed' END;$old$;
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'historical_wallet_audit_anchor_changed'; END IF;
 d:=replace(d,old,$new$    v_action:=CASE WHEN TG_OP='INSERT' AND current_setting('app.club_membership_source',true)='historical_rakeback_wallet'
      AND NEW.membership_lifecycle_status='departed' AND NEW.status='suspended' AND NEW.is_active=false
      THEN 'historical_rakeback_wallet_preserved'
      WHEN TG_OP='INSERT' THEN 'club_join_'||NEW.status ELSE 'club_join_status_changed' END;$new$);
 EXECUTE d;
 IF (SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl) ORDER BY p.oid)
 FROM pg_catalog.pg_proc p WHERE p.oid IN('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure,
 'public.fn_require_explicit_club_membership_source()'::regprocedure,'public.fn_audit_club_entry_mutation()'::regprocedure))
 IS DISTINCT FROM current_setting('app.historical_wallet_install_owners')::jsonb THEN RAISE EXCEPTION 'historical_wallet_owner_authority_not_preserved'; END IF;
 IF EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.oid IN('smarter_private.historical_rakeback_wallet_admission(uuid,bigint,timestamptz,timestamptz)'::regprocedure,
 'smarter_private.preserve_historical_rakeback_wallet(uuid,bigint,timestamptz,timestamptz)'::regprocedure)
 AND (pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]))
 OR EXISTS(SELECT FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 WHERE p.oid IN('smarter_private.historical_rakeback_wallet_admission(uuid,bigint,timestamptz,timestamptz)'::regprocedure,
 'smarter_private.preserve_historical_rakeback_wallet(uuid,bigint,timestamptz,timestamptz)'::regprocedure) AND (a.grantee<>p.proowner OR a.is_grantable))
 THEN RAISE EXCEPTION 'historical_wallet_private_authority_invalid'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM current_setting('app.historical_wallet_install_generation') THEN RAISE EXCEPTION 'historical_wallet_inventory_changed'; END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))<>'4803071b28b2ad86c84291d9db9d5a2e' OR
 md5(pg_get_functiondef('public.fn_require_explicit_club_membership_source()'::regprocedure))<>'ea458fa4c9177544002cb8f40fdcbd73' OR
 md5(pg_get_functiondef('public.fn_audit_club_entry_mutation()'::regprocedure))<>'551c99f71d70848ef8115bbcfb5b7c71' OR
 md5(pg_get_functiondef('smarter_private.historical_rakeback_wallet_admission(uuid,bigint,timestamptz,timestamptz)'::regprocedure))<>'5452bda6bd3c6e6880a5350b6ddd7750' OR
 md5(pg_get_functiondef('smarter_private.preserve_historical_rakeback_wallet(uuid,bigint,timestamptz,timestamptz)'::regprocedure))<>'b4cdc75b354df1b73a34a26433a419ca' THEN RAISE EXCEPTION 'historical_wallet_postimage_changed'; END IF;
END $wire$;
COMMIT;
