-- THE FOUR-TABLE LIMIT IS NEVER SATELLITE CASH (2026-09-09)
--
-- Migration 20260909061414 taught the rolling legacy satellite helper to turn
-- a FOUR TABLE LIMIT refusal into wallet chips. That is not the product
-- contract. A full seat that cannot be booked because its winner is already
-- at the concurrent-game cap remains a noncash tournament-entry award. The
-- replacement fn_settle_satellite_tournament authority issues that durable
-- ticket. While old engines drain, this legacy helper must fail closed and let
-- the cap exception abort the transaction; it must never manufacture cash.
--
-- This is an explicit forward replacement from the last canonical definition
-- in 20260909014534. The already-applied 061414 migration remains immutable
-- incident evidence. There is no watcher, reconciler, retry loop or backfill.
--
-- IRREVERSIBLE POLICY CORRECTION: production rollback is another reviewed
-- forward migration. Reintroducing the cap-to-cash conversion is forbidden.

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';

-- Drain the rolling helper under the same root it is required to take, then
-- pin the maintenance freeze before changing its executable body. A pristine
-- source-controlled database has no engine-owned freeze row; that exact empty
-- shape is the only exception.
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
       AND md5(p.prosrc) = 'cff283a255830f34ad7488bbfbf70bc6'
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

DO $require_live_cap_correction_freeze$
DECLARE
  v_database_is_pristine boolean;
BEGIN
  IF to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL THEN
    RAISE EXCEPTION
      'satellite cap correction requires the serialized maintenance predicate first';
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
      'satellite cap correction live cutover requires the maintenance entry freeze'
      USING ERRCODE = '55006';
  END IF;
END;
$require_live_cap_correction_freeze$;

DO $prerequisite$
DECLARE
  v_source_md5 text;
BEGIN
  IF to_regprocedure(
       'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'legacy satellite cap correction requires the rolling delivery authority';
  END IF;

  SELECT md5(p.prosrc)
    INTO v_source_md5
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)'::regprocedure;
  IF v_source_md5 NOT IN (
       -- Exact production 061414 cohort after its intervening rolling changes.
       '64742412685d5773553c4d234a3b1d41',
       -- Exact clean-replay 061414 cohort built from the later locked helper.
       '16216c0bc04a962e32010ad140ef123e',
       -- Exact already-canonical definition; rerunning remains harmless.
       '9c764ebc72a6d331a26c812b58d613de'
     ) THEN
    RAISE EXCEPTION
      'legacy satellite delivery source drifted before cap correction (md5=%)',
      COALESCE(v_source_md5,'missing') USING ERRCODE = '55000';
  END IF;
END;
$prerequisite$;

-- Keep the pre-replacement owner as transaction-local proof. Depending on the
-- new terminal authority here would make this forward correction impossible
-- to apply independently on a rolling environment where 061414 is already
-- live but the stage-one authority has not yet been installed.
CREATE TEMP TABLE ca_legacy_satellite_delivery_install_guard
  ON COMMIT DROP
AS
SELECT p.proowner AS owner_oid
  FROM pg_proc p
 WHERE p.oid =
   'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)'::regprocedure;

CREATE OR REPLACE FUNCTION public.fn_deliver_satellite_ticket_exact(p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text, p_position integer, p_ticket_value numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target public.tournaments%ROWTYPE;
  v_existing public.tournament_players%ROWTYPE;
  v_before_target_pool numeric;
  v_before_target_bounty numeric;
  v_split record;
  v_before_target_rake numeric;
  v_before_source_pool numeric;
  v_open boolean:=false;
  v_count integer;
  v_result jsonb;
  v_registration uuid;
  v_payout uuid;
  v_payout_meta jsonb;
  v_ledger_count integer;
  v_rake_count integer;
  v_target_buyin numeric;
  v_target_fee numeric;
  v_cash_reason text:='target_not_open';
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_target FROM public.tournaments
   WHERE id=p_target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('delivery','cash','reason','target_missing'); END IF;
  SELECT count(*)::integer INTO v_count FROM public.tournament_players
   WHERE tournament_id=p_target_id;
  v_open:=CASE
    WHEN v_target.status IN ('ANNOUNCED','REGISTERING')
      THEN NOT COALESCE(v_target.prize_pool_finalized,false)
    WHEN v_target.status='RUNNING'
      THEN public.fn_tournament_late_registration_open(p_target_id)
    ELSE false END;
  v_open:=v_open AND (v_target.max_players IS NULL OR v_count<v_target.max_players);
  IF round(GREATEST(COALESCE(v_target.buy_in_amount,0),0)
           +GREATEST(COALESCE(v_target.buy_in_fee,0),0),2)
       <>round(p_ticket_value,2) THEN
    -- The winner owns the frozen advertised value. Never call the historical
    -- seat RPC at a later, different target price: it would debit the source by
    -- today's price. Cash the frozen value instead.
    v_open:=false;
    v_cash_reason:='target_economics_changed';
  END IF;

  SELECT * INTO v_existing FROM public.tournament_players
   WHERE tournament_id=p_target_id AND user_id=p_user_id FOR UPDATE;
  IF FOUND THEN
    IF COALESCE(v_existing.is_satellite_qualifier,false)
       AND v_existing.source_satellite_id=p_satellite_id THEN
      SELECT count(*)::integer,(array_agg(po.id ORDER BY po.id))[1],
             (array_agg(po.metadata ORDER BY po.id))[1]
        INTO v_count,v_payout,v_payout_meta
        FROM public.tournament_payouts po
       WHERE po.tournament_id=p_satellite_id AND po.user_id=p_user_id
         AND po.position=p_position AND po.source='satellite_seat'
         AND round(po.amount,2)=round(p_ticket_value,2)
         AND po.metadata->>'registration_id'=v_existing.id::text;
      v_target_buyin:=CASE
        WHEN COALESCE(v_payout_meta->>'target_buy_in','')~'^[0-9]+([.][0-9]+)?$'
          THEN (v_payout_meta->>'target_buy_in')::numeric ELSE -1 END;
      v_target_fee:=CASE
        WHEN COALESCE(v_payout_meta->>'target_fee','')~'^[0-9]+([.][0-9]+)?$'
          THEN (v_payout_meta->>'target_fee')::numeric ELSE -1 END;
      SELECT count(*)::integer INTO v_ledger_count
        FROM public.chip_ledger l
       WHERE l.idempotency_key='tourney:'||p_satellite_id::text||':seat:'
                               ||p_user_id::text||':pool_transfer'
         AND l.from_type='prize_liability' AND l.from_entity_id=p_satellite_id
         AND l.to_type='prize_liability' AND l.to_entity_id=p_target_id
         AND round(l.amount,2)=round(p_ticket_value,2)
         AND l.metadata->>'registration_id'=v_existing.id::text
         AND CASE WHEN COALESCE(l.metadata->>'moved','')~'^[0-9]+([.][0-9]+)?$'
                  THEN round((l.metadata->>'moved')::numeric,2) ELSE -1 END
             =round(p_ticket_value,2)
         AND CASE WHEN COALESCE(l.metadata->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                  THEN round((l.metadata->>'unbacked')::numeric,2) ELSE -1 END=0;
      SELECT count(*)::integer INTO v_rake_count
        FROM public.rake_records rr
       WHERE rr.tournament_id=p_target_id AND rr.source='fn_award_satellite_seat'
         AND rr.metadata->>'satellite_id'=p_satellite_id::text
         AND rr.metadata->>'user_id'=p_user_id::text
         AND rr.metadata->>'registration_id'=v_existing.id::text
         AND round(rr.rake_amount,2)=round(v_target_fee,2)
         AND round(COALESCE(rr.pot_size,0),2)=round(p_ticket_value,2);
      IF v_count<>1
         OR (CASE WHEN COALESCE(v_payout_meta->>'pool_transfer','')~'^[0-9]+([.][0-9]+)?$'
                 THEN round((v_payout_meta->>'pool_transfer')::numeric,2) ELSE -1 END)
            <>round(p_ticket_value,2)
         OR (CASE WHEN COALESCE(v_payout_meta->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                 THEN round((v_payout_meta->>'unbacked')::numeric,2) ELSE -1 END)<>0
         OR round(v_target_buyin+v_target_fee,2)<>round(p_ticket_value,2)
         OR v_ledger_count<>1
         OR (v_target_fee>0 AND v_rake_count<>1)
         OR (v_target_fee=0 AND v_rake_count<>0) THEN
        RAISE EXCEPTION 'existing target seat has no exact fully-backed payout event'
          USING ERRCODE='check_violation';
      END IF;
      RETURN jsonb_build_object('delivery','seat','already',true,
        'registration_id',v_existing.id,'payout_id',v_payout);
    ELSIF COALESCE(v_existing.is_satellite_qualifier,false)
          AND v_existing.source_satellite_id IS NULL THEN
      RAISE EXCEPTION 'existing target satellite seat has ambiguous origin'
        USING ERRCODE='check_violation';
    ELSE
      RETURN jsonb_build_object('delivery','cash','reason','seat_already_held_elsewhere');
    END IF;
  END IF;
  IF NOT v_open THEN
    RETURN jsonb_build_object('delivery','cash','reason',v_cash_reason);
  END IF;

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_target.buy_in_amount,v_target.buy_in_fee,v_target.bounty_amount,
    COALESCE(v_target.is_bounty,false) OR COALESCE(v_target.is_pko,false) OR COALESCE(v_target.is_mystery_bounty,false));
  v_before_target_bounty:=round(COALESCE(v_target.bounty_pool,0),2);
  v_before_target_pool:=round(COALESCE(v_target.prize_pool,0),2);
  v_before_target_rake:=round(COALESCE(v_target.total_rake,0),2);
  SELECT round(COALESCE(t.prize_pool,0),2) INTO v_before_source_pool
    FROM public.tournaments t WHERE t.id=p_satellite_id FOR UPDATE;
  IF v_before_source_pool+0.005<round(p_ticket_value,2) THEN
    RAISE EXCEPTION 'satellite guarantee is not funded for its frozen ticket'
      USING ERRCODE='check_violation';
  END IF;

  v_result:=public.fn_award_satellite_seat(
    p_satellite_id,p_target_id,p_user_id,p_username,p_position);
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'awarded')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'pool_transfer')::numeric,-1)
          <>round(p_ticket_value,2)
     OR COALESCE((v_result->>'unbacked')::numeric,-1)<>0 THEN
    RAISE EXCEPTION 'exact target-seat award refused or wrote incomplete money: %',
      COALESCE(v_result::text,'null') USING ERRCODE='check_violation';
  END IF;
  v_registration:=(v_result->>'registration_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.id=v_registration AND tp.tournament_id=p_target_id
       AND tp.user_id=p_user_id AND tp.source_satellite_id=p_satellite_id
       AND COALESCE(tp.is_satellite_qualifier,false)
  ) THEN
    RAISE EXCEPTION 'seat helper returned without the exact target registration'
      USING ERRCODE='check_violation';
  END IF;
  SELECT count(*)::integer,(array_agg(po.id ORDER BY po.id))[1] INTO v_count,v_payout
    FROM public.tournament_payouts po
   WHERE po.tournament_id=p_satellite_id AND po.user_id=p_user_id
     AND po.position=p_position AND po.source='satellite_seat'
     AND round(po.amount,2)=round(p_ticket_value,2)
     AND po.metadata->>'registration_id'=v_registration::text
     AND round(COALESCE((po.metadata->>'pool_transfer')::numeric,-1),2)
          =round(p_ticket_value,2)
     AND round(COALESCE((po.metadata->>'unbacked')::numeric,-1),2)=0;
  IF v_count<>1
     OR (SELECT round(COALESCE(t.prize_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id)
          <>v_before_target_pool+v_split.prize
     OR (SELECT round(COALESCE(t.bounty_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id) <>v_before_target_bounty+v_split.bounty
     OR (SELECT round(COALESCE(t.total_rake,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id)
          <>v_before_target_rake+round(COALESCE(v_target.buy_in_fee,0),2)
     OR (SELECT round(COALESCE(t.prize_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_satellite_id)
          <>v_before_source_pool-round(p_ticket_value,2) THEN
    RAISE EXCEPTION 'target seat, payout and pool transfer are not one exact event'
      USING ERRCODE='check_violation';
  END IF;
  RETURN jsonb_build_object('delivery','seat','already',false,
    'registration_id',v_registration,'payout_id',v_payout);
END;
$function$;

-- CREATE OR REPLACE preserves the existing owner and ACL. Restate the exact
-- owner-only boundary so PUBLIC defaults or earlier rolling grants cannot make
-- this implementation a browser, authenticated-user or service-role RPC.
REVOKE ALL ON FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postcondition$
DECLARE
  v_proc regprocedure :=
    'public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)'::regprocedure;
  v_source text;
  v_owner oid;
  v_expected_owner oid;
BEGIN
  SELECT p.prosrc, p.proowner
    INTO v_source, v_owner
    FROM pg_proc p
   WHERE p.oid = v_proc;
  SELECT g.owner_oid
    INTO STRICT v_expected_owner
    FROM pg_temp.ca_legacy_satellite_delivery_install_guard g;

  IF v_source IS NULL
     OR position('winner_at_concurrent_game_cap' IN v_source) > 0
     OR position('EXCEPTION WHEN check_violation' IN v_source) > 0
     OR position('SQLERRM LIKE ''%FOUR TABLE LIMIT%''' IN v_source) > 0
     OR position('v_result:=public.fn_award_satellite_seat(' IN v_source) = 0
     OR position('target_missing' IN v_source) = 0
     OR position('target_not_open' IN v_source) = 0
     OR position('target_economics_changed' IN v_source) = 0
     OR position('seat_already_held_elsewhere' IN v_source) = 0
     OR position('exact target-seat award refused or wrote incomplete money' IN v_source) = 0
     OR position('target seat, payout and pool transfer are not one exact event' IN v_source) = 0 THEN
    RAISE EXCEPTION
      'legacy satellite delivery still cashes the cap or lost a prior fail-closed contract';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = v_proc
          AND p.prosecdef
          AND p.proowner = v_expected_owner
          AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
     )
     OR v_owner IS DISTINCT FROM v_expected_owner
     OR has_function_privilege('anon', v_proc, 'EXECUTE')
     OR has_function_privilege('authenticated', v_proc, 'EXECUTE')
     OR has_function_privilege('service_role', v_proc, 'EXECUTE')
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE p.oid = v_proc
          AND upper(acl.privilege_type) = 'EXECUTE'
          AND acl.grantee <> p.proowner
     ) THEN
    RAISE EXCEPTION
      'legacy satellite delivery lost its owner, search_path or owner-only ACL';
  END IF;
END;
$postcondition$;

COMMENT ON FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric) IS
  'Rolling legacy satellite delivery helper. FOUR TABLE LIMIT and every other seat-award refusal abort atomically; cap-blocked full awards are noncash tickets only in fn_settle_satellite_tournament.';

DO $cap_correction_freeze_remains$
DECLARE
  v_database_is_pristine boolean;
BEGIN
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
      'satellite cap correction maintenance entry freeze expired before commit'
      USING ERRCODE = '55006';
  END IF;
END;
$cap_correction_freeze_remains$;

COMMIT;
