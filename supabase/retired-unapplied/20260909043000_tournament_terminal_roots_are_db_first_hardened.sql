-- DB-FIRST TERMINAL AUTHORITY HARDENING
--
-- The replacement engine uses fn_complete_tournament_terminal and
-- fn_settle_satellite_tournament, but the currently deployed engine can still
-- call the older service roots while that binary drains.  This migration is
-- therefore deliberately non-destructive: it closes every browser/default
-- grant, makes every wrapper-only implementation owner-only, and keeps only
-- the exact service roots needed by either engine generation.  The obsolete
-- service roots are dropped only in the post-engine cutover migration.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ACL replacement changes every terminal service root as one authority
-- boundary. Serialize it with terminal settlement first and the shared entry
-- maintenance root second, before reading or changing any function catalog.
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);

-- The freeze predicate is executable cutover authority, not a name to trust.
-- Authenticate its exact body and the statement trigger that serializes every
-- maintenance-row writer before using either the live or pristine branch.
DO $authenticate_entry_freeze_authority$
DECLARE
  v_break_relation oid := to_regclass('public.engine_maintenance_break');
  v_predicate oid := to_regprocedure('public.fn_entry_purchases_frozen()');
  v_writer oid :=
    to_regprocedure('public.fn_serialize_engine_maintenance_break_write()');
  v_relation_owner oid;
BEGIN
  IF v_break_relation IS NULL OR v_predicate IS NULL OR v_writer IS NULL THEN
    RAISE EXCEPTION 'canonical maintenance entry-freeze authority is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relowner INTO STRICT v_relation_owner
    FROM pg_class c WHERE c.oid = v_break_relation;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_predicate
       AND md5(p.prosrc) = 'a29498531e4b7d3889532e80fafc8d57'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'boolean'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'sql'
  ) THEN
    RAISE EXCEPTION 'maintenance entry-freeze predicate is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_writer
       AND md5(p.prosrc) = '084ed24f99e9d08765bd86ff8b920284'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'trigger'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'maintenance-row serialization function is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid = v_break_relation
       AND tg.tgname = 'aa_serialize_maintenance_break_write'
       AND tg.tgfoid = v_writer
       AND NOT tg.tgisinternal
       AND tg.tgenabled = 'O'
       AND tg.tgtype = 62
       AND tg.tgattr::text = ''
       AND tg.tgqual IS NULL
       AND tg.tgnargs = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'maintenance-row serialization trigger is not canonical and enabled'
      USING ERRCODE = '55000';
  END IF;
END;
$authenticate_entry_freeze_authority$;

-- A clean schema replay has no engine to advertise a freeze. Exempt only the
-- exact pristine database; any durable account, club, tournament, table,
-- journal leg or ticket makes this a live-shaped cutover and requires the
-- serialized time-bounded entry predicate.
DO $require_live_terminal_acl_cutover_freeze$
DECLARE
  v_database_is_pristine boolean;
BEGIN
  IF to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL THEN
    RAISE EXCEPTION
      'terminal ACL hardening requires the serialized maintenance predicate first';
  END IF;

  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) INTO v_database_is_pristine;

  IF NOT v_database_is_pristine
     AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'terminal ACL hardening live cutover requires the maintenance entry freeze'
      USING ERRCODE = '55006';
  END IF;
END;
$require_live_terminal_acl_cutover_freeze$;

DO $terminal_acl_prerequisites$
DECLARE
  v_signature text;
  v_required text[] := ARRAY[
    'public.fn_apply_prize_guarantee(uuid,text)',
    'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
    'public.fn_ca_epoch3_preflight()',
    'public.fn_ca_execute_epoch3_reset(text,boolean)',
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',
    'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)',
    'public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)',
    'public.fn_complete_tournament_terminal(uuid,uuid,text)',
    'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
    'public.fn_final_table_deal(uuid)',
    'public.fn_final_table_deal_unguarded_20260907(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)',
    'public.fn_mystery_bounty_pay(uuid)',
    'public.fn_mystery_bounty_pay_unguarded_20260907(uuid)',
    'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)',
    'public.fn_prepare_tournament_place_obligations(uuid,text)',
    'public.fn_register_for_tournament_with_ticket(uuid,uuid)',
    'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
    'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',
    'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
    'public.fn_settle_final_table_deal_atomic(uuid)',
    'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)',
    'public.fn_settle_satellite_finish_atomic(uuid,text)',
    'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
    'public.fn_settle_satellite_tournament(uuid,uuid)',
    'public.fn_settle_tournament_bubble_protection(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places(uuid,uuid)',
    'public.fn_settle_tournament_places_atomic(uuid,text)',
    'public.fn_settle_tournament_rake(uuid,text)'
  ];
BEGIN
  IF to_regprocedure('public.fn_caller_session_is_live()') IS NULL THEN
    RAISE EXCEPTION
      'ticket-spend hardening requires fn_caller_session_is_live()';
  END IF;

  FOREACH v_signature IN ARRAY v_required LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'terminal ACL prerequisite % is missing', v_signature;
    END IF;
  END LOOP;
END;
$terminal_acl_prerequisites$;

-- The authenticated ticket door spends a noncash entry instrument.  A JWT
-- whose server-side session was revoked must fail before the global entry lock
-- and before its owner-only ticket core can lock or mutate any durable row.
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_with_ticket(
  p_tournament_id uuid,
  p_ticket_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $ticket_registration_terminal_gate$
DECLARE
  v_uid uuid := auth.uid();
  v_gate jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION
      'fn_register_for_tournament_with_ticket requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;
  IF public.fn_caller_session_is_live() IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'fn_register_for_tournament_with_ticket requires a live authenticated session'
      USING ERRCODE = '28000';
  END IF;

  v_gate := public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id, NULL, v_uid);
  IF COALESCE((v_gate->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_for_tournament_with_ticket_before_terminal_gate(
    p_tournament_id, p_ticket_id);
END;
$ticket_registration_terminal_gate$;

-- Exact externally callable roots during the DB-first rolling window.  PUBLIC
-- is revoked explicitly because PostgreSQL's default function ACL otherwise
-- grants EXECUTE to every present and future login role.
REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pay(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places_atomic(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places_atomic(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_epoch3_preflight()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_epoch3_preflight()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_execute_epoch3_reset(text,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_execute_epoch3_reset(text,boolean)
  TO service_role;

-- A caller must have both the authenticated role and a live server-side
-- session. service_role remains listed only for a delegated user JWT during
-- the rolling window; a bare service JWT has auth.uid() NULL and is refused.
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid)
  TO authenticated,service_role;

-- These implementations are callable only from SECURITY DEFINER parents.
-- Reacquiring them as the owner does not require a service_role grant.
REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,
  uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_final_table_deal_unguarded_20260907(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pay_unguarded_20260907(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reserve_unguarded_20260907(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  uuid,text,integer,uuid,numeric,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_bubble_protection(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- Pin every SECURITY DEFINER function above to the trusted schema, with the
-- session-local temporary schema explicitly last rather than implicitly first.
ALTER FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_ca_epoch3_preflight()
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_ca_execute_epoch3_reset(text,boolean)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,
  uuid,jsonb,numeric,boolean)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_final_table_deal(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_final_table_deal_unguarded_20260907(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_finalize_bounty_pool(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_pay(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_pay_unguarded_20260907(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_reserve(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_reserve_unguarded_20260907(
  uuid,uuid,jsonb,uuid,text,uuid,integer)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_settle(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_prepare_tournament_place_obligations(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_resolve_satellite_settlement_outcome(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  uuid,text,integer,uuid,numeric,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_bubble_protection(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(
  uuid,text,integer,uuid,numeric,text,text,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_places_atomic(uuid,text)
  SET search_path TO public,pg_temp;
ALTER FUNCTION public.fn_settle_tournament_rake(uuid,text)
  SET search_path TO public,pg_temp;

-- Exact ACL and search-path proof.  The ACL checks inspect aclexplode rather
-- than only the three known Supabase roles, so a forgotten custom grantee also
-- aborts the migration.
DO $terminal_acl_proof$
DECLARE
  v_signature text;
  v_proc regprocedure;
  v_owner oid;
  v_authority_owner oid;
  v_source text;
  v_service_only text[] := ARRAY[
    'public.fn_apply_prize_guarantee(uuid,text)',
    'public.fn_ca_epoch3_preflight()',
    'public.fn_ca_execute_epoch3_reset(text,boolean)',
    'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)',
    'public.fn_complete_tournament_terminal(uuid,uuid,text)',
    'public.fn_final_table_deal(uuid)',
    'public.fn_finalize_bounty_pool(uuid,uuid)',
    'public.fn_mystery_bounty_pay(uuid)',
    'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle(uuid,uuid)',
    'public.fn_prepare_tournament_place_obligations(uuid,text)',
    'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',
    'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
    'public.fn_settle_final_table_deal_atomic(uuid)',
    'public.fn_settle_satellite_finish_atomic(uuid,text)',
    'public.fn_settle_satellite_tournament(uuid,uuid)',
    'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places_atomic(uuid,text)',
    'public.fn_settle_tournament_rake(uuid,text)'
  ];
  v_owner_only text[] := ARRAY[
    'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)',
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',
    'public.fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)',
    'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
    'public.fn_final_table_deal_unguarded_20260907(uuid)',
    'public.fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)',
    'public.fn_mystery_bounty_pay_unguarded_20260907(uuid)',
    'public.fn_mystery_bounty_reserve_unguarded_20260907(uuid,uuid,jsonb,uuid,text,uuid,integer)',
    'public.fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)',
    'public.fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
    'public.fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)',
    'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
    'public.fn_settle_tournament_bubble_protection(uuid,uuid)',
    'public.fn_settle_tournament_final_table_deal(uuid)',
    'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
    'public.fn_settle_tournament_places(uuid,uuid)'
  ];
BEGIN
  SELECT p.proowner INTO v_authority_owner
    FROM pg_proc p
   WHERE p.oid='public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;

  FOREACH v_signature IN ARRAY v_service_only LOOP
    v_proc := to_regprocedure(v_signature);
    SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = v_proc;
    IF NOT has_function_privilege('service_role',v_proc,'EXECUTE')
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(
             COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid=v_proc
            AND upper(a.privilege_type)='EXECUTE'
            AND a.grantee<>ALL(ARRAY[v_owner,'service_role'::regrole::oid])
       ) THEN
      RAISE EXCEPTION '% is not exact owner + service_role EXECUTE',v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY v_owner_only LOOP
    v_proc := to_regprocedure(v_signature);
    SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = v_proc;
    IF has_function_privilege('service_role',v_proc,'EXECUTE')
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR EXISTS (
         SELECT 1
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(
             COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid=v_proc
            AND upper(a.privilege_type)='EXECUTE'
            AND a.grantee<>v_owner
       ) THEN
      RAISE EXCEPTION '% is not exact owner-only EXECUTE',v_signature;
    END IF;
  END LOOP;

  v_proc := 'public.fn_register_for_tournament_with_ticket(uuid,uuid)'::regprocedure;
  SELECT p.proowner,p.prosrc INTO v_owner,v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF NOT has_function_privilege('authenticated',v_proc,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_proc,'EXECUTE')
     OR has_function_privilege('anon',v_proc,'EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=v_proc
          AND upper(a.privilege_type)='EXECUTE'
          AND a.grantee<>ALL(ARRAY[
            v_owner,'authenticated'::regrole::oid,'service_role'::regrole::oid])
     )
     OR position('public.fn_caller_session_is_live()' IN v_source)=0
     OR position('public.fn_caller_session_is_live()' IN v_source) >
        position('public.fn_ca_lock_tournament_seat_acquisition(' IN v_source) THEN
    RAISE EXCEPTION
      'ticket registration lost its exact ACL or pre-lock live-session gate';
  END IF;

  FOREACH v_signature IN ARRAY v_service_only||v_owner_only||ARRAY[
    'public.fn_register_for_tournament_with_ticket(uuid,uuid)'
  ] LOOP
    v_proc := to_regprocedure(v_signature);
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid=v_proc AND p.prosecdef
         AND p.proowner=v_authority_owner
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION
        '% lost the common authority owner, SECURITY DEFINER or its fixed search_path',
        v_signature;
    END IF;
  END LOOP;
END;
$terminal_acl_proof$;

COMMENT ON FUNCTION public.fn_register_for_tournament_with_ticket(uuid,uuid) IS
  'Authenticated ticket-spend root. Requires auth.uid plus a live server-side session before the shared seat-acquisition lock; the exact ticket core remains owner-only.';

DO $verify_live_terminal_acl_cutover_freeze_still_held$
BEGIN
  IF (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'terminal ACL hardening live cutover freeze expired before commit'
      USING ERRCODE = '55006';
  END IF;
END;
$verify_live_terminal_acl_cutover_freeze_still_held$;

COMMIT;
