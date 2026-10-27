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

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
  v_status text;
  v_finalized boolean;
BEGIN
  IF public.fn_lightning_pilot_assignment_blocks(p_user_id,p_tournament_id) THEN
    v_gate:=public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id,p_user_id);
    IF coalesce((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN RETURN v_gate; END IF;
    IF nullif(v_gate->>'ticket_id','') IS NULL THEN
      v_gate:=public.fn_ca_find_cashier_entry_ticket_for(p_tournament_id,p_user_id);
    END IF;
    IF coalesce((v_gate->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_gate->>'ticket_id','') IS NULL OR coalesce((v_gate->>'ticket_value')::numeric,0)<=0 THEN
      RETURN jsonb_build_object('ok',false,'reason','lightning_pilot_assigned');
    END IF;
    -- The existing seat-first core registers through the guarded two-arg door.
    -- That delegates ticket-first with wallet fallback disabled above.
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;

  -- The canonical parent lock serializes this decision with launch/finalization.
  -- Existing live-chair replay still reaches the original read-only delegate.
  -- Like the human door, only ANNOUNCED/REGISTERING may acquire a fresh chair;
  -- launch need not have finalized the entry pool. NULL/unknown status refuses.
  SELECT t.status,t.prize_pool_finalized INTO v_status,v_finalized
    FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id=public.fn_tournament_primary_table(p_tournament_id)
          AND s.user_id=p_user_id AND s.left_at IS NULL
     ) THEN
    IF (v_status IN ('ANNOUNCED','REGISTERING')) IS NOT TRUE THEN
      RETURN jsonb_build_object('ok',false,'reason','game_already_started');
    END IF;
    IF v_finalized IS TRUE THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_closed');
    END IF;
  END IF;

  RETURN public.fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
$function$;
