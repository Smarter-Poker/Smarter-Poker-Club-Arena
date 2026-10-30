-- Version 20261030051108 reserved by scripts/new-migration.mjs.
-- Protected-main installation and exact live readback are required.
-- Completed standalone books incorrectly fell through to unpaid recalculation.
-- Native before/after and actual preparation qualify this independent repair;
-- remaining tournament-quality capacity and full automation are separate proof.
-- Completed standalone R3 follows the existing union paid_scope_replay branch.
-- This changes no rates, amounts, wallets, ledger, historical receipts or GEN.
-- @live-proof: md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='39a7e057da9a65dab5d0b2f761428f13'
BEGIN;
SET LOCAL transaction_timeout='15s';
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
DO $standalone_paid_prepare$
DECLARE d text;before_metadata jsonb;original_seals jsonb;
 expected_metadata jsonb:=$prepare_metadata${"oid":"34785319","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_prepare_accounting_week","prorows":0,"pronargs":4,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_union_id","p_club_id","p_from","p_to"],"proargtypes":["2950","2950","1184","1184"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$prepare_metadata$::jsonb;
 old_anchor text:=$prepare_anchor$ FOREACH club IN ARRAY clubs LOOP
$prepare_anchor$;
 inserted_hunk text:=$prepare_hunk$  -- A completed standalone R3 is its original paid-book authority, just as
  -- the union replay above and typed R0 legacy-paid owner already require.
  -- Retain every preceding source/refusal/interpretation/discovery/lock gate.
  -- Only complete, exact-scope original R2/R3 receipts may avoid recalculation;
  -- the coordinator still validates both receipts before accounting documents.
  IF p_club_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='club' AND r.scope_id=p_club_id AND r.round_no=3
      AND r.period_start=p_from AND r.period_end=p_to) THEN
   IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN
    SELECT r.result||jsonb_build_object('duplicate',true) INTO source_check
     FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='club' AND r.scope_id=p_club_id AND r.round_no=3
      AND r.period_start=p_from AND r.period_end=p_to;
   ELSE
    source_check:=public.fn_settle_accounting_rakeback_stage('club',p_club_id,p_from,p_to);
   END IF;
   IF source_check->>'success' IS DISTINCT FROM 'true' OR source_check->>'duplicate' IS DISTINCT FROM 'true'
    OR source_check->>'routing_version' IS DISTINCT FROM '3' OR source_check->>'source_version' IS DISTINCT FROM '2'
    OR source_check->'shortfalls' IS DISTINCT FROM '0'::jsonb
    OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='club' AND r.scope_id=p_club_id AND r.round_no=3
      AND r.period_start=p_from AND r.period_end=p_to AND r.completed_at IS NOT NULL
      AND r.result=(source_check-'duplicate'))
    OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='club' AND r.scope_id=p_club_id AND r.round_no=2
      AND r.period_start=p_from AND r.period_end=p_to AND r.completed_at IS NOT NULL
      AND r.result->>'success'='true' AND r.result->>'routing_version'='3'
      AND r.result->>'source_version'='2' AND r.result->'shortfalls'='0'::jsonb) THEN
    RAISE EXCEPTION 'original_paid_scope_replay_not_confirmed' USING ERRCODE='55000'; END IF;
   RETURN jsonb_build_object('success',true,'accounting_version',3,'union_id',p_union_id,'club_id',p_club_id,
     'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'problems','[]'::jsonb,'paid_scope_replay',true);
  END IF;
$prepare_hunk$;
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' THEN RAISE EXCEPTION 'standalone_paid_prepare_operator_required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261030051108')THEN RAISE EXCEPTION 'standalone_paid_prepare_version_already_installed' USING ERRCODE='55000';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'standalone_paid_prepare_maintenance_refused';END IF;
 SELECT pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure),to_jsonb(p)-'prosrc'
 INTO STRICT d,before_metadata FROM pg_proc p WHERE oid='public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure;
 IF md5(d)IS DISTINCT FROM '9960208f5b5398132a8e702497bbb3ba' OR before_metadata IS DISTINCT FROM expected_metadata THEN
  RAISE EXCEPTION 'standalone_paid_prepare_exact_preimage_or_authority_changed';END IF;
 IF md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))IS DISTINCT FROM '1736142e39ca72275a6b9197ab0a6123' THEN RAISE EXCEPTION 'standalone_paid_prepare_generation_source_changed';END IF;
 IF md5(pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure))IS DISTINCT FROM '58dc20e1ba380ccb9b9dee8809731d33' THEN RAISE EXCEPTION 'standalone_paid_prepare_generation_source_changed';END IF;
 -- Exactly one existing unpaid-loop anchor; no earlier authority is replaced.
 IF (length(d)-length(replace(d,old_anchor,'')))/length(old_anchor)<>1 THEN
  RAISE EXCEPTION 'standalone_paid_prepare_anchor_changed';END IF;
 d:=replace(d,old_anchor,inserted_hunk||old_anchor);
 IF md5(d)IS DISTINCT FROM '39a7e057da9a65dab5d0b2f761428f13' THEN RAISE EXCEPTION 'standalone_paid_prepare_generated_source_changed';END IF;
 EXECUTE d;
 -- CREATE OR REPLACE retains the exact existing postgres-only ACL. Explicit
 -- revocation also makes this authority visible to the maintained scanner.
 REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
 IF md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))IS DISTINCT FROM '39a7e057da9a65dab5d0b2f761428f13'
  OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)IS DISTINCT FROM before_metadata THEN
  RAISE EXCEPTION 'standalone_paid_prepare_exact_postimage_or_authority_changed';END IF;
 IF md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))IS DISTINCT FROM '1736142e39ca72275a6b9197ab0a6123' THEN RAISE EXCEPTION 'standalone_paid_prepare_generation_source_changed';END IF;
 IF md5(pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure))IS DISTINCT FROM '58dc20e1ba380ccb9b9dee8809731d33' THEN RAISE EXCEPTION 'standalone_paid_prepare_generation_source_changed';END IF;
END $standalone_paid_prepare$;
COMMIT;
