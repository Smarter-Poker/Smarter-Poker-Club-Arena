-- Empty bounty read relations: no bounty payout writer is exercised here.
CREATE TABLE public.tournament_bounty_awards(id uuid PRIMARY KEY,bounty_obligation_id uuid,status text,amount_cents bigint);
CREATE TABLE public.tournament_bounty_award_recipients(award_id uuid,user_id uuid,amount_cents bigint,paid_at timestamptz);
CREATE TABLE public.tournament_bounties(bounty_obligation_id uuid,collector_player_id uuid,bounty_amount numeric,added_to_collector_bounty numeric);
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('test.jwt_role',true),''),'authenticated') $$;
-- Installed tournament purchase, generation, seating and funding functions.
-- Loaded after the registration-funding fixture. See README.md for boundaries.
CREATE TABLE public.hand_atomic_commits (
table_id uuid NOT NULL,
hand_number bigint NOT NULL,
hand_id uuid NOT NULL,
payload_hash text NOT NULL,
stack_result jsonb NOT NULL,
committed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
post_commit_payload jsonb,
post_commit_request_hash text,
post_commit_payload_hash text,
post_commit_completed_at timestamp with time zone,
post_commit_result jsonb,
CONSTRAINT hand_atomic_commits_hand_id_key UNIQUE (hand_id),
CONSTRAINT hand_atomic_commits_hand_number_check CHECK (hand_number >= 1000000),
CONSTRAINT hand_atomic_commits_hand_number_key UNIQUE (hand_number),
CONSTRAINT hand_atomic_commits_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'::text),
CONSTRAINT hand_atomic_commits_pkey PRIMARY KEY (table_id, hand_number)
);
CREATE INDEX idx_hand_atomic_commits_post_commit_pending ON public.hand_atomic_commits USING btree (table_id, hand_number) WHERE ((post_commit_payload IS NOT NULL) AND (post_commit_completed_at IS NULL));
CREATE TABLE public.settlement_idempotency_keys (
table_id uuid NOT NULL,
hand_id uuid NOT NULL,
status text DEFAULT 'in_flight'::text NOT NULL,
result jsonb,
error text,
attempt_count integer DEFAULT 1 NOT NULL,
first_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
last_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
completed_at timestamp with time zone,
CONSTRAINT settlement_idempotency_keys_pkey PRIMARY KEY (table_id, hand_id),
CONSTRAINT settlement_idempotency_keys_status_check CHECK (status = ANY (ARRAY['in_flight'::text, 'succeeded'::text, 'failed'::text]))
);
CREATE INDEX idx_settlement_idem_status_age ON public.settlement_idempotency_keys USING btree (status, last_attempt_at DESC) WHERE (status = 'in_flight'::text);
CREATE INDEX idx_settlement_idem_table_completed_succeeded ON public.settlement_idempotency_keys USING btree (table_id, completed_at DESC) WHERE (status = 'succeeded'::text);
CREATE TABLE public.tournament_bounty_obligations (
id uuid DEFAULT gen_random_uuid() NOT NULL,
tournament_id uuid NOT NULL,
eliminated_user_id uuid NOT NULL,
table_id uuid NOT NULL,
hand_id uuid NOT NULL,
hand_number bigint NOT NULL,
settlement_completed_at timestamp with time zone NOT NULL,
seat_joined_at timestamp with time zone NOT NULL,
"position" integer NOT NULL,
prize numeric(20,2) NOT NULL,
bubble_refund numeric(20,2) DEFAULT 0 NOT NULL,
mode text NOT NULL,
activation_generation bigint DEFAULT 0 NOT NULL,
head_amount numeric(20,2) NOT NULL,
knocker_user_id uuid NOT NULL,
claimants jsonb NOT NULL,
state text DEFAULT 'pending'::text NOT NULL,
attempt_count integer DEFAULT 0 NOT NULL,
next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
last_error text,
created_at timestamp with time zone DEFAULT now() NOT NULL,
settled_at timestamp with time zone,
CONSTRAINT tournament_bounty_obligations_activation_generation_check CHECK (activation_generation >= 0),
CONSTRAINT tournament_bounty_obligations_attempt_count_check CHECK (attempt_count >= 0),
CONSTRAINT tournament_bounty_obligations_bubble_refund_check CHECK (bubble_refund >= 0::numeric),
CONSTRAINT tournament_bounty_obligations_check CHECK (mode = 'mystery_chest'::text AND activation_generation > 0 OR mode <> 'mystery_chest'::text AND activation_generation = 0),
CONSTRAINT tournament_bounty_obligations_claimants_check CHECK (jsonb_typeof(claimants) = 'array'::text),
CONSTRAINT tournament_bounty_obligations_hand_number_check CHECK (hand_number >= 1000000),
CONSTRAINT tournament_bounty_obligations_head_amount_check CHECK (head_amount > 0::numeric),
CONSTRAINT tournament_bounty_obligations_mode_check CHECK (mode = ANY (ARRAY['regular'::text, 'pko'::text, 'mystery_pre'::text, 'mystery_chest'::text])),
CONSTRAINT tournament_bounty_obligations_pkey PRIMARY KEY (id),
CONSTRAINT tournament_bounty_obligations_position_check CHECK ("position" >= 2),
CONSTRAINT tournament_bounty_obligations_prize_check CHECK (prize >= 0::numeric),
CONSTRAINT tournament_bounty_obligations_state_check CHECK (state = ANY (ARRAY['pending'::text, 'settled'::text])),
CONSTRAINT tournament_bounty_obligations_tournament_id_eliminated_user_key UNIQUE (tournament_id, eliminated_user_id, seat_joined_at),
CONSTRAINT tournament_bounty_obligations_tournament_id_hand_number_eli_key UNIQUE (tournament_id, hand_number, eliminated_user_id)
);
CREATE INDEX idx_tournament_bounty_obligations_pending ON public.tournament_bounty_obligations USING btree (next_attempt_at, created_at) WHERE (state = 'pending'::text);
CREATE INDEX idx_tournament_bounty_obligations_user_hand ON public.tournament_bounty_obligations USING btree (tournament_id, eliminated_user_id, hand_number DESC);
CREATE TABLE public.tournament_capacity_table_receipts (
table_id uuid NOT NULL,
tournament_id uuid NOT NULL,
manager_wake_id bigint NOT NULL,
created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
manager_admitted_at timestamp with time zone,
updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
CONSTRAINT tournament_capacity_table_receipts_pkey PRIMARY KEY (table_id)
);
CREATE INDEX idx_tournament_capacity_table_receipts_pending ON public.tournament_capacity_table_receipts USING btree (tournament_id, created_at, table_id) WHERE (manager_admitted_at IS NULL);
CREATE TABLE public.tournament_knockout_candidates (
id uuid DEFAULT gen_random_uuid() NOT NULL,
tournament_id uuid NOT NULL,
eliminated_user_id uuid NOT NULL,
table_id uuid NOT NULL,
seat_id uuid NOT NULL,
seat_joined_at timestamp with time zone NOT NULL,
hand_id uuid NOT NULL,
hand_number bigint NOT NULL,
stack_before numeric(20,2) NOT NULL,
stack_after numeric(20,2) NOT NULL,
state text DEFAULT 'pending'::text NOT NULL,
rebuy_prompt_until timestamp with time zone,
created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
resolved_at timestamp with time zone,
CONSTRAINT tournament_knockout_candidate_tournament_id_eliminated_user_key UNIQUE (tournament_id, eliminated_user_id, seat_joined_at),
CONSTRAINT tournament_knockout_candidate_tournament_id_hand_number_eli_key UNIQUE (tournament_id, hand_number, eliminated_user_id),
CONSTRAINT tournament_knockout_candidates_hand_number_check CHECK (hand_number >= 1000000),
CONSTRAINT tournament_knockout_candidates_pkey PRIMARY KEY (id),
CONSTRAINT tournament_knockout_candidates_stack_after_check CHECK (stack_after = 0::numeric),
CONSTRAINT tournament_knockout_candidates_stack_before_check CHECK (stack_before > 0::numeric),
CONSTRAINT tournament_knockout_candidates_state_check CHECK (state = ANY (ARRAY['pending'::text, 'rebought'::text, 'eliminated'::text, 'winner'::text]))
);
CREATE INDEX idx_tournament_knockout_candidates_user_hand ON public.tournament_knockout_candidates USING btree (tournament_id, eliminated_user_id, hand_number DESC, id DESC);
CREATE INDEX idx_tournament_knockout_candidates_pending ON public.tournament_knockout_candidates USING btree (tournament_id, hand_number, eliminated_user_id) WHERE (state = 'pending'::text);
CREATE TABLE public.tournament_manager_wakes (
id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
tournament_id uuid NOT NULL,
reason text NOT NULL,
generation bigint DEFAULT 1 NOT NULL,
created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
consumed_at timestamp with time zone,
CONSTRAINT tournament_manager_wakes_generation_check CHECK (generation > 0),
CONSTRAINT tournament_manager_wakes_pkey PRIMARY KEY (id),
CONSTRAINT tournament_manager_wakes_reason_check CHECK (reason = ANY (ARRAY['rebuy'::text, 'reentry'::text, 'addon'::text, 'late_registration'::text, 'deal_vote'::text, 'bounty_settled'::text]))
);
CREATE INDEX idx_tournament_manager_wakes_pending ON public.tournament_manager_wakes USING btree (created_at, id) WHERE (consumed_at IS NULL);
CREATE UNIQUE INDEX uq_tournament_manager_wakes_pending_by_reason ON public.tournament_manager_wakes USING btree (tournament_id, reason) WHERE (consumed_at IS NULL);
CREATE SEQUENCE IF NOT EXISTS public.tournament_player_elimination_sequence;
CREATE OR REPLACE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.fn_ca_process_tournament_chip_purchase_money_v1(p_tournament_id uuid, p_user_id uuid, p_rebuy_type text, p_cost numeric, p_chips numeric, p_current_level integer, p_client_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_p record;
  v_balance numeric;
  v_ratio numeric;
  v_is_bounty boolean;
  v_bounty_head numeric;
  v_base numeric;
  v_fee numeric;
  v_total numeric;
  v_add integer;
  v_new_chips integer;
  v_seat record;
  v_key text;
  v_inserted integer;
  v_cat text;
  v_club uuid;
  v_stack_after numeric;
  v_expected numeric;
  v_fee_ratio numeric;
  v_was_seated boolean:=false;
  v_rows integer;
  v_led_cat text;
  v_led_cp text;
  v_led_ent text;
  v_led_tid text;
BEGIN
  IF NOT (COALESCE(auth.role(),'service_role')='service_role')
     AND (auth.uid() IS NULL OR auth.uid()<>p_user_id) THEN
    RAISE EXCEPTION
      'process_tournament_rebuy: caller may only transact for themselves'
      USING ERRCODE='42501';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %',p_rebuy_type
      USING ERRCODE='22023';
  END IF;
  IF p_client_token IS NULL OR length(btrim(p_client_token))=0
     OR length(btrim(p_client_token))>128 THEN
    RAISE EXCEPTION 'exact tournament chip-purchase token is required'
      USING ERRCODE='22023';
  END IF;

  SELECT id,name,club_id,status,buy_in_amount,buy_in_fee,starting_chips,
         is_rebuy,is_reentry,add_on_available,addon_period_triggered,
         rebuy_cost,rebuy_chips,rebuy_levels,late_reg_levels,max_rebuys,
         max_reentries,addon_cost,addon_chips,addon_levels,current_level,
         prize_pool,is_bounty,is_pko,is_mystery_bounty,bounty_amount
    INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  IF v_t.status NOT IN ('RUNNING','REGISTERING','ANNOUNCED') THEN
    RAISE EXCEPTION 'Tournament is not accepting chip purchases (status %)',v_t.status;
  END IF;

  SELECT id,chips,status,prize,rebuys,add_on,table_id,club_id
    INTO v_p
    FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;
  IF v_p.status='eliminated' AND COALESCE(v_p.prize,0)>0 THEN
    RAISE EXCEPTION
      'Finishing Place Already Paid - A Rebuy Cannot Resurrect A Settled Result';
  END IF;
  v_club:=v_p.club_id;
  IF v_club IS NULL THEN
    RAISE EXCEPTION
      'Tournament entry funding club is missing; refusing a substituted wallet'
      USING ERRCODE='P0404';
  END IF;

  v_cat:=CASE WHEN p_rebuy_type='addon' THEN 'addon' ELSE 'rebuy' END;
  v_key:=CASE WHEN p_rebuy_type='addon'
    THEN 'tourney:'||p_tournament_id::text||':addon:'||p_user_id::text
    ELSE 'tourney:'||p_tournament_id::text||':'||p_rebuy_type||':'||
         p_user_id::text||':tok:'||btrim(p_client_token)
  END;

  IF p_rebuy_type='addon' THEN
    PERFORM 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL
       AND tb.tournament_id=p_tournament_id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'No Live Seat For This % - Aborting So No Charge Is Made',p_rebuy_type;
    END IF;
    IF NOT COALESCE(v_t.add_on_available,false) THEN
      RAISE EXCEPTION 'Add-ons are not offered in this tournament';
    END IF;
    IF COALESCE(v_p.add_on,false) THEN
      RAISE EXCEPTION 'Add-on already taken';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.addon_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.addon_chips,0),v_t.starting_chips,0)::integer;
  ELSE
    IF p_rebuy_type='rebuy' AND NOT COALESCE(v_t.is_rebuy,false) THEN
      RAISE EXCEPTION 'Rebuys are not offered in this tournament';
    END IF;
    IF p_rebuy_type='reentry' AND NOT COALESCE(v_t.is_reentry,false) THEN
      RAISE EXCEPTION 'Re-entries are not offered in this tournament';
    END IF;
    IF p_rebuy_type='rebuy' AND v_t.max_rebuys IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_rebuys THEN
      RAISE EXCEPTION 'Rebuy limit reached (% of %)',v_p.rebuys,v_t.max_rebuys;
    END IF;
    IF p_rebuy_type='reentry' AND v_t.max_reentries IS NOT NULL
       AND COALESCE(v_p.rebuys,0)>=v_t.max_reentries THEN
      RAISE EXCEPTION
        'Re-entry limit reached (% of %)',v_p.rebuys,v_t.max_reentries;
    END IF;
    IF p_rebuy_type='rebuy'
       AND COALESCE(v_p.chips,0)>COALESCE(v_t.starting_chips,0) THEN
      RAISE EXCEPTION 'Stack too high for a rebuy';
    END IF;
    v_base:=COALESCE(NULLIF(v_t.rebuy_cost,0),v_t.buy_in_amount,0);
    v_add:=COALESCE(NULLIF(v_t.rebuy_chips,0),v_t.starting_chips,0)::integer;
  END IF;

  v_fee_ratio:=CASE
    WHEN COALESCE(v_t.buy_in_amount,0)+COALESCE(v_t.buy_in_fee,0)>0
         AND COALESCE(v_t.buy_in_fee,0)>0
      THEN v_t.buy_in_fee/(v_t.buy_in_amount+v_t.buy_in_fee)
    ELSE 0.1
  END;
  v_ratio:=CASE WHEN p_rebuy_type='addon' THEN 0 ELSE v_fee_ratio END;
  v_total:=round(v_base::numeric);
  -- The total stays a whole chip, while the house cut is floored to cents.
  -- Fractional fees are deliberate: a 1-chip entry pays 0.10 and a 5-chip
  -- entry pays 0.50 without ever exceeding the ten-percent ceiling.
  v_fee:=CASE WHEN v_ratio>0 AND v_total>0
    THEN LEAST(trunc(v_total*v_ratio*100+0.000001)/100,
               trunc(v_total*0.1*100+0.000001)/100)
    ELSE 0
  END;
  v_base:=round(v_total-v_fee,2);
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
    OR COALESCE(v_t.is_pko,false)
    OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type<>'addon' THEN
    v_bounty_head:=LEAST(
      GREATEST(0,round(COALESCE(v_t.bounty_amount,0),2)),v_base);
    v_base:=v_base-v_bounty_head;
  ELSE
    v_bounty_head:=0;
  END IF;
  IF p_cost IS NOT NULL AND abs(p_cost-v_total)>0.01 THEN
    RAISE EXCEPTION
      'Price mismatch: client quoted %, server computed %',p_cost,v_total
      USING ERRCODE='22023';
  END IF;
  IF v_add<=0 OR v_total<0 OR v_fee<0 OR v_base<0 OR v_bounty_head<0
     OR round(v_base+v_bounty_head+v_fee,2)<>round(v_total,2) THEN
    RAISE EXCEPTION 'Tournament chip-purchase quote does not conserve'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_total)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN
    RETURN jsonb_build_object(
      'success',true,'idempotent',true,'new_stack',v_p.chips,
      'rebuy_type',p_rebuy_type);
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id,v_club);
  SELECT chip_balance INTO v_balance
    FROM public.club_members
   WHERE user_id=p_user_id AND club_id=v_club
   FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN
    RAISE EXCEPTION 'Insufficient club chips: need %, have %',
      v_total,COALESCE(v_balance,0);
  END IF;

  v_led_cat:=current_setting('app.ledger_category',true);
  v_led_cp:=current_setting('app.ledger_counterparty',true);
  v_led_ent:=current_setting('app.ledger_counterparty_entity',true);
  v_led_tid:=current_setting('app.ledger_tournament',true);
  PERFORM set_config('app.ledger_category',v_cat,true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  UPDATE public.club_members
     SET chip_balance=chip_balance-v_total,updated_at=now()
   WHERE user_id=p_user_id AND club_id=v_club;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Exact tournament funding wallet changed during debit'
      USING ERRCODE='40001';
  END IF;
  PERFORM set_config('app.ledger_category',COALESCE(v_led_cat,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_led_cp,''),true);
  PERFORM set_config(
    'app.ledger_counterparty_entity',COALESCE(v_led_ent,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_led_tid,''),true);

  IF p_rebuy_type='reentry' THEN
    UPDATE public.tournament_players
       SET chips=v_add,status='playing',eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,add_on=true
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSE
    UPDATE public.tournament_players
       SET chips=COALESCE(chips,0)+v_add,status='playing',
           eliminated_at=NULL,position=NULL,
           rebuys=COALESCE(rebuys,0)+1
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  END IF;
  IF v_new_chips IS NULL THEN
    RAISE EXCEPTION 'Locked tournament roster changed during chip grant'
      USING ERRCODE='40001';
  END IF;

  IF v_bounty_head>0 THEN
    UPDATE public.tournament_players
       SET current_bounty=CASE WHEN p_rebuy_type='reentry'
         THEN v_bounty_head
         ELSE COALESCE(current_bounty,0)+v_bounty_head END
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id;
  END IF;

  SELECT s.id,s.stack INTO v_seat
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND tb.tournament_id=p_tournament_id
   ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC,
            s.joined_at DESC NULLS LAST,s.id DESC
   LIMIT 1;
  IF FOUND THEN
    v_was_seated:=true;
    UPDATE public.table_seats
       SET stack=CASE WHEN p_rebuy_type='reentry'
         THEN v_add ELSE COALESCE(stack,0)+v_add END
     WHERE id=v_seat.id
     RETURNING stack INTO v_stack_after;
    v_expected:=CASE WHEN p_rebuy_type='reentry'
      THEN v_add ELSE COALESCE(v_seat.stack,0)+v_add END;
    IF v_stack_after IS NULL OR v_stack_after<>v_expected THEN
      RAISE EXCEPTION
        'Chip Grant Did Not Land: % Expected Stack %, Seat % Holds % - Aborting So No Charge Is Made',
        p_rebuy_type,v_expected,v_seat.id,v_stack_after;
    END IF;
    UPDATE public.tournament_players
       SET chips=(SELECT stack FROM public.table_seats WHERE id=v_seat.id)::integer
     WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type='addon' THEN
    RAISE EXCEPTION
      'Seat Disappeared During % - Aborting So No Charge Is Made',p_rebuy_type;
  END IF;

  UPDATE public.tournaments
     SET prize_pool=COALESCE(prize_pool,0)+v_base,
         bounty_pool=COALESCE(bounty_pool,0)+v_bounty_head
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'Tournament vanished during chip-purchase pool booking'
      USING ERRCODE='40001';
  END IF;

  IF v_fee>0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_t.club_id,v_fee,v_fee,1,0,true,p_tournament_id,
      'process_tournament_rebuy',jsonb_build_object(
        'kind','tournament_'||p_rebuy_type||'_fee','user_id',p_user_id,
        'entry_club_id',v_club));
    UPDATE public.tournaments
       SET total_rake=COALESCE(total_rake,0)+v_fee
     WHERE id=p_tournament_id;
  END IF;

  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,
    related_entity_id,balance_after)
  VALUES(
    p_user_id,'PLAYER','debit',v_total,v_cat,
    'Tournament '||p_rebuy_type||': '||COALESCE(v_t.name,'tournament')||
      ' ('||v_base||' prize + '||v_bounty_head||' bounty + '||v_fee||
      ' fee) [club wallet]',
    p_tournament_id,v_balance-v_total);

  RETURN jsonb_build_object(
    'success',true,'new_stack',v_new_chips,'rebuy_type',p_rebuy_type,
    'chips_added',v_add,'cost',v_total,'fee',v_fee,'seated',v_was_seated,
    'bounty_head_funded',v_bounty_head);
END;
$function$;

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
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
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
        USING ERRCODE='40001';
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
       OR (v_type='rebuy' AND v_candidate.state<>'pending')
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
    IF (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations o
          WHERE o.tournament_id=p_tournament_id
            AND o.eliminated_user_id=p_user_id
            AND o.hand_number=v_candidate.hand_number
            AND o.hand_id=v_candidate.hand_id
            AND o.state='settled'
            AND public.fn_bounty_obligation_has_complete_marker(o.id)) THEN
      RAISE EXCEPTION
        'Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry Generation Yet'
        USING ERRCODE='55000';
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
        USING ERRCODE='40001';
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
          USING ERRCODE='40001';
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_assign_tournament_player_seat_locked(p_tournament_id uuid, p_user_id uuid, p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_tp public.tournament_players%ROWTYPE;
  v_table public.tables%ROWTYPE;
  v_live public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_live_count integer;
  v_stack numeric;
  v_felt_stack numeric;
  v_live_total numeric;
  v_own_live numeric;
  v_cap_chips numeric;
  v_cap integer;
  v_seat_id uuid;
  v_current_players integer;
  v_rows integer;
  v_assigned_at timestamptz;
  v_expected_club_id uuid;
  v_expected_horse_id uuid;
  -- Fresh tournament-seat defaults. A rebuy that keeps its live chair keeps
  -- its own persisted bank; only a newly inserted/revived occupant starts the
  -- same 30-second/four-use state as a physical INSERT.
  v_time_bank_uses integer:=4;
  v_time_bank_seconds integer:=30;
  v_previous_money_path text:=current_setting('app.money_path',true);
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
     OR p_seat_number IS NULL OR p_seat_number NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'tournament, player, table and legal seat are required'
      USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_assignable',
      'status',upper(COALESCE(v_t.status::text,'')));
  END IF;
  v_cap:=public.fn_ca_tournament_seat_cap(p_tournament_id);

  -- Lock the beneficiary and every roster row claiming the requested
  -- coordinate before any table/seat row. This matches terminal settlement's
  -- tournament -> roster -> tables -> seats child order.
  PERFORM tp.id
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND (tp.user_id=p_user_id
       OR (tp.table_id=p_table_id AND tp.seat_number=p_seat_number))
   ORDER BY tp.id
   FOR UPDATE;

  SELECT * INTO v_tp FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_registered');
  END IF;
  IF v_tp.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','player_not_assignable','status',v_tp.status::text);
  END IF;

  IF v_tp.status::text='registered' THEN
    v_stack:=COALESCE(v_t.starting_chips,0)
             +GREATEST(COALESCE(v_tp.chips,0),0);
  ELSE
    /* THE FELT IS THE BANK ON A MOVE (2026-09-10). This took the new
       seat's stack from tournament_players.chips, a MIRROR, rather than
       from the seat the player is leaving. In the ordinary case the two
       agree - measured 1,540 of 1,541 live tournament seats. When they
       do not, this statement silently minted or destroyed the gap.
       Night Owl Special b84f312f: the engine's own hands show 256,000 +
       128,000 = 384,000 at 18:01, exactly the 48 x 8,000 bought in; a
       move at 22:34:25 wrote 448,000 over a felt of 256,000 and the
       tournament has held 64,000 chips nobody bought ever since.
       The seat is where the engine settles every hand, so the seat is
       the witness; the mirror is a projection. Read the felt first and
       fall back to the mirror only when the player holds no live seat. */
    SELECT ts.stack INTO v_felt_stack
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id=ts.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND ts.user_id=p_user_id
       AND ts.left_at IS NULL
     ORDER BY ts.joined_at DESC, ts.id
     LIMIT 1;
    v_stack:=COALESCE(v_felt_stack,COALESCE(v_tp.chips,0));
  END IF;

  /* A SEAT ASSIGNMENT NEVER MINTS TOURNAMENT CHIPS (2026-09-10).
     Whatever corrupts an input, this gate makes the class impossible:
     an assignment may move chips between chairs but may never RAISE the
     tournament's live total above what was bought in. A normal move
     cannot trip it - the player's own live seat is subtracted before
     v_stack is added back, so the total is unchanged. It fires only when
     seating a player would ADD chips beyond the cap. An existing overage
     is tolerated (history) and refused only from growing (the future),
     the same shape as this estate's NOT VALID constraints. */
  IF v_tp.status::text<>'registered' THEN
    SELECT COALESCE(sum(ts.stack),0) INTO v_live_total
      FROM public.table_seats ts JOIN public.tables tb ON tb.id=ts.table_id
     WHERE tb.tournament_id=p_tournament_id AND ts.left_at IS NULL;
    SELECT COALESCE(sum(ts.stack),0) INTO v_own_live
      FROM public.table_seats ts JOIN public.tables tb ON tb.id=ts.table_id
     WHERE tb.tournament_id=p_tournament_id AND ts.user_id=p_user_id
       AND ts.left_at IS NULL;
    SELECT (count(*)*COALESCE(v_t.starting_chips,0))
           +(COALESCE(sum(tp2.rebuys),0)*COALESCE(v_t.rebuy_chips,0))
           +(count(*) FILTER (WHERE tp2.add_on)*COALESCE(v_t.addon_chips,0))
      INTO v_cap_chips
      FROM public.tournament_players tp2
     WHERE tp2.tournament_id=p_tournament_id;
    IF (v_live_total-v_own_live+v_stack)>v_live_total
       AND (v_live_total-v_own_live+v_stack)>v_cap_chips THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','tournament_chip_conservation',
        'live_total',v_live_total,'own_live',v_own_live,
        'proposed_stack',v_stack,'bought_in_cap',v_cap_chips);
    END IF;
  END IF;
  IF v_stack::text IN ('NaN','Infinity','-Infinity')
     OR v_stack<=0 OR v_stack<>trunc(v_stack)
     OR v_stack>2147483647 THEN
    RETURN jsonb_build_object('ok',false,'reason','player_stack_invalid');
  END IF;

  SELECT * INTO v_table FROM public.tables tb
   WHERE tb.id=p_table_id
   FOR UPDATE;
  IF NOT FOUND OR v_table.tournament_id IS DISTINCT FROM p_tournament_id THEN
    RETURN jsonb_build_object('ok',false,'reason','table_tournament_mismatch');
  END IF;
  IF lower(COALESCE(v_table.status::text,'')) NOT IN
       ('waiting','running','active')
     OR COALESCE(v_table.is_deleted,false)
     OR p_seat_number>LEAST(
          v_cap,GREATEST(2,COALESCE(NULLIF(v_table.max_players,0),v_cap))) THEN
    RETURN jsonb_build_object('ok',false,'reason','table_not_assignable');
  END IF;

  -- A physical row is reusable, but none of its former occupant's identity or
  -- per-session state is. Resolve every derived value while the tournament,
  -- roster and table rows are locked, then write the same complete shape for a
  -- new row and a revived row. Passing the old club_id through the seat stamp
  -- trigger would make it the preferred club and could attribute this entry to
  -- the departed occupant.
  v_expected_club_id:=public.fn_seat_club_for_user(
    p_user_id,p_table_id,v_tp.club_id);
  SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
    INTO v_expected_horse_id
    FROM public.profiles p
   WHERE p.id=p_user_id;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL
   ORDER BY s.id
   FOR UPDATE OF s;
  SELECT count(*)::integer INTO v_live_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.user_id=p_user_id AND s.left_at IS NULL;
  IF v_live_count>1 THEN
    RAISE EXCEPTION 'tournament player already owns multiple live seats'
      USING ERRCODE='P0404';
  END IF;
  IF v_live_count=1 THEN
    SELECT s.* INTO v_live
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
     FOR UPDATE OF s;
    IF v_live.table_id IS DISTINCT FROM p_table_id
       OR v_live.seat_number IS DISTINCT FROM p_seat_number THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','player_already_seated_elsewhere',
        'table_id',v_live.table_id,'seat_number',v_live.seat_number);
    END IF;
    SELECT count(*)::integer INTO v_current_players
      FROM public.table_seats s
     WHERE s.table_id=p_table_id AND s.left_at IS NULL;
    IF v_live.stack IS DISTINCT FROM v_stack
       OR v_tp.status::text<>'playing'
       OR v_tp.chips IS DISTINCT FROM v_stack::integer
       OR v_tp.table_id IS DISTINCT FROM p_table_id
       OR v_tp.seat_number IS DISTINCT FROM p_seat_number
       OR v_table.current_players IS DISTINCT FROM v_current_players
       OR v_live.joined_at IS NULL THEN
      RAISE EXCEPTION 'existing tournament assignment is not an exact receipt'
        USING ERRCODE='P0404';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'replayed',true,'tournament_id',p_tournament_id,
      'user_id',p_user_id,'table_id',p_table_id,
      'seat_id',v_live.id,'seat_number',p_seat_number,'stack',v_stack,
      'current_players',v_current_players,'assigned_at',v_live.joined_at);
  END IF;

  SELECT * INTO v_destination FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.seat_number=p_seat_number
   FOR UPDATE;
  IF FOUND AND v_destination.left_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_taken');
  END IF;

  -- A departed occupant can still carry a stale roster coordinate. Correct
  -- that link inside this assignment transaction; never overwrite a live
  -- seat or leave two active roster rows claiming one chair.
  UPDATE public.tournament_players tp
     SET table_id=NULL,seat_number=NULL
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id<>p_user_id
     AND tp.table_id=p_table_id AND tp.seat_number=p_seat_number;

  v_assigned_at:=clock_timestamp();
  PERFORM set_config(
    'app.money_path','fn_assign_tournament_player_seat_atomic',true);
  BEGIN
    IF v_destination.id IS NULL THEN
      INSERT INTO public.table_seats(
        table_id,user_id,player_id,member_id,seat_number,stack,status,
        joined_at,left_at,is_sitting_out,is_away,leave_pending,
        scheduled_leave_hands,horse_id,auto_rebuy,time_bank_remaining,
        time_bank_uses_remaining,club_id,sit_out_at,entry_hold,
        entry_post_agreed)
      VALUES(
        p_table_id,p_user_id,NULL,NULL,p_seat_number,v_stack,'active',
        v_assigned_at,NULL,false,false,false,NULL,v_expected_horse_id,false,
        v_time_bank_seconds,v_time_bank_uses,v_expected_club_id,NULL,NULL,
        false)
      RETURNING id INTO v_seat_id;
    ELSE
      UPDATE public.table_seats s
         SET user_id=p_user_id,player_id=NULL,member_id=NULL,stack=v_stack,
             status='active',joined_at=v_assigned_at,left_at=NULL,
             is_sitting_out=false,is_away=false,leave_pending=false,
             sit_out_at=NULL,scheduled_leave_hands=NULL,
             horse_id=v_expected_horse_id,entry_hold=NULL,
             entry_post_agreed=false,auto_rebuy=false,
             time_bank_remaining=v_time_bank_seconds,
             time_bank_uses_remaining=v_time_bank_uses,
             club_id=v_expected_club_id
       WHERE s.id=v_destination.id AND s.left_at IS NOT NULL
       RETURNING id INTO v_seat_id;
      IF v_seat_id IS NULL THEN
        RAISE EXCEPTION 'vacated tournament seat changed during assignment'
          USING ERRCODE='40001';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config(
      'app.money_path',COALESCE(v_previous_money_path,''),true);
    RAISE;
  END;
  PERFORM set_config(
    'app.money_path',COALESCE(v_previous_money_path,''),true);

  UPDATE public.tournament_players tp
     SET status='playing',chips=v_stack::integer,
         table_id=p_table_id,seat_number=p_seat_number
   WHERE tp.id=v_tp.id AND tp.status::text IN ('registered','playing');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament roster changed during seat assignment'
      USING ERRCODE='40001';
  END IF;

  SELECT count(*)::integer INTO v_current_players
    FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.left_at IS NULL;
  UPDATE public.tables tb
     SET current_players=v_current_players,updated_at=now()
   WHERE tb.id=p_table_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament table vanished during seat assignment'
      USING ERRCODE='40001';
  END IF;

  IF (SELECT count(*) FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL)<>1
     OR NOT EXISTS(
       SELECT 1 FROM public.table_seats s
        WHERE s.id=v_seat_id AND s.table_id=p_table_id
          AND s.user_id=p_user_id AND s.seat_number=p_seat_number
          AND s.left_at IS NULL AND s.stack=v_stack
          AND s.player_id IS NULL AND s.member_id IS NULL
          AND s.horse_id IS NOT DISTINCT FROM v_expected_horse_id
          AND s.club_id IS NOT DISTINCT FROM v_expected_club_id
          AND s.time_bank_remaining=v_time_bank_seconds
          AND s.time_bank_uses_remaining=v_time_bank_uses
          AND NOT COALESCE(s.is_sitting_out,false)
          AND NOT COALESCE(s.is_away,false)
          AND NOT COALESCE(s.leave_pending,false)
          AND NOT COALESCE(s.auto_rebuy,false)
          AND s.sit_out_at IS NULL
          AND s.scheduled_leave_hands IS NULL
          AND s.entry_hold IS NULL
          AND NOT s.entry_post_agreed)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.id=v_tp.id AND tp.status::text='playing'
          AND tp.chips=v_stack::integer AND tp.table_id=p_table_id
          AND tp.seat_number=p_seat_number)
     OR NOT EXISTS(
       SELECT 1 FROM public.tables tb
        WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id
          AND tb.current_players=v_current_players) THEN
    RAISE EXCEPTION 'atomic tournament seat assignment final proof is not exact'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'tournament_id',p_tournament_id,
    'user_id',p_user_id,'table_id',p_table_id,'seat_id',v_seat_id,
    'seat_number',p_seat_number,'stack',v_stack,
    'current_players',v_current_players,'assigned_at',v_assigned_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_choose_tournament_seat_locked(p_tournament_id uuid, p_user_id uuid, p_preferred_table_id uuid DEFAULT NULL::uuid, p_preferred_seat_number integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_capacity jsonb;
  v_table_id uuid;
  v_tournament_cap integer;
  v_cap integer;
  v_seat_number integer;
  v_seat_id uuid;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player are required for seat selection'
      USING ERRCODE='22023';
  END IF;

  v_capacity:=public.fn_ensure_late_registration_capacity(
    p_tournament_id,0);
  IF COALESCE((v_capacity->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament capacity could not be established: %',
      COALESCE(v_capacity->>'reason','unknown') USING ERRCODE='55000';
  END IF;
  v_tournament_cap:=public.fn_ca_tournament_seat_cap(p_tournament_id);

  SELECT tb.id,
         LEAST(v_tournament_cap,
               GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_tournament_cap)))
    INTO v_table_id,v_cap
    FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id
     AND lower(COALESCE(tb.status,'')) IN ('running','waiting','active')
     AND NOT COALESCE(tb.is_deleted,false)
     AND EXISTS (
       SELECT 1
         FROM generate_series(
           1,LEAST(v_tournament_cap,
             GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_tournament_cap))))
           AS legal(seat_number)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.table_seats occupied
           WHERE occupied.table_id=tb.id
             AND occupied.seat_number=legal.seat_number
             AND occupied.left_at IS NULL))
   ORDER BY (
       SELECT count(*)
         FROM generate_series(
           1,LEAST(v_tournament_cap,
             GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_tournament_cap))))
           AS legal(seat_number)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.table_seats occupied
           WHERE occupied.table_id=tb.id
             AND occupied.seat_number=legal.seat_number
             AND occupied.left_at IS NULL)) DESC,
     (tb.id=p_preferred_table_id) DESC,
     tb.created_at,tb.id
   LIMIT 1
   FOR UPDATE OF tb;
  IF v_table_id IS NULL THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_CAPACITY_UNAVAILABLE: no legal chair exists for tournament %',
      p_tournament_id USING ERRCODE='55000';
  END IF;

  IF v_table_id=p_preferred_table_id
     AND p_preferred_seat_number BETWEEN 1 AND v_cap
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats occupied
        WHERE occupied.table_id=v_table_id
          AND occupied.seat_number=p_preferred_seat_number
          AND occupied.left_at IS NULL) THEN
    v_seat_number:=p_preferred_seat_number;
  ELSE
    SELECT legal.seat_number INTO v_seat_number
      FROM generate_series(1,v_cap) AS legal(seat_number)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.table_seats occupied
        WHERE occupied.table_id=v_table_id
          AND occupied.seat_number=legal.seat_number
          AND occupied.left_at IS NULL)
     ORDER BY legal.seat_number
     LIMIT 1;
  END IF;
  IF v_seat_number IS NULL THEN
    RAISE EXCEPTION 'chosen tournament table lost its legal chair'
      USING ERRCODE='40001';
  END IF;

  SELECT s.id INTO v_seat_id
    FROM public.table_seats s
   WHERE s.table_id=v_table_id AND s.seat_number=v_seat_number
   FOR UPDATE;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',p_tournament_id,'user_id',p_user_id,
    'table_id',v_table_id,'seat_number',v_seat_number,
    'physical_seat_id',v_seat_id,'capacity',v_capacity);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_latest_committed_knockout_candidate(p_tournament_id uuid, p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table_id uuid;
  v_hand_number bigint;
  v_candidate_id uuid;
  v_candidate_hand_id uuid;
  v_settlement_hand_id uuid;
  v_settlement_hand_text text;
  v_atomic_stack text;
  v_settlement_stack text;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player are required for knockout evidence'
      USING ERRCODE='22023';
  END IF;

  SELECT c.id,c.table_id,c.hand_number,c.hand_id
    INTO v_candidate_id,v_table_id,v_hand_number,v_candidate_hand_id
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.stack_after=0
   ORDER BY c.hand_number DESC,c.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'REBUY_KNOCKOUT_CANDIDATE_REQUIRED: no zero-stack generation names this player'
      USING ERRCODE='55000';
  END IF;

  SELECT a.stack_result->>'hand_id',
         a.stack_result->'written'->>p_user_id::text
    INTO v_settlement_hand_text,v_atomic_stack
    FROM public.hand_atomic_commits a
   WHERE a.table_id=v_table_id
     AND a.hand_number=v_hand_number
     AND a.hand_id=v_candidate_hand_id;
  -- fn_ca_settle_hand_stacks_absolute derives this id from md5(... )::uuid.
  -- PostgreSQL UUIDs are canonical hexadecimal but that deterministic hash is
  -- not required to carry RFC version/variant nibbles.
  IF NOT FOUND
     OR COALESCE(v_settlement_hand_text,'')
          !~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v_atomic_stack,'')!~'^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION
      'REBUY_ATOMIC_HAND_REQUIRED: candidate is not the exact accepted zero hand'
      USING ERRCODE='P0404';
  END IF;
  IF v_atomic_stack::numeric<>0 THEN
    RAISE EXCEPTION
      'REBUY_ATOMIC_HAND_REQUIRED: candidate hand did not commit a zero stack'
      USING ERRCODE='P0404';
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT k.result->'written'->>p_user_id::text
    INTO v_settlement_stack
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=v_table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.result->>'table_id'=v_table_id::text
     AND COALESCE(k.result->>'hand_number','')~'^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=v_hand_number;
  IF NOT FOUND
     OR COALESCE(v_settlement_stack,'')!~'^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION
      'REBUY_SETTLEMENT_RECEIPT_REQUIRED: atomic zero hand has no exact successful settlement'
      USING ERRCODE='P0404';
  END IF;
  IF v_settlement_stack::numeric<>0 THEN
    RAISE EXCEPTION
      'REBUY_SETTLEMENT_RECEIPT_REQUIRED: exact settlement did not commit a zero stack'
      USING ERRCODE='P0404';
  END IF;

  RETURN v_candidate_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_rebuy_window(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
  v_level_cap integer;
  v_timed_deadline timestamptz;
  v_level_open boolean:=false;
  v_timed_open boolean:=false;
  v_addon_open boolean:=false;
  v_prompt_until timestamptz;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'tournament is required for rebuy-window policy'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;

  IF upper(COALESCE(v_t.status::text,''))<>'RUNNING'
     OR COALESCE(v_t.prize_pool_finalized,false)
     OR NOT (COALESCE(v_t.is_rebuy,false) OR COALESCE(v_t.is_reentry,false)) THEN
    RETURN jsonb_build_object(
      'open',false,'prompt_until',NULL,'reason','tournament_not_rebuyable');
  END IF;

  v_addon_open:=COALESCE(v_t.add_on_available,false)
    AND COALESCE(v_t.addon_period_triggered,false)
    AND v_t.addon_period_started_at IS NOT NULL
    AND v_t.addon_period_ends_at IS NOT NULL
    AND v_now>=v_t.addon_period_started_at
    AND v_now<v_t.addon_period_ends_at;
  v_level_cap:=COALESCE(
    NULLIF(v_t.rebuy_levels,0),NULLIF(v_t.late_reg_levels,0),0);
  v_level_open:=v_level_cap>0
    AND v_t.current_level IS NOT NULL
    AND v_t.current_level<v_level_cap;
  IF v_level_cap<=0 AND COALESCE(v_t.late_reg_mins,0)>0
     AND v_t.started_at IS NOT NULL THEN
    v_timed_deadline:=v_t.started_at+
      make_interval(mins=>v_t.late_reg_mins);
    v_timed_open:=v_now<v_timed_deadline;
  END IF;

  IF NOT (v_level_open OR v_timed_open OR v_addon_open) THEN
    RETURN jsonb_build_object(
      'open',false,'prompt_until',NULL,'reason','rebuy_window_closed',
      'level_cap',v_level_cap,'addon_open',v_addon_open);
  END IF;
  v_prompt_until:=LEAST(
    v_now+interval '30 seconds',
    GREATEST(
      CASE WHEN v_level_open THEN v_now+interval '30 seconds' END,
      CASE WHEN v_timed_open THEN v_timed_deadline END,
      CASE WHEN v_addon_open THEN v_t.addon_period_ends_at END));
  RETURN jsonb_build_object(
    'open',true,'prompt_until',v_prompt_until,'reason','open',
    'level_cap',v_level_cap,'level_open',v_level_open,
    'timed_open',v_timed_open,'addon_open',v_addon_open);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  IF p_reason NOT IN (
    'rebuy','reentry','addon','late_registration','deal_vote','bounty_settled'
  ) THEN
    RAISE EXCEPTION 'invalid tournament manager wake reason';
  END IF;

  -- Serialize every emitter with the tournament lifecycle transition. UPDATE
  -- takes a NO KEY UPDATE lock, which conflicts with FOR SHARE: an emitter that
  -- commits first is consumed by the terminal AFTER trigger, while an emitter
  -- that arrives second observes the terminal state and cannot strand work for
  -- a manager that has already stopped. Terminal recovery can still settle a
  -- legacy financial obligation; it simply has no live manager to wake.
  SELECT upper(COALESCE(t.status,''))
    INTO v_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.tournament_manager_wakes AS pending(tournament_id,reason,generation)
  VALUES (p_tournament_id,p_reason,1)
  ON CONFLICT (tournament_id,reason) WHERE consumed_at IS NULL
  DO UPDATE SET
    generation=pending.generation+1,
    created_at=clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid; v_table_club uuid;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_table_club
    FROM public.tables t WHERE t.id = p_table_id;
  IF v_union IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.user_id = p_user_id AND cm.club_id = v_table_club
         AND cm.status IN ('active','approved')
    ) THEN RETURN v_table_club; END IF;
    RETURN public.fn_player_home_club(p_user_id, p_preferred_club);
  END IF;
  RETURN public.fn_seat_club_for_user_membership_unchecked(
    p_user_id, p_table_id, p_preferred_club
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_seat_cap(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_variant text;
  v_format text;
  v_cap integer;
BEGIN
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  v_variant:=lower(COALESCE(NULLIF(v_t.game_type,''),'nlh'));
  v_format:=lower(COALESCE(v_t.variant,''));
  v_cap:=CASE
    WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'
      THEN 3
    WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'
      THEN LEAST(COALESCE(NULLIF(v_t.max_players,0),6),9)
    ELSE LEAST(COALESCE(NULLIF(v_t.table_size,0),9),10)
  END;
  v_cap:=LEAST(v_cap,CASE v_variant
    WHEN 'plo5' THEN 9
    WHEN 'plo6' THEN 7
    ELSE 10
  END);
  RETURN GREATEST(v_cap,2);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ensure_late_registration_capacity(p_tournament_id uuid, p_reserved_entries integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_table_id uuid;
  v_table_number integer;
  v_level jsonb;
  v_variant text;
  v_format text;
  v_cap integer;
  v_sb numeric;
  v_bb numeric;
  v_ante numeric;
  v_active_entries bigint;
  v_live_capacity bigint;
  v_occupied_seats bigint;
  v_open_seats bigint;
  v_unseated_entries bigint;
  v_required_open_seats bigint;
  v_pending_table_ids jsonb := '[]'::jsonb;
  v_pending_table_count bigint := 0;
  v_wake_id bigint;
BEGIN
  IF p_reserved_entries NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'Capacity reservation must be zero or one'
      USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object(
      'ok',true,'created',false,'reason','tournament_not_running');
  END IF;
  -- Only a new reservation needs an open entry window. An already accepted
  -- `registered`/`playing` entrant remains owed a seat after the clock or
  -- field cap closes; p_reserved_entries=0 lets the manager satisfy that
  -- durable demand without reopening registration.
  IF p_reserved_entries>0
     AND NOT public.fn_tournament_late_registration_open(p_tournament_id) THEN
    RETURN jsonb_build_object(
      'ok',true,'created',false,'reason','entry_window_closed');
  END IF;

  v_variant := lower(COALESCE(NULLIF(v_t.game_type,''),'nlh'));
  v_format := lower(COALESCE(v_t.variant,''));
  v_cap := CASE
    WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'
      -- createTablesAndSeatPlayers and the Spin contract both own a
      -- three-handed table. `tournaments.max_players` is the field cap, not a
      -- second per-table Spin setting, so letting a stale value of 1 or 2
      -- shrink only an expansion table would split one event across two
      -- incompatible table contracts.
      THEN 3
    WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'
      THEN LEAST(COALESCE(NULLIF(v_t.max_players,0),6),9)
    ELSE LEAST(COALESCE(NULLIF(v_t.table_size,0),9),10)
  END;
  -- Tournament tables need one board only. This mirrors VariantRules.maxSeatsFor:
  -- floor((deck - 5 board cards) / hole cards), then the product's 10-seat cap.
  v_cap := LEAST(v_cap,CASE v_variant
    WHEN 'plo5' THEN 9
    WHEN 'plo6' THEN 7
    ELSE 10
  END);
  v_cap := GREATEST(v_cap,2);

  -- This is the re-check that closes the race. `registered` is included
  -- because a paid entrant is real demand before the manager promotes them to
  -- `playing`; registration itself contributes one reservation because its
  -- failed first attempt was rolled back before it reached this function.
  SELECT count(*) INTO v_active_entries
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status IN ('registered','playing');

  -- Sum the legal chairs AND the rows currently occupying those chairs. A
  -- nominal nine-seat table is not nine seats of usable capacity when a stale
  -- eliminated/closed-generation row still physically owns one of them. The
  -- old table-count multiplication could therefore strand a paid entrant
  -- forever while insisting capacity was sufficient.
  WITH live_tables AS (
    SELECT tb.id,
           LEAST(v_cap,GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_cap)))
             AS capacity
      FROM public.tables tb
     WHERE tb.tournament_id=p_tournament_id
       AND tb.status IN ('running','waiting','active')
       AND COALESCE(tb.is_deleted,false)=false
  ), occupancy AS (
    SELECT lt.id,lt.capacity,
           count(s.id) FILTER (
             WHERE s.seat_number BETWEEN 1 AND lt.capacity
           ) AS occupied
      FROM live_tables lt
      LEFT JOIN public.table_seats s
        ON s.table_id=lt.id AND s.left_at IS NULL
     GROUP BY lt.id,lt.capacity
  )
  SELECT COALESCE(sum(o.capacity),0),COALESCE(sum(o.occupied),0)
    INTO v_live_capacity,v_occupied_seats
    FROM occupancy o;
  v_open_seats := GREATEST(v_live_capacity-v_occupied_seats,0);

  -- Demand means an accepted active entry that does not already own a usable
  -- live chair. Count by entrant, not by seat row, so a duplicate-seat defect
  -- cannot make the field look larger and trigger another duplicate table.
  SELECT count(*) INTO v_unseated_entries
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status IN ('registered','playing')
     AND NOT EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND tb.status IN ('running','waiting','active')
          AND COALESCE(tb.is_deleted,false)=false
          AND s.user_id=tp.user_id
          AND s.left_at IS NULL
          AND s.seat_number BETWEEN 1 AND
              LEAST(v_cap,GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_cap)))
     );
  v_required_open_seats := v_unseated_entries+p_reserved_entries;

  IF v_required_open_seats<=v_open_seats THEN
    -- If an older manager consumed the wake but crashed before admitting the
    -- table, recreate the level-triggered signal. Never increment a wake that
    -- is still pending: its exact generation already represents this work.
    IF EXISTS (
      SELECT 1 FROM public.tournament_capacity_table_receipts r
       WHERE r.tournament_id=p_tournament_id AND r.manager_admitted_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM public.tournament_manager_wakes w
       WHERE w.tournament_id=p_tournament_id
         AND w.reason='late_registration' AND w.consumed_at IS NULL
    ) THEN
      v_wake_id := public.fn_emit_tournament_manager_wake(
        p_tournament_id,'late_registration');
      UPDATE public.tournament_capacity_table_receipts
         SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
       WHERE tournament_id=p_tournament_id AND manager_admitted_at IS NULL;
    END IF;
    SELECT COALESCE(jsonb_agg(p.table_id ORDER BY p.created_at,p.table_id),'[]'::jsonb),
           COALESCE(max(p.pending_count),0)
      INTO v_pending_table_ids,v_pending_table_count
      FROM (
        SELECT r.table_id,r.created_at,count(*) OVER () AS pending_count
          FROM public.tournament_capacity_table_receipts r
         WHERE r.tournament_id=p_tournament_id AND r.manager_admitted_at IS NULL
         ORDER BY r.created_at,r.table_id
         LIMIT 20
      ) p;
    RETURN jsonb_build_object(
      'ok',true,
      'created',false,
      'reason','capacity_sufficient',
      'active_entries',v_active_entries,
      'unseated_entries',v_unseated_entries,
      'reserved_entries',p_reserved_entries,
      'live_capacity',v_live_capacity,
      'occupied_seats',v_occupied_seats,
      'open_seats',v_open_seats,
      'pending_table_ids',v_pending_table_ids,
      'pending_table_count',v_pending_table_count,
      'remaining_deficit',0
    );
  END IF;

  v_level := public.fn_tournament_current_blinds(p_tournament_id);
  v_sb := (v_level->>'small_blind')::numeric;
  v_bb := (v_level->>'big_blind')::numeric;
  v_ante := (v_level->>'ante')::numeric;
  IF v_sb IS NULL OR v_bb IS NULL OR v_sb<0 OR v_bb<=0 OR v_ante<0 OR v_sb>=v_bb THEN
    RAISE EXCEPTION 'Tournament current blind level is invalid' USING ERRCODE='55000';
  END IF;

  SELECT count(*)+1 INTO v_table_number
    FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  INSERT INTO public.tables(
    club_id,tournament_id,name,game_type,game_variant,stakes,
    small_blind,big_blind,ante,min_buy_in,max_buy_in,max_players,
    current_players,status,action_time_seconds,
    big_blind_ante_enabled,all_in_or_fold,allow_rabbit_hunt
  ) VALUES (
    v_t.club_id,p_tournament_id,
    COALESCE(v_t.name,'Tournament')||' - Table '||v_table_number,
    'tournament',v_variant,v_sb::text||'/'||v_bb::text,
    v_sb,v_bb,v_ante,0,0,v_cap,0,'running',
    LEAST(120,GREATEST(10,COALESCE(v_t.action_time_seconds,15))),
    COALESCE(v_t.big_blind_ante,false),COALESCE(v_t.all_in_or_fold,false),
    COALESCE(v_t.allow_rabbit_hunt,true)
  ) RETURNING id INTO v_table_id;
  -- The manager wake is emitted before the receipt, but both are inside this
  -- transaction. Any failure below rolls the table and wake back together.
  v_wake_id := public.fn_emit_tournament_manager_wake(
    p_tournament_id,'late_registration');
  INSERT INTO public.tournament_capacity_table_receipts(
    table_id,tournament_id,manager_wake_id
  ) VALUES (v_table_id,p_tournament_id,v_wake_id);
  -- All still-unadmitted tables are now represented by the newest generation
  -- of the one level-triggered wake for this tournament/reason.
  UPDATE public.tournament_capacity_table_receipts
     SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
   WHERE tournament_id=p_tournament_id AND manager_admitted_at IS NULL;
  SELECT COALESCE(jsonb_agg(
           p.table_id ORDER BY p.current_created DESC,p.created_at,p.table_id
         ),'[]'::jsonb),
         COALESCE(max(p.pending_count),0)
    INTO v_pending_table_ids,v_pending_table_count
    FROM (
      SELECT r.table_id,r.created_at,r.table_id=v_table_id AS current_created,
             count(*) OVER () AS pending_count
        FROM public.tournament_capacity_table_receipts r
       WHERE r.tournament_id=p_tournament_id AND r.manager_admitted_at IS NULL
       ORDER BY (r.table_id=v_table_id) DESC,r.created_at,r.table_id
       LIMIT 20
    ) p;
  RETURN jsonb_build_object(
    'ok',true,
    'created',true,
    'table_id',v_table_id,
    'table_number',v_table_number,
    'table_capacity',v_cap,
    'active_entries',v_active_entries,
    'unseated_entries',v_unseated_entries,
    'reserved_entries',p_reserved_entries,
    'live_capacity_before',v_live_capacity,
    'live_capacity_after',v_live_capacity+v_cap,
    'occupied_seats',v_occupied_seats,
    'open_seats_before',v_open_seats,
    'open_seats_after',v_open_seats+v_cap,
    'pending_table_ids',v_pending_table_ids,
    'pending_table_count',v_pending_table_count,
    'remaining_deficit',GREATEST(v_required_open_seats-(v_open_seats+v_cap),0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF lower(COALESCE(v_variant,'')) = 'spin'
       OR COALESCE(v_max_players,0) <= 2 THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.stack IS DISTINCT FROM v_starting_chips THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_one_live_tournament_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_other_table   uuid;
  v_other_seat    integer;
BEGIN
  IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
  FROM public.tables t
  WHERE t.id = NEW.table_id;

  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ts.table_id, ts.seat_number
    INTO v_other_table, v_other_seat
  FROM public.table_seats ts
  JOIN public.tables t2 ON t2.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND ts.user_id = NEW.user_id
    AND t2.tournament_id = v_tournament_id
    AND ts.id IS DISTINCT FROM NEW.id
  LIMIT 1;

  IF v_other_table IS NOT NULL THEN
    RAISE EXCEPTION
      'player % already holds a live seat in tournament % (table %, seat %) - one live seat per tournament',
      NEW.user_id, v_tournament_id, v_other_table, v_other_seat
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.is_sitting_out := false;
  NEW.sit_out_at := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_reentry_with_pending_bounty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status='eliminated' AND NEW.status='playing'
     AND EXISTS (SELECT 1 FROM public.tournament_bounty_obligations o
                  WHERE o.tournament_id=NEW.tournament_id
                    AND o.eliminated_user_id=NEW.user_id AND o.state='pending') THEN
    RAISE EXCEPTION 'prior bounty obligation is still pending for tournament %, player %',
      NEW.tournament_id, NEW.user_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_require_live_seat_parent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE parent_key text;
BEGIN
 IF NEW.left_at IS NOT NULL THEN
  NEW.active_parent_key := NULL;
  RETURN NEW;
 END IF;
 SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active seat requires an existing parent table' USING ERRCODE='23514'; END IF;
 IF parent_key IS NULL THEN
  -- Only a pre-migration empty parent needs this initialization. Ordinary
  -- admissions do not update/lock the parent ahead of the native FK check.
  UPDATE public.tables t SET seat_admission_key = CASE
    WHEN lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished')
      OR t.lifecycle='closed' OR coalesce(t.is_deleted,false) OR coalesce(t.is_template,false) THEN 'closed'
    WHEN t.tournament_id IS NOT NULL THEN 'tournament:'||t.tournament_id::text
    ELSE 'cash' END
  WHERE t.id=NEW.table_id AND t.seat_admission_key IS NULL;
  SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 END IF;
 IF parent_key IS NULL OR parent_key='closed' THEN
  RAISE EXCEPTION 'CLOSED_TABLE_REJECTS_ACTIVE_SEAT' USING ERRCODE='23514';
 END IF;

 IF TG_OP='INSERT' OR OLD.left_at IS NOT NULL
   OR OLD.table_id IS DISTINCT FROM NEW.table_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
  IF (current_setting('app.money_path',true) IN ('atomic_table_buyin','fn_horse_seat_from_treasury')
      OR current_setting('app.cash_seat_move',true)='on') AND parent_key<>'cash' THEN
   RAISE EXCEPTION 'CASH_PURCHASE_ONLY: cash admission cannot create tournament chips' USING ERRCODE='55000';
  END IF;
 END IF;
 NEW.active_parent_key := parent_key;
 RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_change_syncs_seat_first_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_table_id uuid;
  v_tid uuid;
BEGIN
  v_table_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  IF v_table_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT tournament_id INTO v_tid
    FROM public.tables
   WHERE id = v_table_id;
  IF v_tid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.id = v_tid
       AND (lower(COALESCE(t.variant,'')) = 'spin'
            OR COALESCE(t.max_players,0) <= 2)
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_tid);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_active_seat_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    NEW.active_game_scope := NULL;
  ELSE
    SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
    IF NOT FOUND OR NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'Active seat requires an existing table and player' USING ERRCODE='23514';
    END IF;
    IF NEW.active_game_scope IS NULL THEN
      -- A pre-migration empty table has no cached scope. Initialize only that
      -- parent, inside this admission transaction. Existing occupied tables
      -- never take this UPDATE path. Concurrent initialization is idempotent.
      UPDATE public.tables t SET seat_game_scope = CASE WHEN t.cluster_id IS NULL
        THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END
      WHERE t.id=NEW.table_id AND t.seat_game_scope IS NULL;
      SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
      IF NEW.active_game_scope IS NULL THEN
        RAISE EXCEPTION 'Active seat parent scope initialization failed' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
    NEW.club_id := COALESCE(
      public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NEW.club_id),
      NEW.club_id
    );
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_horse_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.horse_id := NULL;
    RETURN NEW;
  END IF;

  SELECT CASE WHEN COALESCE(p.is_horse, false) THEN p.id ELSE NULL END
    INTO NEW.horse_id
    FROM public.profiles p
   WHERE p.id = NEW.user_id;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_sit_out_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.sit_out_at := CASE WHEN COALESCE(NEW.is_sitting_out, false)
                           THEN COALESCE(NEW.sit_out_at, now())
                           ELSE NULL END;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_sitting_out, false) AND NOT COALESCE(OLD.is_sitting_out, false) THEN
    -- Entering sit-out: start the clock.
    NEW.sit_out_at := now();
  ELSIF NOT COALESCE(NEW.is_sitting_out, false) THEN
    -- Not sitting out, by any route (sat back in, seat turned over, evicted).
    NEW.sit_out_at := NULL;
  ELSIF public.fn_freeze_bypass_active()
        AND NEW.sit_out_at IS NOT NULL
        AND NEW.sit_out_at IS DISTINCT FROM OLD.sit_out_at THEN
    -- Still sitting out, and the writer is the THAW (the only transaction
    -- that runs under app.freeze_bypass). It is giving this clock back the
    -- minutes the freeze took; honour the value it supplied.
    NULL;
  ELSE
    -- Still sitting out. HOLD THE ORIGINAL STAMP. An unrelated UPDATE to the
    -- row (a stack change, a time-bank decrement, a status write) must NOT
    -- restart the five minutes.
    NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_elimination_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'eliminated' THEN
      NEW.elimination_sequence := nextval(
        'public.tournament_player_elimination_sequence'::regclass);
    ELSE
      NEW.elimination_sequence := NULL;
    END IF;
  ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'
        AND NEW.status::text = 'eliminated' THEN
    NEW.elimination_sequence := nextval(
      'public.tournament_player_elimination_sequence'::regclass);
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text IS DISTINCT FROM 'eliminated' THEN
    NEW.elimination_sequence := NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
    RAISE EXCEPTION 'elimination_sequence is database-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_tournament_status text;
  v_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_global boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL
       OR (OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
         AND OLD.seat_number IS NOT DISTINCT FROM NEW.seat_number) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,''))
    INTO v_tournament_id,v_tournament_status
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND l.classid=(((v_key>>32)&4294967295)::oid)
       AND l.objid=((v_key&4294967295)::oid)
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_global;
  IF NOT COALESCE(v_owns_global,false) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
      USING ERRCODE='55000',
            HINT='Use a canonical tournament seat purchase, registration, move, or assignment RPC.';
  END IF;
  IF v_tournament_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_CLOSED: tournament %, status %',
      v_tournament_id,v_tournament_status
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_assert_live_tournament_seat_has_roster()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_user_id uuid;
  v_parent_status text;
BEGIN
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'DELETE' OR NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT t.tournament_id INTO v_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSE
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;
    v_tournament_id := OLD.tournament_id;
    v_user_id := OLD.user_id;
  END IF;

  IF v_tournament_id IS NOT NULL THEN
    SELECT t.status::text INTO v_parent_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;

  /* Terminal cleanup may intentionally close the roster and seats in
     separate idempotent requests.  The invariant is strict while the event
     is joinable or playable; finished/cancelled tables are separately barred
     from acquiring new live seats and may drain without being wedged. */
  IF v_tournament_id IS NOT NULL
     AND upper(COALESCE(v_parent_status, '')) IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = v_tournament_id
          AND s.user_id = v_user_id
          AND s.left_at IS NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament_id
          AND p.user_id = v_user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament % at commit',
      v_user_id, v_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_entry_purchase_receipt_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.response IS NOT NULL OR OLD.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'ENTRY_PURCHASE_RECEIPT_IMMUTABLE: completed receipts cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.key_domain IS DISTINCT FROM NEW.key_domain
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request IS DISTINCT FROM NEW.request
     OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
     OR OLD.response IS NOT NULL
     OR NEW.response IS NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'ENTRY_PURCHASE_RECEIPT_IMMUTABLE: only the first completion is allowed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table_status text;
  v_is_deleted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.left_at IS NOT NULL
       OR NEW.user_id IS NULL
       OR (
         OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
       ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT lower(t.status::text), COALESCE(t.is_deleted, false)
    INTO v_table_status, v_is_deleted
    FROM public.tables t
   WHERE t.id = NEW.table_id
     AND t.tournament_id IS NOT NULL
   FOR SHARE;

  IF FOUND AND (v_table_status = 'closed' OR v_is_deleted) THEN
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_CLOSED: table % cannot acquire a live seat', NEW.table_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_scope text; v_key text; v_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
     AND OLD.active_game_scope IS NOT DISTINCT FROM NEW.active_game_scope
     AND OLD.active_parent_key IS NOT DISTINCT FROM NEW.active_parent_key THEN
    RETURN NEW; -- an FK re-checks only when a referencing column changes
  END IF;
  IF NEW.table_id IS NULL OR (NEW.active_game_scope IS NULL AND NEW.active_parent_key IS NULL) THEN
    RETURN NEW; -- MATCH SIMPLE
  END IF;
  SELECT t.seat_game_scope, t.seat_admission_key, true INTO v_scope, v_key, v_found
    FROM public.tables t WHERE t.id = NEW.table_id FOR KEY SHARE;
  IF NEW.active_game_scope IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_scope IS DISTINCT FROM NEW.active_game_scope) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "active_seat_game_scope_parent"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'active_seat_game_scope_parent',
            DETAIL = format('Key (table_id, active_game_scope)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_game_scope);
  END IF;
  IF NEW.active_parent_key IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_key IS DISTINCT FROM NEW.active_parent_key) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "live_seat_parent_cannot_close"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
            DETAIL = format('Key (table_id, active_parent_key)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_parent_key);
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table      uuid;
  v_seats      integer := 0;
  v_seat_first boolean := false;
  v_is_spin    boolean := false;
  v_cap        integer := 0;
  v_variant    text := '';
  v_book       jsonb;
BEGIN
  -- This is an AFTER-seat helper. It must never acquire a new global lock
  -- after PostgreSQL already owns the changed seat row. Every legitimate
  -- create/revive root pre-acquires terminal -> mission -> launch -> tournament,
  -- and the earliest BEFORE trigger refuses a raw writer that did not.
  SELECT (lower(COALESCE(t.variant, '')) = 'spin'
          OR COALESCE(t.max_players, 0) <= 2),
         lower(COALESCE(t.variant, '')) = 'spin',
         COALESCE(t.max_players, 0),
         COALESCE(t.variant, '')
    INTO v_seat_first, v_is_spin, v_cap, v_variant
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Freeze the complete table/seat set before choosing the occupied table.
  -- UUID order is deterministic across every transaction using this owner.
  PERFORM tb.id
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
   ORDER BY tb.id
   FOR UPDATE;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
     AND s.left_at IS NULL
   ORDER BY s.table_id, s.seat_number, s.id
   FOR UPDATE OF s;

  v_table := public.fn_tournament_primary_table(p_tournament_id);

  IF v_table IS NULL THEN
    IF COALESCE(v_seat_first, false) THEN
      SELECT count(*) INTO v_seats
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.left_at IS NULL;
      UPDATE public.tournaments SET current_players = v_seats
       WHERE id = p_tournament_id
         AND current_players IS DISTINCT FROM v_seats;
      RETURN v_seats;
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND left_at IS NULL;

  UPDATE public.tables SET current_players = v_seats
   WHERE id = v_table
     AND current_players IS DISTINCT FROM v_seats;

  IF COALESCE(v_seat_first, false) THEN
    UPDATE public.tournaments SET current_players = v_seats
     WHERE id = p_tournament_id
       AND current_players IS DISTINCT FROM v_seats;
  END IF;

  IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
    v_book := public.fn_spin_book_entry(p_tournament_id);
    IF COALESCE((v_book->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'paid third seat could not book Spin %: %',
        p_tournament_id,v_book USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF COALESCE(v_seat_first, false)
     AND v_cap > 0 AND v_seats >= v_cap THEN
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object(
          'tournament_id', p_tournament_id,
          'variant', v_variant,
          'max_players', v_cap,
          'paid_seats', v_seats,
          'filled_at', now()
        ),
        'seat_first_ready',
        'seat_first',
        false
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'fn_sync_seat_first_player_count: realtime.send failed for %: %',
        p_tournament_id, SQLERRM;
    END;
  END IF;

  RETURN v_seats;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_primary_table(p_tournament_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT tb.id
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
   ORDER BY (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) DESC,
     tb.created_at ASC
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.fn_bounty_obligation_has_complete_marker(p_obligation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT CASE WHEN o.mode='mystery_chest' THEN
      EXISTS (
        SELECT 1 FROM public.tournament_bounty_awards a
         WHERE a.bounty_obligation_id=o.id AND a.status='completed'
           AND (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.paid_at IS NOT NULL)=a.amount_cents
           AND NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT claimant_id,ordinal,claimant_count,
                        floor(a.amount_cents / claimant_count)
                          + CASE WHEN ordinal <= mod(a.amount_cents,claimant_count)
                                 THEN 1 ELSE 0 END AS expected_cents
                   FROM (
                     SELECT (c->>'user_id')::uuid AS claimant_id,
                            row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                            count(*) OVER () AS claimant_count
                       FROM jsonb_array_elements(o.claimants) c
                   ) ordered_claimants
               ) expected
              WHERE NOT EXISTS (
                SELECT 1 FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id=a.id AND r.user_id=expected.claimant_id
                   AND r.amount_cents=expected.expected_cents
                   AND r.paid_at IS NOT NULL
              )
           )
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_award_recipients r
              WHERE r.award_id=a.id
                AND (r.paid_at IS NULL OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.claimants) c
                   WHERE (c->>'user_id')::uuid=r.user_id
                ))
           )
      )
    ELSE
      NOT EXISTS (
        SELECT 1
          FROM (
            SELECT claimant_id, ordinal, claimant_count,
                   CASE WHEN ordinal < claimant_count
                        THEN floor(head_cents / claimant_count)
                        ELSE head_cents
                             - floor(head_cents / claimant_count) * (claimant_count - 1)
                   END AS expected_cents
              FROM (
                SELECT (c->>'user_id')::uuid AS claimant_id,
                       row_number() OVER (ORDER BY c->>'user_id') AS ordinal,
                       count(*) OVER () AS claimant_count,
                       round(o.head_amount * 100)::bigint AS head_cents
                  FROM jsonb_array_elements(o.claimants) c
              ) ordered_claimants
          ) expected
         WHERE expected.expected_cents > 0
           AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounties b
            WHERE b.bounty_obligation_id=o.id
              AND b.collector_player_id=expected.claimant_id
              AND round(b.bounty_amount * 100)::bigint=expected.expected_cents
              AND round(COALESCE(b.added_to_collector_bounty,0) * 100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN expected.expected_cents-floor(expected.expected_cents/2.0)::bigint
                         ELSE 0 END
              AND round((b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))*100)::bigint=
                    CASE WHEN o.mode='pko'
                         THEN floor(expected.expected_cents/2.0)::bigint
                         ELSE expected.expected_cents END
         )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.claimants) c
              WHERE (c->>'user_id')::uuid=b.collector_player_id
           )
      )
      AND round(COALESCE((
        SELECT sum(b.bounty_amount) FROM public.tournament_bounties b
         WHERE b.bounty_obligation_id=o.id
      ),0),2)=round(o.head_amount,2)
    END
      FROM public.tournament_bounty_obligations o
     WHERE o.id=p_obligation_id
  ),false);
$function$;
