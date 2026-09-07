-- A SATELLITE FINISH PAYS ONE FROZEN ENTITLEMENT PLAN OR COMPLETES NOBODY.
--
-- `tournaments.payout_structure` remains the canonical display/non-satellite
-- ladder frozen when entry closes.  It is not a satellite prize promise:
-- satellites owe target seats (or their exact cash value) plus one possible
-- cash remainder.  This migration freezes that distinct promise once, makes
-- hand-for-hand read its depth, and makes the terminal payer consume the same
-- rows.  A partial seat/cash loop can no longer precede a durable COMPLETED
-- flag.

BEGIN;
SET LOCAL lock_timeout = '250ms';

DO $dependencies$
BEGIN
  IF to_regclass('public.tournament_entry_close_receipts') IS NULL
     OR to_regclass('public.managed_game_contract_versions') IS NULL
     OR to_regprocedure(
          'public.fn_managed_game_contract_document(text,jsonb)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_managed_game_contract_hash(jsonb)'
        ) IS NULL
     OR to_regprocedure('public.fn_tournament_late_registration_open(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'
        ) IS NULL
     OR to_regclass('public.tournament_escrow') IS NULL
     OR to_regclass('public.tournament_rake_settlements') IS NULL
     OR to_regclass('public.tournament_bounty_completion_receipts') IS NULL
     OR to_regprocedure('public.fn_tournament_has_unsettled_bounties(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'entry-close, obligation and satellite-seat migrations must precede atomic satellite settlement';
  END IF;
END;
$dependencies$;

-- A target's buy-in can legitimately change after a feeder is published. The
-- price funded when this satellite starts is the promise; the target's price
-- at finish is not. Capture the exact source/target contract and unit ticket
-- value in the same UPDATE statement as the existing overlay trigger. Trigger
-- names are ordered, and `zzzz_...` runs after `zz_ca_fund_overlay_on_lock`, so
-- funded_source_pool is the post-overlay value from that same MVCC snapshot.
CREATE TABLE IF NOT EXISTS public.tournament_satellite_economic_snapshots (
  tournament_id uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  target_tournament_id uuid
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  configured_seats integer NOT NULL CHECK (configured_seats >= 0),
  ticket_value numeric(15,2) NOT NULL CHECK (ticket_value >= 0),
  promised_seat_value numeric(15,2) NOT NULL CHECK (promised_seat_value >= 0),
  funded_source_pool numeric(15,2),
  source_contract_hash text NOT NULL CHECK (source_contract_hash ~ '^[0-9a-f]{64}$'),
  target_contract_hash text CHECK (target_contract_hash ~ '^[0-9a-f]{64}$'),
  source_started_at timestamptz,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  capture_source text NOT NULL
    CHECK (capture_source IN ('start_trigger','contract_history')),
  CHECK (promised_seat_value=round(configured_seats*ticket_value,2)),
  CHECK (
    (target_tournament_id IS NULL AND ticket_value=0
      AND target_contract_hash IS NULL AND configured_seats=0)
    OR
    (target_tournament_id IS NOT NULL AND ticket_value>0
      AND target_contract_hash IS NOT NULL)
  ),
  CHECK (funded_source_pool IS NULL OR funded_source_pool>=promised_seat_value)
);

CREATE TABLE IF NOT EXISTS public.tournament_satellite_entitlements (
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position > 0),
  target_tournament_id uuid
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  award_kind text NOT NULL
    CHECK (award_kind IN ('seat_or_cash','cash')),
  ticket_value numeric(15,2) NOT NULL DEFAULT 0 CHECK (ticket_value >= 0),
  remainder_value numeric(15,2) NOT NULL DEFAULT 0 CHECK (remainder_value >= 0),
  source_pool numeric(15,2) NOT NULL CHECK (source_pool >= 0),
  entry_closed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tournament_id,position),
  CHECK (
    (award_kind='seat_or_cash' AND target_tournament_id IS NOT NULL
      AND ticket_value>0)
    OR
    (award_kind='cash' AND ticket_value=0 AND remainder_value>0)
  )
);

CREATE TABLE IF NOT EXISTS public.tournament_satellite_settlement_batches (
  tournament_id uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  winner_user_id uuid NOT NULL,
  target_tournament_id uuid
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  plan_fingerprint text NOT NULL CHECK (plan_fingerprint ~ '^[0-9a-f]{32}$'),
  entitlement_count integer NOT NULL CHECK (entitlement_count >= 0),
  award_depth integer NOT NULL CHECK (award_depth >= 0),
  amount_owed numeric(15,2) NOT NULL CHECK (amount_owed >= 0),
  source text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(outcomes)='array'),
  CHECK ((settled_at IS NULL AND outcomes='[]'::jsonb) OR settled_at IS NOT NULL),
  CHECK ((entitlement_count=0 AND award_depth=0)
         OR (entitlement_count=award_depth AND award_depth>0))
);

ALTER TABLE public.tournament_satellite_economic_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_satellite_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_satellite_settlement_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_satellite_economic_snapshots
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.tournament_satellite_entitlements
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.tournament_satellite_settlement_batches
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.tournament_satellite_economic_snapshots TO service_role;
GRANT SELECT ON public.tournament_satellite_entitlements TO service_role;
GRANT SELECT ON public.tournament_satellite_settlement_batches TO service_role;

COMMENT ON TABLE public.tournament_satellite_economic_snapshots IS
  'Immutable price/seat promise captured from the source start statement after its guarantee overlay. Finish never reprices a ticket from mutable target state.';
COMMENT ON TABLE public.tournament_satellite_entitlements IS
  'Immutable entry-close satellite award plan. One position may carry both a ticket value and the residual cash that belongs to the last seat winner in a short field.';
COMMENT ON TABLE public.tournament_satellite_settlement_batches IS
  'All-or-none satellite finish receipt. settled_at proves every frozen entitlement and the COMPLETED transition committed in one transaction.';

CREATE OR REPLACE FUNCTION public.trg_freeze_satellite_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'a frozen satellite entitlement cannot be %',lower(TG_OP)
    USING ERRCODE='check_violation';
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_freeze_satellite_economic_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'a frozen satellite economic snapshot cannot be %',lower(TG_OP)
    USING ERRCODE='check_violation';
END;
$function$;

DROP TRIGGER IF EXISTS zzzz_freeze_satellite_economic_snapshot
  ON public.tournament_satellite_economic_snapshots;
CREATE TRIGGER zzzz_freeze_satellite_economic_snapshot
BEFORE UPDATE OR DELETE ON public.tournament_satellite_economic_snapshots
FOR EACH ROW EXECUTE FUNCTION public.trg_freeze_satellite_economic_snapshot();

DROP TRIGGER IF EXISTS zzzz_freeze_satellite_entitlement
  ON public.tournament_satellite_entitlements;
CREATE TRIGGER zzzz_freeze_satellite_entitlement
BEFORE UPDATE OR DELETE ON public.tournament_satellite_entitlements
FOR EACH ROW EXECUTE FUNCTION public.trg_freeze_satellite_entitlement();

CREATE OR REPLACE FUNCTION public.trg_freeze_satellite_settlement_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_gate text := COALESCE(
    current_setting('app.atomic_satellite_settlement',true),'');
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'an atomic satellite settlement receipt cannot be deleted'
      USING ERRCODE='check_violation';
  END IF;
  IF ROW(NEW.tournament_id,NEW.winner_user_id,NEW.target_tournament_id,
         NEW.plan_fingerprint,NEW.entitlement_count,NEW.award_depth,
         NEW.amount_owed,NEW.source,NEW.prepared_at)
     IS DISTINCT FROM
     ROW(OLD.tournament_id,OLD.winner_user_id,OLD.target_tournament_id,
         OLD.plan_fingerprint,OLD.entitlement_count,OLD.award_depth,
         OLD.amount_owed,OLD.source,OLD.prepared_at) THEN
    RAISE EXCEPTION 'an atomic satellite plan identity cannot change'
      USING ERRCODE='check_violation';
  END IF;
  IF OLD.settled_at IS NOT NULL
     AND ROW(NEW.settled_at,NEW.outcomes)
         IS DISTINCT FROM ROW(OLD.settled_at,OLD.outcomes) THEN
    RAISE EXCEPTION 'a settled satellite receipt is immutable'
      USING ERRCODE='check_violation';
  END IF;
  IF v_gate<>OLD.tournament_id::text THEN
    RAISE EXCEPTION 'satellite batch writes belong to the atomic finalizer'
      USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zzzz_freeze_satellite_settlement_batch
  ON public.tournament_satellite_settlement_batches;
CREATE TRIGGER zzzz_freeze_satellite_settlement_batch
BEFORE UPDATE OR DELETE ON public.tournament_satellite_settlement_batches
FOR EACH ROW EXECUTE FUNCTION public.trg_freeze_satellite_settlement_batch();

-- The previous seat helper had a second, level-only interpretation of a
-- RUNNING target's entry window. Replace exactly that block with the database
-- authority installed by 20260907204500. This is an asserted source rewrite:
-- an unexpected deployed definition refuses the migration instead of silently
-- leaving the divergent gate in place.
DO $unify_satellite_target_entry_window$
DECLARE
  v_def text;
  v_old text := $old$
  -- Mirror of server/src/tournament/satelliteTargetOpen.ts, which is the
  -- authority the engine consults BEFORE calling this. The two must agree:
  -- ANNOUNCED/REGISTERING are open; RUNNING is open only inside late
  -- registration (late_reg_levels, falling back to rebuy_levels, both
  -- meaning "no late reg" when 0/NULL); everything else is closed.
  IF v_t.status IN ('ANNOUNCED', 'REGISTERING') THEN
    NULL; -- open
  ELSIF v_t.status = 'RUNNING' THEN
    v_cap := COALESCE(NULLIF(v_t.late_reg_levels, 0), NULLIF(v_t.rebuy_levels, 0), 0);
    IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) >= v_cap THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
  END IF;

  -- A FINALIZED POOL IS A CLOSED DOOR (2026-08-31). fn_register_for_tournament
  -- refuses on this flag and isLateRegClosed() returns true on it regardless of
  -- level; it is the platform's single statement that the pool has stopped
  -- moving, and the payout ladder is sized against it. Adding a buy-in after it
  -- is set pays a ladder that was built without that buy-in.
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_pool_finalized');
  END IF;

  IF v_t.max_players IS NOT NULL
     AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_full');
  END IF;
$old$;
  v_new text := $new$
  -- One database predicate owns level-based and minutes-only late entry.
  -- ANNOUNCED/REGISTERING targets are open until their pool is finalized;
  -- RUNNING targets must pass the same locked gate as a paid registrant.
  IF v_t.status IN ('ANNOUNCED','REGISTERING') THEN
    IF COALESCE(v_t.prize_pool_finalized,false) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
    END IF;
  ELSIF v_t.status='RUNNING' THEN
    IF NOT public.fn_tournament_late_registration_open(p_target_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok',false,'reason','target_closed');
  END IF;

  SELECT count(*) INTO v_field
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_target_id;
  IF v_t.max_players IS NOT NULL AND v_field>=v_t.max_players THEN
    RETURN jsonb_build_object('ok',false,'reason','target_full');
  END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure)
    INTO v_def;
  IF position(v_new IN v_def)>0 THEN
    RETURN;
  END IF;
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN
    RAISE EXCEPTION
      'fn_award_satellite_seat entry-window block did not match exactly once';
  END IF;
  EXECUTE replace(v_def,v_old,v_new);
END;
$unify_satellite_target_entry_window$;

CREATE OR REPLACE FUNCTION public.trg_capture_satellite_economics_on_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_is_start boolean;
  v_is_satellite boolean;
  v_target public.tournaments%ROWTYPE;
  v_target_id uuid;
  v_seats integer;
  v_ticket numeric;
  v_required numeric;
  v_source_hash text;
  v_target_hash text;
  v_existing public.tournament_satellite_economic_snapshots%ROWTYPE;
BEGIN
  v_is_start := CASE
    WHEN TG_OP='INSERT' THEN upper(COALESCE(NEW.status,'')) IN
      ('RUNNING','COMPLETING','COMPLETED')
    ELSE upper(COALESCE(NEW.status,'')) IN ('RUNNING','COMPLETING','COMPLETED')
      AND upper(COALESCE(OLD.status,'')) NOT IN ('RUNNING','COMPLETING','COMPLETED')
  END;
  IF NOT v_is_start THEN RETURN NEW; END IF;
  v_is_satellite := lower(COALESCE(NEW.variant,''))='satellite'
    OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE'
    OR NEW.satellite_target_id IS NOT NULL;
  IF NOT v_is_satellite THEN RETURN NEW; END IF;

  v_target_id:=NEW.satellite_target_id;
  v_seats:=GREATEST(COALESCE(NEW.satellite_seats,0),0);
  IF v_target_id=NEW.id THEN
    RAISE EXCEPTION 'a satellite cannot target itself' USING ERRCODE='check_violation';
  END IF;
  IF v_target_id IS NULL THEN
    IF v_seats>0 THEN
      RAISE EXCEPTION 'a satellite cannot guarantee seats without a target'
        USING ERRCODE='check_violation';
    END IF;
    v_ticket:=0;
    v_target_hash:=NULL;
  ELSE
    -- Deliberately no target row lock. Every BEFORE trigger in this source
    -- start statement sees the same command snapshot, including the guarantee
    -- overlay that priced/funded the seat. Avoiding a target lock also prevents
    -- a source->target lock inversion with finish's target->source order.
    SELECT * INTO v_target FROM public.tournaments WHERE id=v_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'satellite target is missing' USING ERRCODE='foreign_key_violation';
    END IF;
    v_ticket:=round(GREATEST(COALESCE(v_target.buy_in_amount,0),0)
                    +GREATEST(COALESCE(v_target.buy_in_fee,0),0),2);
    IF v_ticket<=0 THEN
      RAISE EXCEPTION 'satellite target ticket value must be positive'
        USING ERRCODE='check_violation';
    END IF;
    v_target_hash:=public.fn_managed_game_contract_hash(
      public.fn_managed_game_contract_document('tournament',to_jsonb(v_target)));
  END IF;
  v_required:=round(v_seats*v_ticket,2);
  IF round(COALESCE(NEW.prize_pool,0),2)<v_required THEN
    RAISE EXCEPTION
      'satellite cannot start: funded pool % is below advertised seat promise %',
      round(COALESCE(NEW.prize_pool,0),2),v_required
      USING ERRCODE='check_violation';
  END IF;
  v_source_hash:=public.fn_managed_game_contract_hash(
    public.fn_managed_game_contract_document('tournament',to_jsonb(NEW)));

  INSERT INTO public.tournament_satellite_economic_snapshots(
    tournament_id,target_tournament_id,configured_seats,ticket_value,
    promised_seat_value,funded_source_pool,source_contract_hash,
    target_contract_hash,source_started_at,capture_source)
  VALUES (
    NEW.id,v_target_id,v_seats,v_ticket,v_required,
    round(COALESCE(NEW.prize_pool,0),2),v_source_hash,v_target_hash,
    NEW.started_at,'start_trigger')
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT * INTO v_existing
    FROM public.tournament_satellite_economic_snapshots
   WHERE tournament_id=NEW.id;
  IF ROW(v_existing.target_tournament_id,v_existing.configured_seats,
         v_existing.ticket_value,v_existing.promised_seat_value,
         v_existing.source_contract_hash,v_existing.target_contract_hash)
     IS DISTINCT FROM
     ROW(v_target_id,v_seats,v_ticket,v_required,v_source_hash,v_target_hash) THEN
    RAISE EXCEPTION 'satellite start conflicts with its frozen economic promise'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zzzz_capture_satellite_economics_on_start
  ON public.tournaments;
CREATE TRIGGER zzzz_capture_satellite_economics_on_start
BEFORE INSERT OR UPDATE OF status ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.trg_capture_satellite_economics_on_start();

-- 20260902110000 has immutable, hashed advertised contracts for every game.
-- Use only versions that existed no later than the source's actual start, so a
-- migration installed over a live tournament cannot accidentally bless today's
-- edited target price as yesterday's promise. An unprovable legacy source is
-- intentionally left without a snapshot and its entry-close/finish paths fail
-- closed instead of inventing an economic contract.
INSERT INTO public.tournament_satellite_economic_snapshots(
  tournament_id,target_tournament_id,configured_seats,ticket_value,
  promised_seat_value,funded_source_pool,source_contract_hash,
  target_contract_hash,source_started_at,capture_source)
SELECT s.id,
       (sv.contract->>'satellite_target_id')::uuid,
       (sv.contract->>'satellite_seats')::integer,
       round((tv.contract->>'buy_in_amount')::numeric
             +(tv.contract->>'buy_in_fee')::numeric,2),
       round((sv.contract->>'satellite_seats')::integer
             *((tv.contract->>'buy_in_amount')::numeric
               +(tv.contract->>'buy_in_fee')::numeric),2),
       NULL,sv.contract_hash,tv.contract_hash,s.started_at,'contract_history'
  FROM public.tournaments s
  JOIN LATERAL (
    SELECT v.contract,v.contract_hash,v.published_at
      FROM public.managed_game_contract_versions v
     WHERE v.game_kind='tournament' AND v.game_id=s.id
       AND s.started_at IS NOT NULL AND v.published_at<=s.started_at
       AND COALESCE(v.contract->>'satellite_target_id','')~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND COALESCE(v.contract->>'satellite_seats','')~'^[0-9]+$'
     ORDER BY v.published_at DESC,v.version DESC LIMIT 1
  ) sv ON true
  JOIN LATERAL (
    SELECT v.contract,v.contract_hash
      FROM public.managed_game_contract_versions v
     WHERE v.game_kind='tournament'
       AND v.game_id=(sv.contract->>'satellite_target_id')::uuid
       AND v.published_at<=s.started_at
       AND COALESCE(v.contract->>'buy_in_amount','')~'^[0-9]+([.][0-9]+)?$'
       AND COALESCE(v.contract->>'buy_in_fee','')~'^[0-9]+([.][0-9]+)?$'
       AND (v.contract->>'buy_in_amount')::numeric
           +(v.contract->>'buy_in_fee')::numeric>0
     ORDER BY v.published_at DESC,v.version DESC LIMIT 1
  ) tv ON true
 WHERE upper(COALESCE(s.status,'')) IN ('RUNNING','COMPLETING')
   AND (lower(COALESCE(s.variant,''))='satellite'
     OR upper(COALESCE(s.tournament_type,''))='SATELLITE'
     OR s.satellite_target_id IS NOT NULL)
ON CONFLICT (tournament_id) DO NOTHING;

DO $assert_active_satellite_economics$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.tournament_entry_close_receipts r
      JOIN public.tournaments t ON t.id=r.tournament_id
      LEFT JOIN public.tournament_satellite_economic_snapshots s
        ON s.tournament_id=t.id
     WHERE s.tournament_id IS NULL
       AND upper(COALESCE(t.status,'')) IN ('RUNNING','COMPLETING')
       AND (lower(COALESCE(t.variant,''))='satellite'
         OR upper(COALESCE(t.tournament_type,''))='SATELLITE'
         OR t.satellite_target_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'an active satellite entry-close receipt has no provable start-time economics';
  END IF;
END;
$assert_active_satellite_economics$;

CREATE OR REPLACE FUNCTION public.trg_require_satellite_economics_at_entry_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id=NEW.tournament_id
       AND (lower(COALESCE(t.variant,''))='satellite'
         OR upper(COALESCE(t.tournament_type,''))='SATELLITE'
         OR t.satellite_target_id IS NOT NULL)
  ) AND NOT EXISTS (
    SELECT 1 FROM public.tournament_satellite_economic_snapshots s
     WHERE s.tournament_id=NEW.tournament_id
  ) THEN
    RAISE EXCEPTION 'satellite entry close has no provable start-time economics'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS aaa_require_satellite_economics_at_entry_close
  ON public.tournament_entry_close_receipts;
CREATE TRIGGER aaa_require_satellite_economics_at_entry_close
BEFORE INSERT ON public.tournament_entry_close_receipts
FOR EACH ROW EXECUTE FUNCTION public.trg_require_satellite_economics_at_entry_close();

CREATE OR REPLACE FUNCTION public.fn_materialize_satellite_entitlements_locked(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_hint record;
  v_t public.tournaments%ROWTYPE;
  v_target public.tournaments%ROWTYPE;
  v_economics public.tournament_satellite_economic_snapshots%ROWTYPE;
  v_receipt public.tournament_entry_close_receipts%ROWTYPE;
  v_is_satellite boolean;
  v_field integer;
  v_pool numeric;
  v_ticket numeric := 0;
  v_configured integer;
  v_seats integer := 0;
  v_remainder numeric := 0;
  v_remainder_position integer;
  v_expected_depth integer := 0;
  v_existing integer;
  v_bad integer;
  i integer;
BEGIN
  SELECT t.id,t.satellite_target_id,t.variant,t.tournament_type
    INTO v_hint FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  v_is_satellite := lower(COALESCE(v_hint.variant,''))='satellite'
    OR upper(COALESCE(v_hint.tournament_type,''))='SATELLITE'
    OR v_hint.satellite_target_id IS NOT NULL;
  IF NOT v_is_satellite THEN
    RETURN jsonb_build_object('ok',true,'is_satellite',false,'ready',true,
                              'award_depth',0);
  END IF;
  IF v_hint.satellite_target_id=p_tournament_id THEN
    RETURN jsonb_build_object('ok',false,'is_satellite',true,
                              'reason','satellite_targets_itself');
  END IF;

  SELECT * INTO v_economics
    FROM public.tournament_satellite_economic_snapshots e
   WHERE e.tournament_id=p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'is_satellite',true,'ready',false,
                              'reason','start_economics_unproven');
  END IF;

  -- Global lock order: frozen target, then source. FOR UPDATE (not FOR KEY SHARE)
  -- conflicts with every registration and completion writer and avoids a
  -- lock-upgrade deadlock between two lazy materializers/finalizers.
  IF v_economics.target_tournament_id IS NOT NULL THEN
    SELECT * INTO v_target FROM public.tournaments
     WHERE id=v_economics.target_tournament_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'is_satellite',true,'ready',false,
                                'reason','frozen_target_missing');
    END IF;
  END IF;
  SELECT * INTO v_t FROM public.tournaments
   WHERE id=p_tournament_id FOR UPDATE;
  IF v_t.satellite_target_id IS DISTINCT FROM v_economics.target_tournament_id
     OR GREATEST(COALESCE(v_t.satellite_seats,0),0)<>v_economics.configured_seats THEN
    RETURN jsonb_build_object('ok',false,'is_satellite',true,'ready',false,
                              'reason','frozen_source_contract_changed');
  END IF;

  SELECT * INTO v_receipt FROM public.tournament_entry_close_receipts
   WHERE tournament_id=p_tournament_id;
  IF NOT FOUND OR NOT COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',true,'is_satellite',true,'ready',false,
                              'reason','entry_window_not_finalized');
  END IF;
  v_pool:=round(v_receipt.final_prize_pool,2);
  IF round(COALESCE(v_t.prize_pool,0),2)<>v_pool
     AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_entitlements e
                      WHERE e.tournament_id=p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'is_satellite',true,'ready',false,
                              'reason','final_pool_changed_before_plan');
  END IF;
  SELECT count(*)::integer INTO v_field FROM public.tournament_players
   WHERE tournament_id=p_tournament_id;
  IF v_field<1 THEN
    RETURN jsonb_build_object('ok',false,'is_satellite',true,'ready',false,
                              'reason','final_field_unreadable');
  END IF;
  v_ticket:=v_economics.ticket_value;
  v_configured:=v_economics.configured_seats;
  IF v_ticket>0 THEN
    v_seats:=LEAST(v_field,GREATEST(v_configured,floor(v_pool/v_ticket)::integer));
  END IF;
  IF v_pool+0.005<round(LEAST(v_field,v_configured)*v_ticket,2) THEN
    RETURN jsonb_build_object('ok',false,'is_satellite',true,'ready',false,
                              'reason','frozen_satellite_guarantee_unfunded',
                              'final_pool',v_pool,'promised_minimum',
                              round(LEAST(v_field,v_configured)*v_ticket,2));
  END IF;
  v_remainder:=GREATEST(round(v_pool-v_seats*v_ticket,2),0);
  IF v_seats>0 THEN
    v_remainder_position:=CASE WHEN v_remainder>0
      THEN LEAST(v_seats+1,v_field) ELSE NULL END;
    v_expected_depth:=v_seats+CASE WHEN v_remainder_position>v_seats THEN 1 ELSE 0 END;
  ELSIF v_pool>0 THEN
    v_remainder_position:=1;
    v_expected_depth:=1;
  END IF;

  SELECT count(*)::integer INTO v_existing
    FROM public.tournament_satellite_entitlements e
   WHERE e.tournament_id=p_tournament_id;
  IF v_existing=0 THEN
    IF v_seats>0 THEN
      FOR i IN 1..v_seats LOOP
        INSERT INTO public.tournament_satellite_entitlements(
          tournament_id,position,target_tournament_id,award_kind,ticket_value,
          remainder_value,source_pool,entry_closed_at)
        VALUES (p_tournament_id,i,v_economics.target_tournament_id,'seat_or_cash',v_ticket,
          CASE WHEN v_remainder_position=i THEN v_remainder ELSE 0 END,
          v_pool,v_receipt.entry_closed_at);
      END LOOP;
      IF v_remainder_position>v_seats THEN
        INSERT INTO public.tournament_satellite_entitlements(
          tournament_id,position,target_tournament_id,award_kind,ticket_value,
          remainder_value,source_pool,entry_closed_at)
        VALUES (p_tournament_id,v_remainder_position,NULL,'cash',0,v_remainder,
                v_pool,v_receipt.entry_closed_at);
      END IF;
    ELSIF v_pool>0 THEN
      INSERT INTO public.tournament_satellite_entitlements(
        tournament_id,position,target_tournament_id,award_kind,ticket_value,
        remainder_value,source_pool,entry_closed_at)
      VALUES (p_tournament_id,1,NULL,'cash',0,v_pool,v_pool,
              v_receipt.entry_closed_at);
    END IF;
  END IF;

  SELECT count(*)::integer INTO v_bad
    FROM public.tournament_satellite_entitlements e
   WHERE e.tournament_id=p_tournament_id
     AND (
       e.position>v_expected_depth
       OR e.source_pool<>v_pool
       OR e.entry_closed_at<>v_receipt.entry_closed_at
       OR (e.position<=v_seats AND (
            e.award_kind<>'seat_or_cash'
            OR e.target_tournament_id IS DISTINCT FROM v_economics.target_tournament_id
            OR e.ticket_value<>v_ticket
            OR e.remainder_value<>CASE WHEN e.position=v_remainder_position
                                       THEN v_remainder ELSE 0 END))
       OR (e.position>v_seats AND (
            e.award_kind<>'cash' OR e.target_tournament_id IS NOT NULL
            OR e.ticket_value<>0 OR e.remainder_value<>v_remainder))
     );
  IF v_bad>0
     OR (SELECT count(*) FROM public.tournament_satellite_entitlements e
          WHERE e.tournament_id=p_tournament_id)<>v_expected_depth
     OR (v_expected_depth>0 AND (
          SELECT count(*) FROM generate_series(1,v_expected_depth) expected(position)
           WHERE NOT EXISTS (
             SELECT 1 FROM public.tournament_satellite_entitlements e
              WHERE e.tournament_id=p_tournament_id
                AND e.position=expected.position))>0) THEN
    RETURN jsonb_build_object('ok',false,'is_satellite',true,'ready',false,
                              'reason','frozen_entitlement_plan_conflict');
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'is_satellite',true,'ready',true,'award_depth',v_expected_depth,
    'entitlement_count',v_expected_depth,'ticket_value',v_ticket,
    'source_pool',v_pool,'target_tournament_id',v_economics.target_tournament_id,
    'source_contract_hash',v_economics.source_contract_hash,
    'target_contract_hash',v_economics.target_contract_hash);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_tournament_satellite_entitlement_depth(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  RETURN public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_count integer;
  v_id uuid;
BEGIN
  IF round(COALESCE(p_amount,0),2)<=0 THEN RETURN NULL; END IF;
  v_result:=public.fn_settle_tournament_obligation(
    p_tournament_id,p_kind,p_place,p_user_id,round(p_amount,2),p_source,
    CASE WHEN p_kind='satellite_remainder' THEN 'Satellite cash remainder'
         ELSE format('Satellite place %s cash entitlement',p_place) END,NULL);
  SELECT count(*)::integer,(array_agg(o.id ORDER BY o.id))[1] INTO v_count,v_id
    FROM public.tournament_obligations o
   WHERE o.tournament_id=p_tournament_id AND o.kind=p_kind
     AND o.user_id=p_user_id AND o.place IS NOT DISTINCT FROM p_place
     AND round(o.amount_owed,2)=round(p_amount,2)
     AND round(o.amount_paid,2)=round(p_amount,2)
     AND o.settled_at IS NOT NULL;
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE OR v_count<>1 THEN
    RAISE EXCEPTION 'satellite cash entitlement did not settle exactly: %',
      COALESCE(v_result::text,'null') USING ERRCODE='check_violation';
  END IF;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_deliver_satellite_ticket_exact(
  p_satellite_id uuid,
  p_target_id uuid,
  p_user_id uuid,
  p_username text,
  p_position integer,
  p_ticket_value numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_target public.tournaments%ROWTYPE;
  v_existing public.tournament_players%ROWTYPE;
  v_before_target_pool numeric;
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
          <>v_before_target_pool+round(COALESCE(v_target.buy_in_amount,0),2)
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

CREATE OR REPLACE FUNCTION public.fn_check_atomic_satellite_finish(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_batch public.tournament_satellite_settlement_batches%ROWTYPE;
  v_count integer;
  v_depth integer;
  v_amount numeric;
  v_fingerprint text;
  v_bad integer;
  v_winner uuid;
  v_t public.tournaments%ROWTYPE;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_rake_expected numeric;
  v_rake_rows integer;
  v_rake_amount numeric;
  v_rake_destination text;
  v_rake_settled_at timestamptz;
  v_rake_attributed_at timestamptz;
  v_bounty public.tournament_bounty_completion_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_batch FROM public.tournament_satellite_settlement_batches
   WHERE tournament_id=p_tournament_id;
  IF NOT FOUND OR v_batch.settled_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_batch_not_settled');
  END IF;
  SELECT count(*)::integer,COALESCE(max(e.position),0),
         round(COALESCE(sum(e.ticket_value+e.remainder_value),0),2),
         md5(COALESCE(string_agg(
           concat_ws(':',e.position,e.award_kind,
             COALESCE(e.target_tournament_id::text,''),e.ticket_value,e.remainder_value,
             e.source_pool,e.entry_closed_at::text),'|' ORDER BY e.position),''))
    INTO v_count,v_depth,v_amount,v_fingerprint
    FROM public.tournament_satellite_entitlements e
   WHERE e.tournament_id=p_tournament_id;
  IF ROW(v_batch.entitlement_count,v_batch.award_depth,v_batch.amount_owed,
         v_batch.plan_fingerprint)
     IS DISTINCT FROM ROW(v_count,v_depth,v_amount,v_fingerprint) THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_batch_plan_conflict');
  END IF;
  SELECT (array_agg(tp.user_id ORDER BY tp.user_id))[1] INTO v_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.status='winner' AND tp.position=1;
  IF v_winner IS DISTINCT FROM v_batch.winner_user_id THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_winner_conflict');
  END IF;
  SELECT count(*)::integer INTO v_bad
    FROM public.tournament_satellite_entitlements e
   WHERE e.tournament_id=p_tournament_id
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_batch.outcomes) o
        WHERE COALESCE(o->>'position','')~'^[0-9]+$'
          AND (o->>'position')::integer=e.position
          AND COALESCE(o->>'user_id','')=(SELECT tp.user_id::text
            FROM public.tournament_players tp
            WHERE tp.tournament_id=p_tournament_id AND tp.position=e.position)
          AND CASE WHEN COALESCE(o->>'ticket_value','')~'^[0-9]+([.][0-9]+)?$'
                   THEN round((o->>'ticket_value')::numeric,2) ELSE -1 END
              =e.ticket_value
          AND CASE WHEN COALESCE(o->>'remainder_value','')~'^[0-9]+([.][0-9]+)?$'
                   THEN round((o->>'remainder_value')::numeric,2) ELSE -1 END
              =e.remainder_value
     );
  IF v_bad>0 OR jsonb_array_length(v_batch.outcomes)<>v_count OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_batch.outcomes) o
     GROUP BY o->>'position' HAVING count(*)<>1
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_outcome_set_incomplete');
  END IF;

  -- Prove each promised ticket is exactly one in-kind seat or one paid place,
  -- never both; prove residual cash through its distinct obligation key.
  SELECT count(*)::integer INTO v_bad
    FROM public.tournament_satellite_entitlements e
    JOIN public.tournament_players finisher
      ON finisher.tournament_id=e.tournament_id AND finisher.position=e.position
    CROSS JOIN LATERAL (
      SELECT o FROM jsonb_array_elements(v_batch.outcomes) o
       WHERE (o->>'position')::integer=e.position LIMIT 1
    ) outcome
   WHERE e.tournament_id=p_tournament_id AND (
     finisher.status NOT IN ('winner','eliminated')
     OR round(COALESCE(finisher.prize,0),2)<>
          round(e.ticket_value+e.remainder_value,2)
     OR (e.ticket_value>0 AND (
       (outcome.o->>'ticket_delivery') NOT IN ('seat','cash')
       OR ((outcome.o->>'ticket_delivery')='seat')<>((
         SELECT count(*)=1 FROM public.tournament_payouts po
          JOIN public.tournament_players target_seat
            ON target_seat.id::text=po.metadata->>'registration_id'
         WHERE po.tournament_id=p_tournament_id AND po.user_id=finisher.user_id
           AND po.position=e.position AND po.source='satellite_seat'
           AND round(po.amount,2)=e.ticket_value
           AND CASE WHEN COALESCE(po.metadata->>'pool_transfer','')~'^[0-9]+([.][0-9]+)?$'
                    THEN round((po.metadata->>'pool_transfer')::numeric,2) ELSE -1 END
               =e.ticket_value
           AND CASE WHEN COALESCE(po.metadata->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                    THEN round((po.metadata->>'unbacked')::numeric,2) ELSE -1 END=0
           AND round(
             CASE WHEN COALESCE(po.metadata->>'target_buy_in','')~'^[0-9]+([.][0-9]+)?$'
                  THEN (po.metadata->>'target_buy_in')::numeric ELSE -1 END
             +CASE WHEN COALESCE(po.metadata->>'target_fee','')~'^[0-9]+([.][0-9]+)?$'
                   THEN (po.metadata->>'target_fee')::numeric ELSE -1 END,2)
               =e.ticket_value
           AND target_seat.user_id=finisher.user_id
           AND target_seat.source_satellite_id=p_tournament_id
           AND (SELECT count(*) FROM public.chip_ledger l
                 WHERE l.idempotency_key='tourney:'||p_tournament_id::text
                       ||':seat:'||finisher.user_id::text||':pool_transfer'
                   AND l.from_type='prize_liability'
                   AND l.from_entity_id=p_tournament_id
                   AND l.to_type='prize_liability'
                   AND l.to_entity_id=e.target_tournament_id
                   AND round(l.amount,2)=e.ticket_value
                   AND l.metadata->>'registration_id'=target_seat.id::text
                   AND CASE WHEN COALESCE(l.metadata->>'moved','')~'^[0-9]+([.][0-9]+)?$'
                            THEN round((l.metadata->>'moved')::numeric,2) ELSE -1 END
                       =e.ticket_value
                   AND CASE WHEN COALESCE(l.metadata->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                            THEN round((l.metadata->>'unbacked')::numeric,2) ELSE -1 END=0)=1
           AND (SELECT count(*) FROM public.rake_records rr
                 WHERE rr.tournament_id=e.target_tournament_id
                   AND rr.source='fn_award_satellite_seat'
                   AND rr.metadata->>'satellite_id'=p_tournament_id::text
                   AND rr.metadata->>'user_id'=finisher.user_id::text
                   AND rr.metadata->>'registration_id'=target_seat.id::text
                   AND round(rr.rake_amount,2)=round(
                     CASE WHEN COALESCE(po.metadata->>'target_fee','')~'^[0-9]+([.][0-9]+)?$'
                          THEN (po.metadata->>'target_fee')::numeric ELSE -1 END,2)
                   AND round(COALESCE(rr.pot_size,0),2)=e.ticket_value)
               =CASE WHEN CASE
                   WHEN COALESCE(po.metadata->>'target_fee','')~'^[0-9]+([.][0-9]+)?$'
                     THEN (po.metadata->>'target_fee')::numeric ELSE -1 END>0
                 THEN 1 ELSE 0 END
       ))
       OR ((outcome.o->>'ticket_delivery')='cash')<>((
         SELECT count(*)=1 FROM public.tournament_obligations obl
          WHERE obl.tournament_id=p_tournament_id AND obl.kind='place'
            AND obl.place=e.position AND obl.user_id=finisher.user_id
            AND round(obl.amount_owed,2)=e.ticket_value
            AND round(obl.amount_paid,2)=e.ticket_value
            AND obl.settled_at IS NOT NULL))
     ))
     OR (e.award_kind='cash' AND (
       SELECT count(*) FROM public.tournament_obligations obl
        WHERE obl.tournament_id=p_tournament_id AND obl.kind='place'
          AND obl.place=e.position AND obl.user_id=finisher.user_id
          AND round(obl.amount_owed,2)=e.remainder_value
          AND round(obl.amount_paid,2)=e.remainder_value
          AND obl.settled_at IS NOT NULL)<>1)
     OR (e.ticket_value>0 AND e.remainder_value>0 AND (
       SELECT count(*) FROM public.tournament_obligations obl
        WHERE obl.tournament_id=p_tournament_id
          AND obl.kind='satellite_remainder' AND obl.place IS NULL
          AND obl.user_id=finisher.user_id
          AND round(obl.amount_owed,2)=e.remainder_value
          AND round(obl.amount_paid,2)=e.remainder_value
          AND obl.settled_at IS NOT NULL)<>1)
   );
  IF v_bad>0 THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_money_evidence_incomplete',
                              'invalid_entitlements',v_bad);
  END IF;

  -- COMPLETED cannot outrun the common money prerequisites. The caller runs
  -- rake/bounty settlement first, while this checker independently proves the
  -- durable receipts inside the same transaction as the terminal status flip.
  SELECT GREATEST(round(COALESCE(sum(rr.rake_amount),0),2),0)
    INTO v_rake_expected
    FROM public.rake_records rr
   WHERE rr.tournament_id=p_tournament_id AND rr.is_tournament;
  SELECT count(*)::integer,(array_agg(rs.amount ORDER BY rs.tournament_id))[1],
         (array_agg(rs.destination ORDER BY rs.tournament_id))[1],
         (array_agg(rs.settled_at ORDER BY rs.tournament_id))[1],
         (array_agg(rs.attributed_at ORDER BY rs.tournament_id))[1]
    INTO v_rake_rows,v_rake_amount,v_rake_destination,
         v_rake_settled_at,v_rake_attributed_at
    FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id=p_tournament_id;
  IF v_rake_rows<>1 OR v_rake_settled_at IS NULL
     OR v_rake_attributed_at IS NULL OR v_rake_destination='pending'
     OR abs(round(COALESCE(v_rake_amount,0),2)-v_rake_expected)>0.005 THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_rake_not_settled',
      'expected',v_rake_expected,'recorded',v_rake_amount,
      'destination',v_rake_destination,'attributed_at',v_rake_attributed_at);
  END IF;

  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
      RETURN jsonb_build_object('ok',false,
                                'reason','satellite_bounty_obligations_pending');
    END IF;
    SELECT * INTO v_bounty
      FROM public.tournament_bounty_completion_receipts b
     WHERE b.tournament_id=p_tournament_id;
    IF NOT FOUND OR v_bounty.winner_user_id IS DISTINCT FROM v_winner
       OR v_bounty.pool_finalized_at IS NULL
       OR COALESCE((v_bounty.pool_result->>'ok')::boolean,false) IS NOT TRUE
       OR (COALESCE(v_t.is_mystery_bounty,false)
           AND COALESCE(v_t.mystery_bounty_stage,'pending')<>'pending'
           AND (v_bounty.mystery_settled_at IS NULL
                OR COALESCE((v_bounty.mystery_result->>'ok')::boolean,false) IS NOT TRUE
                OR COALESCE((v_bounty.mystery_result->>'balanced')::boolean,false) IS NOT TRUE)) THEN
      RETURN jsonb_build_object('ok',false,
                                'reason','satellite_bounty_not_certified');
    END IF;
  END IF;

  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id=p_tournament_id;
  IF NOT FOUND THEN
    IF COALESCE(v_t.prize_pool,0)<>0 OR COALESCE(v_t.bounty_pool,0)<>0
       OR COALESCE(v_t.total_rake,0)<>0
       OR EXISTS (SELECT 1 FROM public.tournament_payouts po
                   WHERE po.tournament_id=p_tournament_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','satellite_escrow_evidence_missing');
    END IF;
  ELSIF abs(round(v_escrow.prize_balance,2))>0.005
     OR abs(round(v_escrow.bounty_balance,2))>0.005
     OR abs(round(v_escrow.fee_balance,2))>0.005 THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_escrow_not_zero',
      'prize_balance',v_escrow.prize_balance,
      'bounty_balance',v_escrow.bounty_balance,
      'fee_balance',v_escrow.fee_balance);
  END IF;
  RETURN jsonb_build_object('ok',true,'reason',NULL,
    'tournament_id',p_tournament_id,'winner_user_id',v_batch.winner_user_id,
    'entitlement_count',v_count,'award_depth',v_depth,'amount_settled',v_amount,
    'plan_fingerprint',v_fingerprint);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_finish_atomic(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.satellite_finish'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_plan jsonb;
  v_t public.tournaments%ROWTYPE;
  v_batch public.tournament_satellite_settlement_batches%ROWTYPE;
  v_winner uuid;
  v_player_count integer;
  v_terminal_count integer;
  v_ranked_count integer;
  v_fingerprint text;
  v_count integer;
  v_depth integer;
  v_amount numeric;
  v_delivery jsonb;
  v_ticket_obligation uuid;
  v_remainder_obligation uuid;
  v_outcomes jsonb:='[]'::jsonb;
  v_check jsonb;
  v_rows integer;
  v_rake_expected numeric;
  v_rake_rows integer;
  v_rake_amount numeric;
  v_rake_destination text;
  v_rake_settled_at timestamptz;
  v_rake_attributed_at timestamptz;
  v_bounty public.tournament_bounty_completion_receipts%ROWTYPE;
  e public.tournament_satellite_entitlements%ROWTYPE;
  p public.tournament_players%ROWTYPE;
BEGIN
  v_plan:=public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
  IF COALESCE((v_plan->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_plan->>'is_satellite')::boolean,false) IS NOT TRUE
     OR COALESCE((v_plan->>'ready')::boolean,false) IS NOT TRUE THEN
    RETURN v_plan || jsonb_build_object('settled',false);
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  SELECT * INTO v_batch FROM public.tournament_satellite_settlement_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND AND v_batch.settled_at IS NOT NULL THEN
    v_check:=public.fn_check_atomic_satellite_finish(p_tournament_id);
    RETURN v_check || jsonb_build_object('settled',true,'already_settled',true,
                                         'rows_updated',0);
  END IF;
  IF v_t.status<>'COMPLETING' THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_not_completing',
                              'status',v_t.status,'settled',false);
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE tp.status IN ('winner','eliminated'))::integer,
         count(DISTINCT tp.position)::integer,
         (array_agg(tp.user_id ORDER BY tp.user_id)
           FILTER (WHERE tp.status='winner' AND tp.position=1))[1]
    INTO v_player_count,v_terminal_count,v_ranked_count,v_winner
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  IF v_player_count<1 OR v_terminal_count<>v_player_count
     OR v_ranked_count<>v_player_count OR v_winner IS NULL
     OR (SELECT min(position) FROM public.tournament_players
          WHERE tournament_id=p_tournament_id)<>1
     OR (SELECT max(position) FROM public.tournament_players
          WHERE tournament_id=p_tournament_id)<>v_player_count THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_standings_not_terminal',
      'players',v_player_count,'terminal',v_terminal_count,'ranked',v_ranked_count,
      'settled',false);
  END IF;

  -- Do not even begin the all-or-none payout subtransaction until common
  -- terminal money work is durably complete. The postcondition repeats these
  -- proofs, closing the race between this read and the COMPLETED update.
  SELECT GREATEST(round(COALESCE(sum(rr.rake_amount),0),2),0)
    INTO v_rake_expected
    FROM public.rake_records rr
   WHERE rr.tournament_id=p_tournament_id AND rr.is_tournament;
  SELECT count(*)::integer,(array_agg(rs.amount ORDER BY rs.tournament_id))[1],
         (array_agg(rs.destination ORDER BY rs.tournament_id))[1],
         (array_agg(rs.settled_at ORDER BY rs.tournament_id))[1],
         (array_agg(rs.attributed_at ORDER BY rs.tournament_id))[1]
    INTO v_rake_rows,v_rake_amount,v_rake_destination,
         v_rake_settled_at,v_rake_attributed_at
    FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id=p_tournament_id;
  IF v_rake_rows<>1 OR v_rake_settled_at IS NULL
     OR v_rake_attributed_at IS NULL OR v_rake_destination='pending'
     OR abs(round(COALESCE(v_rake_amount,0),2)-v_rake_expected)>0.005 THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_rake_not_settled',
      'expected',v_rake_expected,'recorded',v_rake_amount,
      'destination',v_rake_destination,'attributed_at',v_rake_attributed_at,
      'settled',false,'retryable',true);
  END IF;
  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    IF public.fn_tournament_has_unsettled_bounties(p_tournament_id) THEN
      RETURN jsonb_build_object('ok',false,
        'reason','satellite_bounty_obligations_pending','settled',false,'retryable',true);
    END IF;
    SELECT * INTO v_bounty
      FROM public.tournament_bounty_completion_receipts b
     WHERE b.tournament_id=p_tournament_id;
    IF NOT FOUND OR v_bounty.winner_user_id IS DISTINCT FROM v_winner
       OR v_bounty.pool_finalized_at IS NULL
       OR COALESCE((v_bounty.pool_result->>'ok')::boolean,false) IS NOT TRUE
       OR (COALESCE(v_t.is_mystery_bounty,false)
           AND COALESCE(v_t.mystery_bounty_stage,'pending')<>'pending'
           AND (v_bounty.mystery_settled_at IS NULL
                OR COALESCE((v_bounty.mystery_result->>'ok')::boolean,false) IS NOT TRUE
                OR COALESCE((v_bounty.mystery_result->>'balanced')::boolean,false) IS NOT TRUE)) THEN
      RETURN jsonb_build_object('ok',false,'reason','satellite_bounty_not_certified',
                                'settled',false,'retryable',true);
    END IF;
  END IF;

  SELECT count(*)::integer,COALESCE(max(ent.position),0),
         round(COALESCE(sum(ent.ticket_value+ent.remainder_value),0),2),
         md5(COALESCE(string_agg(concat_ws(':',ent.position,ent.award_kind,
           COALESCE(ent.target_tournament_id::text,''),ent.ticket_value,
           ent.remainder_value,ent.source_pool,ent.entry_closed_at::text),
           '|' ORDER BY ent.position),''))
    INTO v_count,v_depth,v_amount,v_fingerprint
    FROM public.tournament_satellite_entitlements ent
   WHERE ent.tournament_id=p_tournament_id;
  INSERT INTO public.tournament_satellite_settlement_batches(
    tournament_id,winner_user_id,target_tournament_id,plan_fingerprint,
    entitlement_count,award_depth,amount_owed,source)
  VALUES (p_tournament_id,v_winner,v_t.satellite_target_id,v_fingerprint,
          v_count,v_depth,v_amount,
          COALESCE(NULLIF(btrim(p_source),''),'engine.satellite_finish'))
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT * INTO v_batch FROM public.tournament_satellite_settlement_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF ROW(v_batch.winner_user_id,v_batch.target_tournament_id,
         v_batch.plan_fingerprint,v_batch.entitlement_count,v_batch.award_depth,
         v_batch.amount_owed)
     IS DISTINCT FROM ROW(v_winner,v_t.satellite_target_id,v_fingerprint,
                          v_count,v_depth,v_amount) THEN
    RETURN jsonb_build_object('ok',false,'reason','satellite_batch_conflict',
                              'settled',false);
  END IF;

  BEGIN
    PERFORM set_config('app.atomic_satellite_settlement',p_tournament_id::text,true);
    FOR e IN SELECT * FROM public.tournament_satellite_entitlements
              WHERE tournament_id=p_tournament_id ORDER BY position LOOP
      SELECT * INTO p FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id AND tp.position=e.position
       FOR UPDATE;
      IF NOT FOUND OR p.status NOT IN ('winner','eliminated') THEN
        RAISE EXCEPTION 'satellite entitlement position % has no terminal finisher',e.position
          USING ERRCODE='check_violation';
      END IF;
      v_delivery:=NULL;
      v_ticket_obligation:=NULL;
      v_remainder_obligation:=NULL;
      IF e.ticket_value>0 THEN
        v_delivery:=public.fn_deliver_satellite_ticket_exact(
          p_tournament_id,e.target_tournament_id,p.user_id,p.username,
          e.position,e.ticket_value);
        IF v_delivery->>'delivery'='cash' THEN
          v_ticket_obligation:=public.fn_settle_satellite_cash_entitlement_exact(
            p_tournament_id,'place',e.position,p.user_id,e.ticket_value,p_source);
        ELSIF v_delivery->>'delivery'<>'seat' THEN
          RAISE EXCEPTION 'satellite ticket has no exact delivery';
        END IF;
      ELSIF e.award_kind='cash' THEN
        v_delivery:=jsonb_build_object('delivery','cash','reason','whole_pool');
        v_ticket_obligation:=public.fn_settle_satellite_cash_entitlement_exact(
          p_tournament_id,'place',e.position,p.user_id,e.remainder_value,p_source);
      END IF;
      IF e.ticket_value>0 AND e.remainder_value>0 THEN
        v_remainder_obligation:=public.fn_settle_satellite_cash_entitlement_exact(
          p_tournament_id,'satellite_remainder',NULL,p.user_id,
          e.remainder_value,p_source);
      END IF;
      UPDATE public.tournament_players
         SET prize=round(e.ticket_value+e.remainder_value,2)
       WHERE id=p.id;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'satellite prize stamp CAS changed % rows',v_rows
          USING ERRCODE='40001';
      END IF;
      v_outcomes:=v_outcomes||jsonb_build_array(jsonb_build_object(
        'position',e.position,'user_id',p.user_id,
        'ticket_value',e.ticket_value,'remainder_value',e.remainder_value,
        'ticket_delivery',v_delivery->>'delivery',
        'delivery_reason',v_delivery->>'reason',
        'registration_id',v_delivery->>'registration_id',
        'seat_payout_id',v_delivery->>'payout_id',
        'place_obligation_id',v_ticket_obligation,
        'remainder_obligation_id',v_remainder_obligation));
    END LOOP;

    IF v_t.satellite_target_id IS NOT NULL THEN
      UPDATE public.tournaments target SET current_players=(
        SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id=target.id)
       WHERE target.id=v_t.satellite_target_id;
    END IF;
    UPDATE public.tournament_satellite_settlement_batches
       SET settled_at=clock_timestamp(),outcomes=v_outcomes
     WHERE tournament_id=p_tournament_id AND settled_at IS NULL;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'satellite batch settle CAS changed % rows',v_rows
        USING ERRCODE='40001';
    END IF;
    v_check:=public.fn_check_atomic_satellite_finish(p_tournament_id);
    IF COALESCE((v_check->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite settlement postcondition failed: %',v_check
        USING ERRCODE='check_violation';
    END IF;
    UPDATE public.tournaments
       SET status='COMPLETED',ended_at=COALESCE(ended_at,clock_timestamp()),
           on_break=false,break_started_at=NULL,break_ends_at=NULL,
           current_players=1
     WHERE id=p_tournament_id AND status='COMPLETING';
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'satellite completion CAS changed % rows',v_rows
        USING ERRCODE='40001';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok',false,'reason','atomic_satellite_settlement_failed',
      'sqlstate',SQLSTATE,'detail',SQLERRM,'settled',false,'retryable',
      SQLSTATE IN ('40001','40P01','55P03','57014'));
  END;
  v_check:=public.fn_check_atomic_satellite_finish(p_tournament_id);
  RETURN v_check||jsonb_build_object('settled',true,'already_settled',false,
                                     'rows_updated',1,'outcomes',v_outcomes);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_guard_atomic_satellite_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_check jsonb;
BEGIN
  IF NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
     AND (lower(COALESCE(NEW.variant,''))='satellite'
       OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE'
       OR NEW.satellite_target_id IS NOT NULL) THEN
    IF OLD.status<>'COMPLETING' THEN
      RAISE EXCEPTION 'satellite tournament cannot complete from %',OLD.status
        USING ERRCODE='check_violation';
    END IF;
    v_check:=public.fn_check_atomic_satellite_finish(NEW.id);
    IF COALESCE((v_check->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite completion has no exact atomic receipt: %',v_check
        USING ERRCODE='check_violation';
    END IF;
    NEW.on_break:=false;
    NEW.break_started_at:=NULL;
    NEW.break_ends_at:=NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS aaa_guard_atomic_satellite_completion
  ON public.tournaments;
CREATE TRIGGER aaa_guard_atomic_satellite_completion
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_atomic_satellite_completion();

REVOKE ALL ON FUNCTION public.trg_freeze_satellite_entitlement()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_freeze_satellite_economic_snapshot()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_freeze_satellite_settlement_batch()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_capture_satellite_economics_on_start()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_require_satellite_economics_at_entry_close()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_materialize_satellite_entitlements_locked(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  uuid,text,integer,uuid,numeric,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_deliver_satellite_ticket_exact(
  uuid,uuid,uuid,text,integer,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_guard_atomic_satellite_completion()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_get_tournament_satellite_entitlement_depth(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_tournament_satellite_entitlement_depth(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_check_atomic_satellite_finish(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_check_atomic_satellite_finish(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_finish_atomic(uuid,text)
  TO service_role;

DO $assertions$
DECLARE
  v_role text;
  v_sig text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH v_sig IN ARRAY ARRAY[
      'fn_get_tournament_satellite_entitlement_depth(uuid)',
      'fn_check_atomic_satellite_finish(uuid)',
      'fn_settle_satellite_finish_atomic(uuid,text)',
      'fn_materialize_satellite_entitlements_locked(uuid)',
      'fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)',
      'fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
      'trg_guard_atomic_satellite_completion()',
      'trg_capture_satellite_economics_on_start()',
      'trg_require_satellite_economics_at_entry_close()',
      'trg_freeze_satellite_economic_snapshot()',
      'trg_freeze_satellite_entitlement()',
      'trg_freeze_satellite_settlement_batch()'
    ] LOOP
      IF has_function_privilege(v_role,'public.'||v_sig,'EXECUTE') THEN
        RAISE EXCEPTION '% can execute satellite money authority %',v_role,v_sig;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_sig IN ARRAY ARRAY[
    'fn_materialize_satellite_entitlements_locked(uuid)',
    'fn_settle_satellite_cash_entitlement_exact(uuid,text,integer,uuid,numeric,text)',
    'fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)',
    'trg_guard_atomic_satellite_completion()',
    'trg_capture_satellite_economics_on_start()',
    'trg_require_satellite_economics_at_entry_close()',
    'trg_freeze_satellite_economic_snapshot()',
    'trg_freeze_satellite_entitlement()',
    'trg_freeze_satellite_settlement_batch()'
  ] LOOP
    IF has_function_privilege('service_role','public.'||v_sig,'EXECUTE') THEN
      RAISE EXCEPTION 'service_role can bypass satellite public doors through %',v_sig;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role','public.tournament_satellite_economic_snapshots','INSERT')
     OR has_table_privilege('service_role','public.tournament_satellite_economic_snapshots','UPDATE')
     OR has_table_privilege('service_role','public.tournament_satellite_economic_snapshots','DELETE')
     OR has_table_privilege('service_role','public.tournament_satellite_entitlements','INSERT')
     OR has_table_privilege('service_role','public.tournament_satellite_entitlements','UPDATE')
     OR has_table_privilege('service_role','public.tournament_satellite_entitlements','DELETE')
     OR has_table_privilege('service_role','public.tournament_satellite_settlement_batches','INSERT')
     OR has_table_privilege('service_role','public.tournament_satellite_settlement_batches','UPDATE')
     OR has_table_privilege('service_role','public.tournament_satellite_settlement_batches','DELETE') THEN
    RAISE EXCEPTION 'service_role can forge a satellite entitlement or receipt';
  END IF;
  IF position('FOR UPDATE' IN pg_get_functiondef(
       'public.fn_materialize_satellite_entitlements_locked(uuid)'::regprocedure))=0
     OR position('fn_check_atomic_satellite_finish' IN pg_get_functiondef(
       'public.fn_settle_satellite_finish_atomic(uuid,text)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'satellite materialization/settlement lost its lock or checker';
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p
       WHERE p.oid='public.fn_check_atomic_satellite_finish(uuid)'::regprocedure)<>'v' THEN
    RAISE EXCEPTION 'satellite checker must see writes made earlier in the atomic settlement command';
  END IF;
END;
$assertions$;

COMMIT;
