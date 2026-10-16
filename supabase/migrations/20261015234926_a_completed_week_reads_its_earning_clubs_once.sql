-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='e4c2252df2382259d164e1b11b00b82b')
-- Reserved by scripts/new-migration.mjs:20261015234926.
-- The original week has all window proofs but normal240s ticks still time out
-- before its next attempt. An exact-scope self-aborting diagnostic timed out
-- in the earning-club reader in a completion check (2026-10-15T23:43:28Z).
-- A read of the completed Sep21 predecessor's clubs also exceeded20s.
-- This loop checks older completed books before the unpaid one and repeats
-- that same cohort reader three times per completed book. Compute it once in
-- this completion block, under the unchanged closed-book barrier and week lock.
-- Every completion predicate remains identical and reads the same fresh set.
-- All preparation, payment, source, no-owed, invoice and conservation checks
-- outside this block are byte-identical. No cross-transaction cache, money,
-- receipt, schedule, budget or permission is changed. Installs after182133.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'completion_scan_operator_refused' USING ERRCODE='42501'; END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'completion_scan_override_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'completion_scan_freeze_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'completion_scan_reader_owned'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015234926') THEN RAISE EXCEPTION 'completion_scan_history_replay'; END IF;
 IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261015182133')<>1 OR NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015182133' AND cardinality(statements)=1 AND octet_length(statements[1])=9595 AND md5(statements[1])='d838708c22ec8ea3398d789da04cefcb') THEN RAISE EXCEPTION 'completion_scan_parent_history_refused'; END IF;
END $guard$;
DO $install$
DECLARE sig regprocedure:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 def text:=pg_get_functiondef(sig);
 old text:=$completion$      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc ON uc.club_id=rp.club_id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc
          WHERE uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc
        WHERE uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.club_id=uc.club_id AND sp.union_id=v_union.id AND sp.start_at=v_from AND sp.end_at=v_end AND sp.status IN('settled','closed') AND i.status<>'cancelled'));
      -- Completion is proved by the actual posted source receipts, not only
      -- the coordinator's summary JSON or another union's period document.
      v_complete:=v_complete AND EXISTS(SELECT 1 FROM public.ca_settlements c
        WHERE c.settlement_type='union_rakeback_close' AND c.union_id=v_union.id AND c.state='final'
         AND c.totals->>'accounting_version'='3' AND c.external_ref=v_union.id::text||':'
          ||to_char(v_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'
          ||to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        AND NOT EXISTS(SELECT 1 FROM generate_series(2,3) n WHERE NOT EXISTS(
          SELECT 1 FROM public.accounting_routed_settlement_runs r
           WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
            AND r.result->>'success'='true' AND r.result->'shortfalls'='0'::jsonb
            AND r.result=(v_previous->CASE WHEN n=2 THEN 'round2_club_to_agents' ELSE 'round3_agents_to_players' END)-'duplicate'));
$completion$;
 new text:=$completion$      -- Completion uses one fresh earning-club set under this book's lock.
      IF v_complete THEN
        DECLARE v_completion_clubs uuid[];
        BEGIN
          SELECT ARRAY(SELECT club_id FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end)) INTO v_completion_clubs;
      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN unnest(v_completion_clubs) AS uc(club_id) ON uc.club_id=rp.club_id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM unnest(v_completion_clubs) AS uc(club_id)
          WHERE uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM unnest(v_completion_clubs) AS uc(club_id)
        WHERE uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.club_id=uc.club_id AND sp.union_id=v_union.id AND sp.start_at=v_from AND sp.end_at=v_end AND sp.status IN('settled','closed') AND i.status<>'cancelled'));
      -- Completion is proved by the actual posted source receipts, not only
      -- the coordinator's summary JSON or another union's period document.
      v_complete:=v_complete AND EXISTS(SELECT 1 FROM public.ca_settlements c
        WHERE c.settlement_type='union_rakeback_close' AND c.union_id=v_union.id AND c.state='final'
         AND c.totals->>'accounting_version'='3' AND c.external_ref=v_union.id::text||':'
          ||to_char(v_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'
          ||to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        AND NOT EXISTS(SELECT 1 FROM generate_series(2,3) n WHERE NOT EXISTS(
          SELECT 1 FROM public.accounting_routed_settlement_runs r
           WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
            AND r.result->>'success'='true' AND r.result->'shortfalls'='0'::jsonb
            AND r.result=(v_previous->CASE WHEN n=2 THEN 'round2_club_to_agents' ELSE 'round3_agents_to_players' END)-'duplicate'));
        END;
      END IF;
$completion$;
 before text;
BEGIN
 IF md5(def)<>'009938740934b24744b35496477d02a1' THEN RAISE EXCEPTION 'completion_scan_preimage_refused'; END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=sig AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public'] AND p.proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'completion_scan_authority_refused'; END IF;
 IF (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'completion_scan_anchor_refused'; END IF;
 SELECT concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,p.proconfig::text,p.proacl::text) INTO before FROM pg_proc p WHERE p.oid=sig;
 EXECUTE replace(def,old,new);
 IF md5(pg_get_functiondef(sig))<>'e4c2252df2382259d164e1b11b00b82b' THEN RAISE EXCEPTION 'completion_scan_postimage_refused'; END IF;
 IF (SELECT concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,p.proconfig::text,p.proacl::text) FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'completion_scan_security_refused'; END IF;
END $install$;
COMMIT;
