CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer DEFAULT NULL::integer, p_client_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_type text:=lower(btrim(COALESCE(p_rebuy_type,'')));
  v_effective_token text;
  v_receipt_key text;
  v_request jsonb;
  v_existing_request jsonb;
  v_existing_response jsonb;
  v_claim jsonb;
  v_response jsonb;
  v_recorded jsonb;
  v_gate jsonb;
  v_choice jsonb;
  v_assignment jsonb;
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate_peek public.tournament_knockout_candidates%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_final_seat public.table_seats%ROWTYPE;
  v_table_id uuid;
  v_seat_number integer;
  v_live_count integer;
  v_pending_count integer;
  v_rebuy_window jsonb;
  v_bounty_settlement jsonb;
  v_bounty_obligation_id uuid;
  v_no_bounty_head boolean:=false;
  v_rows integer;
  v_wake_id bigint;
  v_expected_club_id uuid;
  v_expected_horse_id uuid;
  v_previous_money_path text:=current_setting('app.money_path',true);
BEGIN
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION
      'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player are required'
      USING ERRCODE='22023';
  END IF;
  IF v_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %',p_rebuy_type
      USING ERRCODE='22023';
  END IF;
  IF COALESCE(auth.role(),'service_role')<>'service_role'
     AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
    RAISE EXCEPTION
      'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE='42501';
  END IF;
  IF p_client_token IS NOT NULL
     AND (length(btrim(p_client_token))=0
          OR length(btrim(p_client_token))>128) THEN
    RAISE EXCEPTION 'rebuy prompt token is invalid'
      USING ERRCODE='22023';
  END IF;
  IF v_type<>'addon'
     AND COALESCE(auth.role(),'service_role')<>'service_role'
     AND p_client_token IS NULL THEN
    RAISE EXCEPTION 'a rebuy prompt token is required'
      USING ERRCODE='22023';
  END IF;

  -- Every chip purchase can change the tournament pool, even an add-on that
  -- does not acquire a new chair. Join terminal settlement and maintenance at
  -- their common root before claiming a receipt; an already-committed receipt
  -- can still replay after either boundary without rerunning money.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);

  IF v_type='addon' THEN
    -- Add-ons never create a chair, but their committed receipt must remain
    -- replayable across the maintenance boundary.
    v_receipt_key:='tourney:'||p_tournament_id::text||':addon:'||
      p_user_id::text;
    v_request:=jsonb_build_object(
      'version','v1','tournament_id',p_tournament_id,'user_id',p_user_id,
      'rebuy_type',v_type,'idempotency_key',v_receipt_key);
  ELSIF p_client_token IS NOT NULL
        AND length(btrim(p_client_token))>0 THEN
    v_effective_token:=btrim(p_client_token);
    v_receipt_key:='tourney:'||p_tournament_id::text||':'||v_type||':'||
      p_user_id::text||':tok:'||v_effective_token;
  END IF;

  -- An explicit prompt token names its historical purchase independently of
  -- whichever hand is current now. Read that immutable receipt first, so a
  -- delayed transport retry after later play returns the original answer
  -- instead of trying to bind the token to a newer knockout generation.
  IF v_receipt_key IS NOT NULL THEN
    SELECT r.request,r.response
      INTO v_existing_request,v_existing_response
      FROM public.entry_purchase_idempotency_receipts r
     WHERE r.key_domain='tournament_chip_purchase'
       AND r.idempotency_key=v_receipt_key;
    IF FOUND THEN
      IF v_existing_response IS NULL
         OR v_existing_request->>'version'<>'v1'
         OR v_existing_request->>'tournament_id'<>p_tournament_id::text
         OR v_existing_request->>'user_id'<>p_user_id::text
         OR v_existing_request->>'rebuy_type'<>v_type
         OR v_existing_request->>'idempotency_key'<>v_receipt_key
         OR v_existing_response->>'success'<>'true'
         OR v_existing_response->>'seated'<>'true'
         OR v_existing_response->>'atomic_tournament_chip_purchase'<>'v1'
         OR v_existing_response->>'rebuy_type'<>v_type
         OR v_existing_response->>'table_id' IS NULL
         OR v_existing_response->>'seat_id' IS NULL
         OR v_existing_response->>'stack' IS NULL
         OR (v_type='addon' AND v_existing_request ? 'candidate_id')
         OR (v_type<>'addon' AND (
           v_existing_request->>'candidate_id' IS NULL
           OR v_existing_response->>'candidate_id'<>
              v_existing_request->>'candidate_id'
           OR v_existing_response->>'candidate_state'<>'rebought')) THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_RECEIPT_UNBOUND: historical response is not an atomic tournament purchase proof'
          USING ERRCODE='55000';
      END IF;
      RETURN v_existing_response;
    END IF;
  END IF;

  IF v_type<>'addon' THEN
    -- A rebuy can acquire/revive a chair, so it joins the same global root as
    -- every registration, move and terminal settlement before observing a
    -- candidate. The nonlocking peek derives only an immutable identity; the
    -- exact latest row is re-read under tournament/candidate locks below.
    SELECT * INTO v_candidate_peek
      FROM public.tournament_knockout_candidates c
     WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
       p_tournament_id,p_user_id);
    IF v_candidate_peek.id IS NULL THEN
      RAISE EXCEPTION
        'REBUY_KNOCKOUT_GENERATION_REQUIRED: no immutable bust authorizes this purchase'
        USING ERRCODE='55000';
    END IF;
    IF v_effective_token IS NULL THEN
      v_effective_token:='candidate:'||v_candidate_peek.id::text;
      v_receipt_key:='tourney:'||p_tournament_id::text||':'||v_type||':'||
        p_user_id::text||':tok:'||v_effective_token;
    END IF;
    v_request:=jsonb_build_object(
      'version','v1','tournament_id',p_tournament_id,'user_id',p_user_id,
      'rebuy_type',v_type,'candidate_id',v_candidate_peek.id,
      'idempotency_key',v_receipt_key);
  END IF;

  v_claim:=public.fn_claim_entry_purchase_receipt(
    'tournament_chip_purchase',v_receipt_key,v_request);
  IF COALESCE((v_claim->>'claimed')::boolean,false) IS NOT TRUE THEN
    v_response:=v_claim->'response';
    IF v_response IS NULL
       OR v_response->>'atomic_tournament_chip_purchase'<>'v1'
       OR v_response->>'success'<>'true'
       OR v_response->>'seated'<>'true'
       OR v_response->>'rebuy_type'<>v_type
       OR v_response->>'table_id' IS NULL
       OR v_response->>'seat_id' IS NULL
       OR v_response->>'stack' IS NULL
       OR (v_type<>'addon' AND
           (v_response->>'candidate_id'<>v_candidate_peek.id::text
            OR v_response->>'candidate_state'<>'rebought')) THEN
      RAISE EXCEPTION
        'IDEMPOTENCY_RECEIPT_UNBOUND: historical response is not an atomic tournament purchase proof'
        USING ERRCODE='55000';
    END IF;
    RETURN v_response;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wallet_credit_idempotency k
     WHERE k.key=v_receipt_key) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: chip key predates its exact transaction receipt'
      USING ERRCODE='55000';
  END IF;

  IF v_type='addon' THEN
    IF public.fn_entry_purchases_frozen() THEN
      RAISE EXCEPTION
        'PLATFORM_FROZEN: scheduled maintenance has closed add-ons; no chips moved'
        USING ERRCODE='55006';
    END IF;
    SELECT s.table_id INTO v_table_id
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
     ORDER BY s.id
     LIMIT 1;
    IF v_table_id IS NULL THEN
      RAISE EXCEPTION 'Add-on requires one live tournament table'
        USING ERRCODE='55000';
    END IF;
    -- The accepted-hand boundary owns this same table key. During a rolling
    -- database cutover it prevents the old hand body from settling over a paid
    -- grant; after 14534, the hand also takes the terminal root shared before
    -- this key, preserving root -> table -> rows on both paths.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('atomic-table:'||v_table_id::text,0));
    SELECT * INTO v_t FROM public.tournaments t
     WHERE t.id=p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
    IF COALESCE(v_t.prize_pool_finalized,false)
       OR upper(COALESCE(v_t.status::text,'')) NOT IN ('REGISTERING','RUNNING')
       OR NOT COALESCE(v_t.add_on_available,false)
       OR NOT COALESCE(v_t.addon_period_triggered,false)
       OR v_t.addon_period_started_at IS NULL
       OR v_t.addon_period_ends_at IS NULL
       OR clock_timestamp()<v_t.addon_period_started_at
       OR clock_timestamp()>=v_t.addon_period_ends_at THEN
      RAISE EXCEPTION 'Add-On Period Is Closed Or The Prize Pool Is Already Finalized'
        USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     FOR UPDATE;
    IF NOT FOUND OR v_player.status::text<>'playing'
       OR COALESCE(v_player.chips,0)<=0 OR COALESCE(v_player.add_on,false) THEN
      RAISE EXCEPTION 'Only one live positive tournament entry may take an add-on'
        USING ERRCODE='55000';
    END IF;
    PERFORM s.id
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL
     ORDER BY s.id FOR UPDATE OF s;
    SELECT count(*)::integer INTO v_live_count
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    IF v_live_count<>1 THEN
      RAISE EXCEPTION 'Add-on requires exactly one locked live tournament seat'
        USING ERRCODE='55000';
    END IF;
    SELECT s.* INTO v_live
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL FOR UPDATE OF s;
    IF v_live.table_id IS DISTINCT FROM v_table_id THEN
      RAISE EXCEPTION 'Add-on live table changed after its atomic-table lock'
        USING ERRCODE='55000';
    END IF;

    -- The Diamond charge's existing order is custody -> profile. Preserve it
    -- without holding the tournament lane behind an unrelated reward claim.
    -- Invalid/missing/closed custody and disabled arenas retain the original
    -- charge's exact refusal; this is only admission for its valid add-on path.
    IF public.fn_ca_tournament_unit_cents(p_tournament_id)=100
       AND v_t.union_id IS NULL
       AND EXISTS (SELECT 1 FROM public.ca_arena_settings a
         WHERE a.id=1 AND a.club_id=v_t.club_id AND a.tournaments_enabled)
       AND (SELECT count(*) FROM public.poker_diamond_custody c
         WHERE c.user_id=p_user_id AND c.purpose='tournament_entry'
           AND c.target_id=p_tournament_id AND c.state<>'released')=1
       AND EXISTS (SELECT 1 FROM public.poker_diamond_custody c
         WHERE c.user_id=p_user_id AND c.purpose='tournament_entry'
           AND c.target_id=p_tournament_id AND c.state='active') THEN
      PERFORM c.id FROM public.poker_diamond_custody c
       WHERE c.user_id=p_user_id AND c.purpose='tournament_entry'
         AND c.target_id=p_tournament_id AND c.state='active'
       FOR UPDATE NOWAIT;
      IF FOUND THEN
        PERFORM 1 FROM public.profiles p WHERE p.id=p_user_id FOR UPDATE NOWAIT;
      END IF;
    END IF;
    v_response:=public.fn_ca_process_tournament_chip_purchase_money_v1(
      p_tournament_id,p_user_id,v_type,p_cost,p_chips,v_t.current_level,
      v_receipt_key);
    IF COALESCE((v_response->>'success')::boolean,false) IS NOT TRUE
       OR COALESCE((v_response->>'idempotent')::boolean,false) THEN
      RAISE EXCEPTION 'tournament add-on money core did not commit a new purchase'
        USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
    SELECT s.* INTO v_final_seat FROM public.table_seats s
     WHERE s.id=v_live.id;
    IF v_player.status::text<>'playing' OR NOT COALESCE(v_player.add_on,false)
       OR v_final_seat.left_at IS NOT NULL
       OR v_final_seat.user_id IS DISTINCT FROM p_user_id
       OR v_final_seat.stack IS DISTINCT FROM v_player.chips::numeric
       OR v_final_seat.stack<=0 OR v_final_seat.stack<>trunc(v_final_seat.stack) THEN
      RAISE EXCEPTION 'atomic add-on seat/roster proof is not exact'
        USING ERRCODE='P0404';
    END IF;
    v_wake_id:=public.fn_emit_tournament_manager_wake(p_tournament_id,'addon');
    v_response:=v_response||jsonb_build_object(
      'success',true,'seated',true,'atomic_tournament_chip_purchase','v1',
      'rebuy_type',v_type,'seat_id',v_final_seat.id,
      'table_id',v_final_seat.table_id,
      'seat_number',v_final_seat.seat_number,'stack',v_final_seat.stack,
      'manager_wake_id',v_wake_id);
  ELSE
    v_table_id:=v_candidate_peek.table_id;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('atomic-table:'||v_table_id::text,0));
    -- Preserve the complete acquisition order and refusal precedence before
    -- nonblocking player admission. The original helper reenters these locks.
    PERFORM pg_advisory_xact_lock_shared(530093);
    IF NOT EXISTS(SELECT 1 FROM public.ca_operator_floor_hold h JOIN public.ca_launch_operator_scopes m ON m.operation_id=h.operation_id JOIN public.tournaments t ON t.id=p_tournament_id WHERE h.mode='park' AND (t.club_id=ANY(m.club_ids) OR t.union_id=ANY(m.club_ids)) AND NOT EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t.id AND tp.user_id=p_user_id)) THEN
      PERFORM pg_advisory_xact_lock_shared(530090,1);
      PERFORM public.fn_ca_lock_mtt_admission_contract();
      IF NOT public.fn_entry_purchases_frozen() THEN
        IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0)) THEN
          RAISE EXCEPTION 'TOURNAMENT_PURCHASE_PLAYER_BUSY: retry this same purchase request'
            USING ERRCODE='55P03';
        END IF;
        IF NOT pg_try_advisory_xact_lock(hashtextextended('daily-missions-user:' || p_user_id::text, 0)) THEN
          RAISE EXCEPTION 'TOURNAMENT_PURCHASE_PLAYER_BUSY: retry this same purchase request'
            USING ERRCODE='55P03';
        END IF;
        IF public.fn_ca_tournament_unit_cents(p_tournament_id)=100 THEN
          -- Its existing custody-add later needs this strongest wallet mode.
          -- Admit it now or refuse before any held KEY SHARE can queue an upgrade.
          PERFORM 1 FROM public.profiles p WHERE p.id=p_user_id FOR UPDATE NOWAIT;
        ELSE
          PERFORM 1 FROM public.profiles p WHERE p.id=p_user_id FOR NO KEY UPDATE NOWAIT;
        END IF;
      END IF;
    END IF;
    v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
      p_tournament_id,NULL,p_user_id);
    IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament rebuy root refused: %',
        COALESCE(v_gate->>'reason','unknown') USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_t FROM public.tournaments t
     WHERE t.id=p_tournament_id;
    IF COALESCE(v_t.prize_pool_finalized,false)
       OR upper(COALESCE(v_t.status::text,''))<>'RUNNING' THEN
      RAISE EXCEPTION 'Tournament is not accepting rebuys or re-entries'
        USING ERRCODE='55000';
    END IF;
    v_rebuy_window:=public.fn_ca_tournament_rebuy_window(p_tournament_id);
    IF COALESCE((v_rebuy_window->>'open')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Rebuy period is closed: %',
        COALESCE(v_rebuy_window->>'reason','unknown') USING ERRCODE='55000';
    END IF;

    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     FOR UPDATE;
    IF NOT FOUND OR v_player.status::text NOT IN ('playing','eliminated')
       OR COALESCE(v_player.chips,0)>0 OR COALESCE(v_player.prize,0)>0 THEN
      RAISE EXCEPTION 'Only the exact unpaid zero-stack entry may rebuy'
        USING ERRCODE='55000';
    END IF;

    PERFORM c.id FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
     ORDER BY c.hand_number,c.id FOR UPDATE;
    SELECT count(*) FILTER (WHERE c.state='pending')::integer
      INTO v_pending_count
      FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id;
    SELECT * INTO v_candidate
      FROM public.tournament_knockout_candidates c
     WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
       p_tournament_id,p_user_id);
    IF v_candidate.id IS DISTINCT FROM v_candidate_peek.id
       OR v_candidate.state NOT IN ('pending','eliminated')
       OR (v_candidate.state='pending' AND
           (v_pending_count<>1 OR v_player.status::text<>'playing'))
       OR (v_candidate.state='eliminated' AND
           (v_pending_count<>0 OR v_player.status::text<>'eliminated'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates prior
          WHERE prior.tournament_id=p_tournament_id
            AND prior.eliminated_user_id=p_user_id
            AND (prior.hand_number,prior.id)<
                (v_candidate.hand_number,v_candidate.id)
            AND prior.state<>'rebought') THEN
      RAISE EXCEPTION 'UNRESOLVED_KNOCKOUT_GENERATION_CHAIN'
        USING ERRCODE='P0404';
    END IF;
    IF v_candidate.state='pending'
       AND (v_candidate.rebuy_prompt_until IS NULL
            OR v_candidate.rebuy_prompt_until<=clock_timestamp()) THEN
      RAISE EXCEPTION 'Rebuy or re-entry decision window has closed'
        USING ERRCODE='55000';
    END IF;
    IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
       OR COALESCE(v_t.is_mystery_bounty,false) THEN
      v_bounty_settlement:=
        public.fn_ca_settle_bounty_rebuy_generation_v1(
          p_tournament_id,p_user_id,v_candidate.id);
      -- A MYSTERY REBUY BEFORE THE MONEY HAS NO HEAD TO SETTLE (2026-10-24):
      -- only that exact answer, on a mystery event, may stand in for an
      -- obligation. Every other answer still needs a settled, marked one.
      v_no_bounty_head:=
        COALESCE(v_t.is_mystery_bounty,false)
        AND COALESCE(v_bounty_settlement->>'no_bounty_head','false')='true'
        AND v_bounty_settlement->>'mode'='mystery_pre'
        AND COALESCE(v_bounty_settlement->>'obligation_id','')='';
      BEGIN
        v_bounty_obligation_id:=
          (v_bounty_settlement->>'obligation_id')::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Bounty settlement returned no exact generation id'
          USING ERRCODE='P0404';
      END;
      IF COALESCE((v_bounty_settlement->>'ok')::boolean,false) IS NOT TRUE
         OR COALESCE(v_bounty_settlement->>'marker_verified','false')<>'true'
         OR COALESCE(v_bounty_settlement->>'old_head_cleared','false')<>'true'
         OR NOT v_no_bounty_head AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id
              AND o.tournament_id=p_tournament_id
              AND o.eliminated_user_id=p_user_id
              AND o.hand_number=v_candidate.hand_number
              AND o.hand_id=v_candidate.hand_id
              AND o.state='settled'
              AND public.fn_bounty_obligation_has_complete_marker(o.id)) THEN
        RAISE EXCEPTION
          'Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry Generation Yet'
          USING ERRCODE='55000';
      END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.tournament_obligations o
       WHERE o.tournament_id=p_tournament_id AND o.user_id=p_user_id
         AND o.kind='bubble_protection' AND o.amount_paid=o.amount_owed
         AND o.amount_paid>0 AND o.settled_at IS NOT NULL) THEN
      RAISE EXCEPTION
        'Bubble Protection Already Paid - This Result Cannot Be Resurrected'
        USING ERRCODE='55000';
    END IF;

    PERFORM s.id
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL
     ORDER BY s.id FOR UPDATE OF s;
    SELECT count(*)::integer INTO v_live_count
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    IF v_live_count>1 THEN
      RAISE EXCEPTION 'tournament rebuy found multiple live seats'
        USING ERRCODE='P0404';
    ELSIF v_live_count=1 THEN
      SELECT s.* INTO v_live
        FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
         AND s.left_at IS NULL FOR UPDATE OF s;
      IF v_live.id IS DISTINCT FROM v_candidate.seat_id
         OR v_live.table_id IS DISTINCT FROM v_candidate.table_id
         OR v_live.joined_at IS DISTINCT FROM v_candidate.seat_joined_at
         OR COALESCE(v_live.stack,0)<>0 THEN
        RAISE EXCEPTION 'knockout generation has a different live seat'
          USING ERRCODE='P0404';
      END IF;
      v_table_id:=v_live.table_id;
      v_seat_number:=v_live.seat_number;
    END IF;

    v_response:=public.fn_ca_process_tournament_chip_purchase_money_v1(
      p_tournament_id,p_user_id,v_type,p_cost,p_chips,v_t.current_level,
      v_effective_token);
    IF COALESCE((v_response->>'success')::boolean,false) IS NOT TRUE
       OR COALESCE((v_response->>'idempotent')::boolean,false) THEN
      RAISE EXCEPTION 'tournament rebuy money core did not commit a new purchase'
        USING ERRCODE='P0404';
    END IF;

    -- A seatless eliminated entry is not counted as active capacity until the
    -- money core promotes it. Choose the chair only after that in-transaction
    -- promotion; any capacity/assignment failure below aborts the debit and
    -- every pool leg with it, so a purchase can never commit seatless.
    IF v_live_count=0 THEN
      v_choice:=public.fn_ca_choose_tournament_seat_locked(
        p_tournament_id,p_user_id,v_candidate.table_id,
        (SELECT s.seat_number FROM public.table_seats s
          WHERE s.id=v_candidate.seat_id));
      v_table_id:=(v_choice->>'table_id')::uuid;
      v_seat_number:=(v_choice->>'seat_number')::integer;
    END IF;

    UPDATE public.tournament_knockout_candidates c
       SET state='rebought',resolved_at=clock_timestamp()
     WHERE c.id=v_candidate.id AND c.state=v_candidate.state
       AND c.state IN ('pending','eliminated');
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'exact knockout generation did not close with its purchase'
        USING ERRCODE='55000';
    END IF;
    UPDATE public.tournament_players tp
       SET rebuy_prompt_until=NULL
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;

    -- An old-pod zero seat can still be live during the rolling window. The
    -- money core fills that locked chair; advancing joined_at begins the new
    -- paid entry generation so a later same-chair bust has a new identity. A
    -- new paid generation is also playable state: clear only lifecycle flags
    -- owned by the expired generation while preserving this player's persisted
    -- time bank and auto-rebuy preference. Naming user_id deliberately reruns
    -- the canonical horse and club stamp triggers for the same occupant.
    IF v_live_count=1 THEN
      v_expected_club_id:=public.fn_seat_club_for_user(
        p_user_id,v_live.table_id,v_player.club_id);
      SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
        INTO v_expected_horse_id
        FROM public.profiles p
       WHERE p.id=p_user_id;
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=NULL,member_id=NULL,
             joined_at=clock_timestamp(),status='active',
             is_sitting_out=false,is_away=false,leave_pending=false,
             sit_out_at=NULL,scheduled_leave_hands=NULL,
             horse_id=v_expected_horse_id,club_id=v_expected_club_id,
             entry_hold=NULL,entry_post_agreed=false
       WHERE s.id=v_live.id AND s.left_at IS NULL
         AND s.user_id=p_user_id
         AND s.joined_at=v_candidate.seat_joined_at;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'rebuy could not advance the live seat generation'
          USING ERRCODE='55000';
      END IF;
    END IF;

    v_assignment:=public.fn_ca_assign_tournament_player_seat_locked(
      p_tournament_id,p_user_id,v_table_id,v_seat_number);
    IF COALESCE((v_assignment->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'paid rebuy could not commit its chosen seat: %',
        COALESCE(v_assignment->>'reason','unknown') USING ERRCODE='55000';
    END IF;

    PERFORM s.id
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL
     ORDER BY s.id FOR UPDATE OF s;
    SELECT count(*)::integer INTO v_live_count
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    SELECT s.* INTO v_final_seat
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id
       AND s.left_at IS NULL;
    SELECT * INTO v_player FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
    v_expected_club_id:=public.fn_seat_club_for_user(
      p_user_id,v_final_seat.table_id,v_player.club_id);
    SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
      INTO v_expected_horse_id
      FROM public.profiles p
     WHERE p.id=p_user_id;
    IF v_live_count<>1 OR v_final_seat.id IS NULL
       OR v_final_seat.stack IS NULL OR v_final_seat.stack<=0
       OR v_final_seat.stack<>trunc(v_final_seat.stack)
       OR v_final_seat.stack IS DISTINCT FROM v_player.chips::numeric
       OR v_final_seat.status::text<>'active'
       OR COALESCE(v_final_seat.is_sitting_out,false)
       OR COALESCE(v_final_seat.is_away,false)
       OR COALESCE(v_final_seat.leave_pending,false)
       OR v_final_seat.sit_out_at IS NOT NULL
       OR v_final_seat.scheduled_leave_hands IS NOT NULL
       OR v_final_seat.entry_hold IS NOT NULL
       OR v_final_seat.entry_post_agreed
       OR v_final_seat.player_id IS NOT NULL
       OR v_final_seat.member_id IS NOT NULL
       OR v_final_seat.horse_id IS DISTINCT FROM v_expected_horse_id
       OR v_final_seat.club_id IS DISTINCT FROM v_expected_club_id
       OR v_player.status::text<>'playing'
       OR v_player.table_id IS DISTINCT FROM v_final_seat.table_id
       OR v_player.seat_number IS DISTINCT FROM v_final_seat.seat_number
       OR ((COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false)) AND (
         (v_bounty_obligation_id IS NULL AND NOT v_no_bounty_head)
         OR round(COALESCE(v_player.current_bounty,0),2) IS DISTINCT FROM
              round(COALESCE((v_response->>'bounty_head_funded')::numeric,0),2)
         OR NOT v_no_bounty_head AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id AND o.state='settled'
              AND public.fn_bounty_obligation_has_complete_marker(o.id))))
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c
          WHERE c.id=v_candidate.id AND c.state='rebought')
       OR EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c
          WHERE c.tournament_id=p_tournament_id
            AND c.eliminated_user_id=p_user_id AND c.state='pending')
       OR NOT EXISTS (
         SELECT 1 FROM public.tables tb
          WHERE tb.id=v_final_seat.table_id
            AND tb.current_players=(
              SELECT count(*) FROM public.table_seats s
               WHERE s.table_id=tb.id AND s.left_at IS NULL)) THEN
      RAISE EXCEPTION 'atomic rebuy candidate/seat/roster proof is not exact'
        USING ERRCODE='P0404';
    END IF;
    v_wake_id:=public.fn_emit_tournament_manager_wake(p_tournament_id,v_type);
    v_response:=v_response||jsonb_build_object(
      'success',true,'seated',true,'atomic_tournament_chip_purchase','v1',
      'rebuy_type',v_type,'candidate_id',v_candidate.id,
      'candidate_state','rebought','seat_id',v_final_seat.id,
      'table_id',v_final_seat.table_id,
      'seat_number',v_final_seat.seat_number,'stack',v_final_seat.stack,
      'prior_bounty_obligation_id',v_bounty_obligation_id,
      'prior_bounty_marker_verified',
        CASE WHEN v_bounty_obligation_id IS NULL THEN NULL ELSE true END,
      'manager_wake_id',v_wake_id);
  END IF;

  v_recorded:=public.fn_record_entry_purchase_receipt(
    'tournament_chip_purchase',v_receipt_key,v_request,v_response);
  IF v_recorded IS DISTINCT FROM v_response THEN
    RAISE EXCEPTION 'atomic tournament chip-purchase receipt changed at commit'
      USING ERRCODE='P0404';
  END IF;
  PERFORM set_config(
    'app.money_path',COALESCE(v_previous_money_path,''),true);
  RETURN v_recorded;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'app.money_path',COALESCE(v_previous_money_path,''),true);
  RAISE;
END;
$function$

