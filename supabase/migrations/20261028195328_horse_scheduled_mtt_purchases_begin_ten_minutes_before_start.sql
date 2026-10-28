-- Owner October 28, 2026: horses begin scheduled MTT signups at T-10 minutes.
-- Covers both horse door overloads; the two-argument door delegates here.
-- No roster cleanup, wallet edits, ticket redemption, field-cap or human-door changes.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_register_horse_for_tournament(uuid,uuid,boolean)'::regprocedure))
      <> '45cb6958b8a2010cab979952be4a20ca' THEN
    RAISE EXCEPTION 'horse_registration_timing_preimage_changed';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_horse_mtt_purchase_window_open(
  p_format text,p_status text,p_start timestamptz,p_now timestamptz
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public','pg_temp'
AS $window$
  SELECT CASE
    WHEN p_format IN ('mtt-v1','mtt-v2') AND upper(p_status)='REGISTERING'
      THEN coalesce(p_start <= p_now + interval '10 minutes',false)
    ELSE true
  END
$window$;
REVOKE ALL ON FUNCTION public.fn_ca_horse_mtt_purchase_window_open(text,text,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_mtt_purchase_window_open(text,text,timestamptz,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
  v_paying uuid;
  v_result jsonb;
BEGIN
  IF public.fn_lightning_pilot_assignment_blocks(p_user_id,p_tournament_id) THEN
    -- Genuine target-contract tickets retain their existing paid value.
    -- These are the maintained proof-bearing producer lookups, not bulk hints.
    v_result:=public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id,p_user_id);
    IF coalesce((v_result->>'ok')::boolean,false) IS NOT TRUE THEN RETURN v_result; END IF;
    IF nullif(v_result->>'ticket_id','') IS NULL THEN
      v_result:=public.fn_ca_find_cashier_entry_ticket_for(p_tournament_id,p_user_id);
    END IF;
    IF coalesce((v_result->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_result->>'ticket_id','') IS NULL OR coalesce((v_result->>'ticket_value')::numeric,0)<=0 THEN
      RETURN jsonb_build_object('ok',false,'reason','lightning_pilot_assigned');
    END IF;
    p_allow_wallet_charge:=false;
  END IF;
  -- 20261005224736 / A18 (horse_entry_funding, recorded 2026-10-05) and
  -- CLAUDE.md 10.5 (HORSES ARE PLAYERS - NO EXCEPTIONS). The owner's answer
  -- reads: "a horse funds its Diamond entry from its own balance, through the
  -- ordinary Diamond registration door a person uses." So this is no longer a
  -- blanket refusal resting on a Phase-9 assumption; it is that answer, READ
  -- AT CALL TIME. Changing the answer is one INSERT into ca_diamond_economics
  -- and no code change - 'own_balance' is never hard-coded as the decision.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    DECLARE
      v_horse_entry_funding text;
    BEGIN
      BEGIN
        v_horse_entry_funding :=
          public.fn_ca_diamond_economic_text('horse_entry_funding','all');
      EXCEPTION WHEN SQLSTATE 'P0D01' THEN
        -- No answer recorded. Refuse by name below rather than guess which
        -- funding the owner meant.
        v_horse_entry_funding := NULL;
      END;
      IF v_horse_entry_funding = 'funding_account' THEN
        -- House money, and there is no funding path for it yet. Refused by
        -- name, and the reason names the setting that produced the refusal.
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_funding_account_not_open',
          'horse_entry_funding',v_horse_entry_funding);
      ELSIF v_horse_entry_funding IS DISTINCT FROM 'own_balance' THEN
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_entry_funding_unrecognised',
          'horse_entry_funding',v_horse_entry_funding);
      END IF;
      -- 'own_balance': fall through. The horse takes the same seat-acquisition
      -- lock and the same registration chain a person takes, and pays from its
      -- own profiles.diamonds through the same Diamond door (10.5).
    END;
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;

  -- Owner October 28: no new scheduled MTT horse buy-in before T-10.
  -- The existing acquisition lock is held. Paid receipt retries remain valid;
  -- no ticket is redeemed and no wallet is charged on an early refusal.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id=p_tournament_id
       AND NOT public.fn_ca_horse_mtt_purchase_window_open(
         t.format_contract,t.status,t.start_time,clock_timestamp())
  ) AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players paid
     WHERE paid.tournament_id=p_tournament_id AND paid.user_id=p_user_id
       AND paid.status IN ('registered','playing')
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','horse_registration_not_open');
  END IF;

  -- A horse's purchase choice, not a human/platform capacity rule. Four
  -- unresolved tournament promises are enough when their duration is unknown.
  -- Paid target entries/chairs are honoured without making another purchase.
  IF EXISTS (SELECT 1 FROM public.profiles h WHERE h.id=p_user_id AND h.is_horse IS TRUE)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_players paid
        WHERE paid.user_id=p_user_id AND paid.tournament_id=p_tournament_id
          AND paid.status IN ('registered','playing')
     )
     AND (SELECT count(DISTINCT promise.tournament_id)
            FROM public.tournament_players promise
            JOIN public.tournaments promised ON promised.id=promise.tournament_id
           WHERE promise.user_id=p_user_id
             AND promise.status IN ('registered','playing')
             AND upper(COALESCE(promised.status,'')) NOT IN ('COMPLETING','COMPLETED','CANCELLED')) >= 4 THEN
    RETURN jsonb_build_object('ok',false,'reason','horse_tournament_reservation_budget');
  END IF;

  /* THE WALLET THAT CAN PAY (2026-10-12), exactly as the person's door
     (fn_register_for_tournament) does it - CLAUDE.md 10.5, a horse is
     charged by the same rule. Only when this entry is paid from a wallet. */
  IF COALESCE(p_allow_wallet_charge, false) THEN
    v_paying := public.fn_ca_entry_paying_club(p_user_id, p_tournament_id);
    IF v_paying IS NOT NULL THEN
      PERFORM set_config('app.ca_entry_paying_club',
        p_tournament_id::text || ':' || p_user_id::text || ':' || v_paying::text, true);
    END IF;
  END IF;
  v_result := public.fn_register_horse_for_tournament_before_terminal_gate(
    p_tournament_id,p_user_id,p_allow_wallet_charge);
  PERFORM set_config('app.ca_entry_paying_club', '', true);
  RETURN v_result;
END;
$function$;

-- Retain the existing service-only purchase authority and economic delegates.
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid,uuid,boolean)
  TO service_role;
COMMIT;
