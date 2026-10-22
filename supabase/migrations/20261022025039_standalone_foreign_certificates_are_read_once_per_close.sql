-- @live-proof: md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='0f1931507ad1a7a30c244f7830ef04d6'
-- @live-proof: md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_plan(text,uuid,timestamptz,timestamptz)'::regprocedure))='29fe66e159512fbfe76afd36807c6d8b'
-- @live-proof: to_regprocedure('public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)') IS NOT NULL
-- A standalone weekly close reads foreign Union certificates once, as a set.
--
-- 20261021173708 excluded, from a standalone club's R3, every exact-week
-- period that an intact Union certificate already owns. It evaluated that
-- test per period, and each evaluation re-read accounting_payable_earning_sources
-- (a view over cash sources, tournament recognitions and the launch cutoffs)
-- once for the period's source count, once per allocation for the allocation
-- proof and once for the standalone-source test. Measured on production
-- 2026-10-22 for Deep Stack Society, week 2026-10-12: 416 periods, about 1.5 s
-- for one source count alone and over two minutes for three periods, so the
-- stage (fn_settle_accounting_rakeback_stage, inside the v4 period selection)
-- never finished. Every native visit timed out holding the book, a direct
-- 24-minute attempt did not finish either, and the week's standalone book
-- stayed failed although the Union had already paid every obligation.
--
-- The same predicate is now one set computation over the standalone club's
-- week of sources (39 s for all 416 periods, all 416 excluded, measured
-- read-only). Every test is carried over unchanged: latest certificate
-- identity, published amounts, fingerprint, weighted display rate, the
-- complete allocation/source cohort, no self-paying allocation, and no actual
-- standalone source. Sources are restricted to the standalone club and the
-- week; a source outside that restriction already fails the allocation test
-- (club or window mismatch), and every source key is unique in the view
-- (cash id primary key; tournament source, recognition and event keys are
-- unique), so the restriction changes no outcome. Unknown or malformed
-- certificates stay on the original refusal path. No row, payment, wallet,
-- ledger, receipt or invoice is written by this migration.
--
-- Predecessor: 20261021173708 (installed; its post-images are this preimage).
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
-- The native weekly scheduler holds its lock for most of every five-minute
-- visit while this standalone book keeps failing (the failure this migration
-- removes), and the first installation was refused on a busy instant
-- (foreign_set_scheduler_owned, 2026-10-22 04:40 UTC, nothing written). The
-- lock is therefore awaited first, alone, in short bounded attempts, before
-- any DDL; the guard below still requires it and still refuses without it.
SET LOCAL statement_timeout='300s';
DO $await$
BEGIN
 FOR attempt IN 1..1100 LOOP
  IF pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RETURN; END IF;
  PERFORM pg_sleep(0.25);
 END LOOP;
 RAISE EXCEPTION 'foreign_set_scheduler_owned';
END $await$;
SET LOCAL statement_timeout='15s';
CREATE FUNCTION public.fn_standalone_foreign_certificate_periods(
 p_scope_kind text,p_club uuid,p_from_date date,p_to_date date,p_period_start timestamptz,p_period_end timestamptz)
RETURNS TABLE(period_id uuid) LANGUAGE sql STABLE SET search_path=public AS $set$
WITH src AS MATERIALIZED (
  SELECT s.source_type,s.source_id,s.club_id,s.player_id,s.coordinator_union_id,s.earned_at,s.rake_credit,s.rake_record_id
  FROM public.accounting_payable_earning_sources s
  WHERE p_scope_kind='club' AND p_club IS NOT NULL AND s.club_id=p_club AND s.earned_at>=p_period_start AND s.earned_at<p_period_end),
cnt AS MATERIALIZED (SELECT src.player_id,src.coordinator_union_id,count(*) n FROM src GROUP BY 1,2),
own AS MATERIALIZED (SELECT DISTINCT src.player_id FROM src WHERE src.coordinator_union_id IS NULL),
cand AS MATERIALIZED (
  SELECT rp.user_id,foreign_cert.* FROM public.rakeback_periods rp
  CROSS JOIN LATERAL(SELECT fc.* FROM public.accounting_rakeback_period_calculations fc
     WHERE fc.period_id=rp.id ORDER BY fc.id DESC LIMIT 1)foreign_cert
  WHERE p_scope_kind='club' AND p_club IS NOT NULL AND rp.club_id=p_club
   AND rp.period_start=p_from_date AND rp.period_end=p_to_date
   AND foreign_cert.accounting_version=2 AND foreign_cert.coordinator_union_id IS NOT NULL
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
     'rake',foreign_cert.rake_generated,'amount',foreign_cert.rakeback_amount,'rate',foreign_cert.display_rate)::text)),
bad AS MATERIALIZED (
  SELECT DISTINCT foreign_cert.period_id FROM cand foreign_cert
  CROSS JOIN LATERAL jsonb_array_elements(foreign_cert.source_allocations) a
  LEFT JOIN src fs ON fs.source_type=a->>'source_type' AND fs.source_id=(a->>'source_id')::uuid
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
     OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM foreign_cert.payer_user_id)))
SELECT foreign_cert.period_id FROM cand foreign_cert
WHERE (SELECT count(*)=count(DISTINCT ROW(a->>'source_type',a->>'source_id'))
   AND sum((a->>'rake_credit')::numeric)=foreign_cert.rake_generated
   AND round(sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),2)=foreign_cert.rakeback_amount
   AND CASE WHEN foreign_cert.rake_generated>0 THEN round(sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)/foreign_cert.rake_generated,4) ELSE 0 END=foreign_cert.display_rate
   AND count(*)=COALESCE((SELECT c.n FROM cnt c WHERE c.player_id=foreign_cert.player_id AND c.coordinator_union_id=foreign_cert.coordinator_union_id),0)
   FROM jsonb_array_elements(foreign_cert.source_allocations) a)
 AND NOT EXISTS(SELECT 1 FROM bad b WHERE b.period_id=foreign_cert.period_id)
 AND NOT EXISTS(SELECT 1 FROM own o WHERE o.player_id=foreign_cert.user_id)
$set$;
REVOKE ALL ON FUNCTION public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz) FROM PUBLIC;
DO $acl$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz) FROM %I',role_name);
  END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz) TO service_role;
 END IF;
END $acl$;
DO $scope$
DECLARE d text; before_generation text; before_authority jsonb; after_authority jsonb;
 old text:=$old$WHERE rp.period_start<=to_date AND rp.period_end>=from_date
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
  AND (rp.club_id=ANY(scope.club_ids)$old$;
 replacement text:=$new$WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  -- A standalone book never owns a valid Union certificate without any of
  -- its own original earning sources. Unknown certificates remain admitted
  -- to the original refusal path; any standalone source defeats exclusion.
  -- The identical certificate tests are read once per close as one set
  -- (fn_standalone_foreign_certificate_periods), never once per period.
  AND NOT(p_scope_kind='club' AND rp.club_id=standalone_club
    AND rp.period_start=from_date AND rp.period_end=to_date
    AND rp.id IN(SELECT foreign_set.period_id FROM public.fn_standalone_foreign_certificate_periods(
      p_scope_kind,standalone_club,from_date,to_date,p_period_start,p_period_end)foreign_set))
  AND (rp.club_id=ANY(scope.club_ids)$new$;
 stage regprocedure:='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 plan regprocedure:='public.fn_settle_accounting_rakeback_plan(text,uuid,timestamptz,timestamptz)'::regprocedure;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
 OR nullif(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
 OR nullif(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'foreign_set_operator_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL
 OR nullif(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'foreign_set_freeze_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'foreign_set_scheduler_owned'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261022025039') THEN RAISE EXCEPTION 'foreign_set_history_replay'; END IF;
 IF md5(pg_get_functiondef(stage))<>'44181958a392d2373d227db73b0151c9' OR md5(pg_get_functiondef(plan))<>'25692f94ad5d535cc541b44feee61601' THEN RAISE EXCEPTION 'foreign_set_preimage_changed'; END IF;
 IF EXISTS(SELECT FROM public.ca_guard_defs WHERE proname IN('fn_settle_accounting_rakeback_stage','fn_settle_accounting_rakeback_plan')) THEN RAISE EXCEPTION 'foreign_set_guard_watchlist_changed'; END IF;
 before_generation:=smarter_private.original_inventory_basis_generation();
 IF before_generation IS NULL OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'foreign_set_inventory_unproven'; END IF;
 SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.prosecdef,p.proconfig,p.proacl)ORDER BY p.oid) INTO before_authority FROM pg_catalog.pg_proc p WHERE p.oid IN(stage,plan);
 d:=pg_get_functiondef(stage);
 IF length(d)-length(replace(d,old,''))<>2*length(old) THEN RAISE EXCEPTION 'foreign_set_stage_anchor_changed'; END IF;
 EXECUTE replace(d,old,replacement);
 d:=pg_get_functiondef(plan);
 IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'foreign_set_plan_anchor_changed'; END IF;
 EXECUTE replace(d,old,replacement);
 IF md5(pg_get_functiondef(stage))<>'0f1931507ad1a7a30c244f7830ef04d6' OR md5(pg_get_functiondef(plan))<>'29fe66e159512fbfe76afd36807c6d8b' THEN RAISE EXCEPTION 'foreign_set_postimage_changed'; END IF;
 SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.prosecdef,p.proconfig,p.proacl)ORDER BY p.oid) INTO after_authority FROM pg_catalog.pg_proc p WHERE p.oid IN(stage,plan);
 IF after_authority IS DISTINCT FROM before_authority THEN RAISE EXCEPTION 'foreign_set_authority_not_preserved'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM before_generation THEN RAISE EXCEPTION 'foreign_set_inventory_changed'; END IF;
END $scope$;
COMMIT;
