-- @live-proof: md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='44181958a392d2373d227db73b0151c9'
-- @live-proof: md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_plan(text,uuid,timestamptz,timestamptz)'::regprocedure))='25692f94ad5d535cc541b44feee61601'
-- A standalone close must not consume another coordinator's obligation.
-- Actual Deep Stack Society current-week Union certificates were selected by
-- club id despite zero standalone earning sources, aborting its zero round3.
-- Preserve every original source/certificate/payment refusal and the prior
-- historical-wallet admission loop. No migration-triggered money or row repair.
-- Predecessor: 20261020203346 must be installed after its engine runtime proof.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $scope$
DECLARE d text; before_generation text; before_authority jsonb; after_authority jsonb;
 old text:=$old$WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)$old$;
 replacement text:=$new$WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND EXISTS(SELECT 1 FROM LATERAL(SELECT foreign_cert.* FROM public.accounting_rakeback_period_calculations foreign_cert
       WHERE foreign_cert.period_id=rp.id ORDER BY foreign_cert.id DESC LIMIT 1)foreign_cert
      WHERE foreign_cert.accounting_version=2 AND foreign_cert.coordinator_union_id IS NOT NULL
       AND foreign_cert.club_id=rp.club_id AND foreign_cert.player_id=rp.user_id
       AND foreign_cert.period_start=rp.period_start AND foreign_cert.period_end=rp.period_end
       AND foreign_cert.rake_generated=rp.rake_generated AND foreign_cert.rake_generated=rp.total_rake_paid
       AND foreign_cert.rakeback_amount=rp.rakeback_amount AND foreign_cert.rakeback_amount=rp.rakeback_earned
       AND foreign_cert.display_rate=rp.rakeback_rate AND foreign_cert.rake_generated>=0
       AND foreign_cert.rakeback_amount>=0 AND foreign_cert.rakeback_amount=round(foreign_cert.rakeback_amount,2)
       AND foreign_cert.rake_generated::text NOT IN('NaN','Infinity','-Infinity')
       AND foreign_cert.rakeback_amount::text NOT IN('NaN','Infinity','-Infinity')
       AND foreign_cert.payer_kind IN('agent','club','split')
       AND (foreign_cert.payer_kind='agent')=(foreign_cert.payer_user_id IS NOT NULL)
       AND foreign_cert.payer_user_id IS DISTINCT FROM rp.user_id
       AND foreign_cert.display_rate BETWEEN 0 AND 1 AND foreign_cert.display_rate=round(foreign_cert.display_rate,4)
       AND foreign_cert.rakeback_amount<=foreign_cert.rake_generated
       AND jsonb_typeof(foreign_cert.source_allocations)='array'
       AND foreign_cert.source_allocations<>'[]'::jsonb
       AND foreign_cert.source_fingerprint=md5(jsonb_build_object('allocations',foreign_cert.source_allocations,
         'rake',foreign_cert.rake_generated,'amount',foreign_cert.rakeback_amount,'rate',foreign_cert.display_rate)::text)
       AND (SELECT count(*)=count(DISTINCT ROW(a->>'source_type',a->>'source_id'))
         AND sum((a->>'rake_credit')::numeric)=foreign_cert.rake_generated
         AND round(sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),2)=foreign_cert.rakeback_amount
         AND CASE WHEN foreign_cert.rake_generated>0 THEN round(sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)/foreign_cert.rake_generated,4) ELSE 0 END=foreign_cert.display_rate
         AND count(*)=(SELECT count(*) FROM public.accounting_payable_earning_sources all_foreign
           WHERE all_foreign.club_id=foreign_cert.club_id AND all_foreign.player_id=foreign_cert.player_id
            AND all_foreign.coordinator_union_id=foreign_cert.coordinator_union_id
            AND all_foreign.earned_at>=p_period_start AND all_foreign.earned_at<p_period_end)
         FROM jsonb_array_elements(foreign_cert.source_allocations) a)
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(foreign_cert.source_allocations) a
         LEFT JOIN public.accounting_payable_earning_sources fs
          ON fs.source_type=a->>'source_type' AND fs.source_id=(a->>'source_id')::uuid
         WHERE fs.source_id IS NULL OR fs.club_id IS DISTINCT FROM foreign_cert.club_id
          OR fs.player_id IS DISTINCT FROM foreign_cert.player_id
          OR fs.coordinator_union_id IS DISTINCT FROM foreign_cert.coordinator_union_id
          OR fs.earned_at<p_period_start OR fs.earned_at>=p_period_end
          OR fs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
          OR fs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
          OR a->>'source_type' NOT IN('cash_rake_accrual','tournament_fee_accrual')
          OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric NOT BETWEEN 0 AND 1
          OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
          OR a->>'payer_kind' IS NULL OR a->>'payer_kind' NOT IN('agent','club')
          OR NULLIF(a->>'payer_user_id','')::uuid=foreign_cert.player_id
          OR (a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','') IS NOT NULL)
          OR (foreign_cert.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM foreign_cert.payer_kind
            OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM foreign_cert.payer_user_id))))
    AND NOT EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources own_source
      WHERE own_source.coordinator_union_id IS NULL AND own_source.club_id=rp.club_id
       AND own_source.player_id=rp.user_id AND own_source.earned_at>=p_period_start AND own_source.earned_at<p_period_end))
  AND (rp.club_id=ANY(scope.club_ids)$new$;
 stage regprocedure:='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 plan regprocedure:='public.fn_settle_accounting_rakeback_plan(text,uuid,timestamptz,timestamptz)'::regprocedure;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
 OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
 OR nullif(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'coordinator_scope_operator_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL
 OR nullif(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'coordinator_scope_freeze_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'coordinator_scope_scheduler_owned'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261021173708') THEN RAISE EXCEPTION 'coordinator_scope_history_replay'; END IF;
 IF md5(pg_get_functiondef(stage))<>'4803071b28b2ad86c84291d9db9d5a2e' OR md5(pg_get_functiondef(plan))<>'3a6e5c361831c329349e4cac35ef8c14' THEN RAISE EXCEPTION 'coordinator_scope_preimage_changed'; END IF;
 IF EXISTS(SELECT FROM public.ca_guard_defs WHERE proname IN('fn_settle_accounting_rakeback_stage','fn_settle_accounting_rakeback_plan')) THEN RAISE EXCEPTION 'coordinator_scope_guard_watchlist_changed'; END IF;
 before_generation:=smarter_private.original_inventory_basis_generation();
 IF before_generation IS NULL OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'coordinator_scope_inventory_unproven'; END IF;
 SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.prosecdef,p.proconfig,p.proacl)ORDER BY p.oid) INTO before_authority FROM pg_catalog.pg_proc p WHERE p.oid IN(stage,plan);
 IF EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.oid IN(stage,plan)
  AND(pg_get_userbyid(p.proowner)<>'postgres' OR p.prosecdef IS DISTINCT FROM(p.oid=stage)
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
   OR p.proacl::text IS DISTINCT FROM CASE WHEN p.oid=stage THEN '{postgres=X/postgres}' ELSE '{postgres=X/postgres,service_role=X/postgres}' END))
 THEN RAISE EXCEPTION 'coordinator_scope_authority_changed'; END IF;
 d:=pg_get_functiondef(stage);
 IF length(d)-length(replace(d,old,''))<>2*length(old) THEN RAISE EXCEPTION 'coordinator_scope_stage_anchor_changed'; END IF;
 EXECUTE replace(d,old,replacement);
 d:=pg_get_functiondef(plan);
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'coordinator_scope_plan_anchor_changed'; END IF;
 EXECUTE replace(d,old,replacement);
 IF md5(pg_get_functiondef(stage))<>'44181958a392d2373d227db73b0151c9' OR md5(pg_get_functiondef(plan))<>'25692f94ad5d535cc541b44feee61601' THEN RAISE EXCEPTION 'coordinator_scope_postimage_changed'; END IF;
 SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.prosecdef,p.proconfig,p.proacl)ORDER BY p.oid) INTO after_authority FROM pg_catalog.pg_proc p WHERE p.oid IN(stage,plan);
 IF after_authority IS DISTINCT FROM before_authority THEN RAISE EXCEPTION 'coordinator_scope_authority_not_preserved'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM before_generation THEN RAISE EXCEPTION 'coordinator_scope_inventory_changed'; END IF;
END $scope$;
COMMIT;
