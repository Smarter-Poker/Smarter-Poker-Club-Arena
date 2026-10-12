-- @live-proof: (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgname='zz_closed_target_pays_its_satellite_tickets' AND NOT tgisinternal)=1
-- @live-proof: strpos(pg_get_functiondef('public.fn_ca_satellite_entry_ticket_is_guarded()'::regprocedure),'app.ca_closed_target_ticket_cash')>0
-- @live-proof: to_regprocedure('public.fn_ca_pay_closed_target_ticket_in_cash(uuid,text)') IS NOT NULL AND NOT has_function_privilege('authenticated','public.fn_ca_pay_closed_target_ticket_in_cash(uuid,text)','EXECUTE')
-- @live-proof: EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_ca_pay_closed_target_ticket_in_cash' AND status='approved')
--
-- A CLOSED TARGET PAYS ITS SATELLITE TICKETS IN CASH (2026-10-12).
--
-- Every direct satellite award is a seat_or_cash entitlement
-- (tournament_satellite_entitlements.award_kind). fn_ca_settle_satellite_cohort
-- decides the delivery at the finish: a seat while the target still takes
-- entries, cash when it is closed, full or already held, and, for a winner at
-- the four-table cap while the target is open, a noncash entry-only ticket
-- for that one target. Nothing ever decided what happens to that ticket when
-- the target closes before it is used. The entry door refuses it once the
-- pool is finalized, the cash door refuses every entry-only ticket, and the
-- ticket guard refuses every other status change, so the winner's value sat
-- in ticket escrow for ever.
--
-- Measured 2026-10-12 05:40 UTC: 928 issued direct tickets worth 55,120.00
-- whose target had closed, held by 460 players (every one a horse, every one
-- an active member of the ticket's club), from 718 satellites into 56
-- targets. Among them the seven qualifiers of Sunday Funday Six-Card Closer
-- Satellite (61961519, 50.00 each, issued at 05:02 into a target whose entry
-- closed at level 9) and the five Sunday 200 Deep Stack (6561f9f4) holders
-- (200.00 each).
--
-- The rule already written for a seat that cannot be a seat is cash: the
-- entitlement kind is seat_or_cash, the cohort settlement pays a closed
-- target in cash, and on 2026-09-26 the owner ruled a never-seated satellite
-- entry is returned as cash (20260926054204). So the cash leg now applies at
-- the moment the ticket stops being usable:
--
--   fn_ca_satellite_ticket_target_is_closed   finalized pool or finishing,
--                                              finished or cancelled
--   fn_ca_pay_closed_target_ticket_in_cash    escrow -> the holder's wallet in
--                                              the ticket's own club, once,
--                                              keyed ticket:<id>:closed-target-cash
--   zz_closed_target_pays_its_satellite_tickets
--                                              AFTER UPDATE on tournaments, in the
--                                              same transaction that finalizes,
--                                              finishes or cancels the target
--
-- The ticket guard accepts exactly one new transition: issued -> redeemed when
-- the exact escrow-to-wallet leg under that key already exists in this
-- transaction and the door named the ticket on its token. The receipts are the
-- cash door's own (chip_transactions tournament_ticket_redeem and a
-- wallet_transactions credit), so fn_ca_settlement_correctness_check reads one
-- receipt per redeemed ticket as before. The leg names no tournament, so no
-- terminal event's evidence is touched. Nothing is taken from anybody: the
-- value moves from the ticket float to the holder, and supply is unchanged.
--
-- The tickets that are already stranded are settled once, through this same
-- door, by the five migrations that follow this one.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The live CREATE FUNCTION event guard requires a money writer to be
-- registered before it exists, in this same transaction. Do not replace a
-- preexisting registry decision or broaden the declaration to other doors.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes)
VALUES ('fn_ca_pay_closed_target_ticket_in_cash','approved',
 'Pays one direct satellite ticket from its own escrow to its holder in the ticket club only after the target closes; exact award and escrow-issue leg required; durable ticket idempotency key, one named chip ledger leg, ticket redemption plus chip and wallet receipts, exact balance delta, browser execution revoked.')
ON CONFLICT (proname) DO NOTHING;
DO $registry$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry
                  WHERE proname='fn_ca_pay_closed_target_ticket_in_cash'
                    AND status='approved') THEN
    RAISE EXCEPTION 'CLOSED_TARGET_TICKET_CASH_REGISTRY_CHANGED';
  END IF;
END
$registry$;

DO $preimage$
DECLARE
  v_guard text := pg_get_functiondef(
    'public.fn_ca_satellite_entry_ticket_is_guarded()'::regprocedure);
BEGIN
  IF md5(v_guard) <> 'd3ba1026c2b64578eab5c60a9485f9c2'
     AND strpos(v_guard,'app.ca_closed_target_ticket_cash')=0 THEN
    RAISE EXCEPTION
      'CLOSED_TARGET_TICKET_CASH_PREIMAGE_CHANGED: fn_ca_satellite_entry_ticket_is_guarded is %',
      md5(v_guard);
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_ticket_target_is_closed(p_target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /* A direct satellite ticket admits its holder to ONE target, and only while
     that target still takes entries. Once the target has finalized its pool,
     or is finishing, finished or cancelled, no door can ever admit the ticket
     again: the entry door refuses a finalized pool and every terminal state.
     Both facts only ever move one way, so a closed answer is permanent. */
  SELECT COALESCE((
    SELECT upper(COALESCE(t.status::text,'')) IN
             ('COMPLETING','COMPLETED','CANCELLED','CANCELED')
        OR COALESCE(t.prize_pool_finalized,false)
      FROM public.tournaments t
     WHERE t.id=p_target_id),false);
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_entry_ticket_is_guarded()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_token uuid := NULLIF(
    current_setting('app.ca_satellite_ticket_use_token',true),'')::uuid;
  v_cash_token uuid := NULLIF(
    current_setting('app.ca_closed_target_ticket_cash',true),'')::uuid;
  v_authorization public.tournament_ticket_admission_authorizations%ROWTYPE;
  v_rows integer;
BEGIN
  IF TG_OP='DELETE' AND OLD.redemption_mode='tournament_entry_only' THEN
    RAISE EXCEPTION 'tournament-entry tickets are durable financial evidence'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.redemption_mode='tournament_entry_only' THEN
    IF ROW(NEW.id,NEW.club_id,NEW.issued_by,NEW.holder_id,NEW.value,NEW.note,
           NEW.redemption_mode,NEW.source_tournament_id,
           NEW.source_satellite_id,NEW.source_refund_entitlement_id,
           NEW.source_satellite_award_place,
           NEW.entry_prize,NEW.entry_bounty,NEW.entry_fee,NEW.created_at,
           NEW.cancelled_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.club_id,OLD.issued_by,OLD.holder_id,OLD.value,OLD.note,
           OLD.redemption_mode,OLD.source_tournament_id,
           OLD.source_satellite_id,OLD.source_refund_entitlement_id,
           OLD.source_satellite_award_place,
           OLD.entry_prize,OLD.entry_bounty,OLD.entry_fee,OLD.created_at,
           OLD.cancelled_at) THEN
      RAISE EXCEPTION 'tournament-entry ticket identity and rails are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      /* A SATELLITE SEAT IS SEAT OR CASH (2026-10-12). A direct satellite
         ticket whose one target can no longer admit it is paid to its holder
         in cash by fn_ca_pay_closed_target_ticket_in_cash, and only by it:
         the transition is accepted only when that door has already written
         the exact escrow-to-wallet leg under the ticket's own key in this
         transaction and named this ticket on its token. */
      IF OLD.status='issued' AND NEW.status='redeemed'
         AND v_cash_token IS NOT NULL AND v_cash_token=OLD.id
         AND OLD.redeemed_at IS NULL
         AND NEW.redeemed_at=transaction_timestamp()
         AND OLD.source_satellite_award_place IS NOT NULL
         AND OLD.source_refund_entitlement_id IS NULL
         AND public.fn_ca_satellite_ticket_target_is_closed(
               OLD.source_tournament_id)
         AND (SELECT count(*)
                FROM public.chip_ledger_idem i
                JOIN public.chip_ledger l ON l.id=i.leg_id
               WHERE i.idempotency_key=
                       'ticket:'||OLD.id::text||':closed-target-cash'
                 AND l.from_type='escrow' AND l.from_entity_id=OLD.id
                 AND l.to_type='player_wallet'
                 AND l.to_entity_id=OLD.holder_id
                 AND l.amount=OLD.value AND l.club_id=OLD.club_id
                 AND l.category='ticket_redeem'
                 AND l.tournament_id IS NULL)=1 THEN
        RETURN NEW;
      END IF;
      IF NOT (OLD.status='issued' AND NEW.status='redeemed'
              AND v_token IS NOT NULL
              AND OLD.redeemed_at IS NULL
              AND NEW.redeemed_at IS NOT NULL
              AND NEW.redeemed_at=transaction_timestamp()) THEN
        RAISE EXCEPTION
          'tournament-entry tickets can only be consumed by tournament admission'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO v_authorization
        FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id
       FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.user_id IS DISTINCT FROM OLD.holder_id
         OR NOT EXISTS(
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.id=v_authorization.registration_id
              AND tp.tournament_id=v_authorization.tournament_id
              AND tp.user_id=v_authorization.user_id
              AND tp.status::text IN ('registered','playing')) THEN
        RAISE EXCEPTION
          'tournament-entry ticket has no exact admission authorization'
          USING ERRCODE = '42501';
      END IF;
      DELETE FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION
          'tournament-entry ticket admission authorization was not consumed once'
          USING ERRCODE = 'P0404';
      END IF;
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at THEN
      RAISE EXCEPTION
        'tournament-entry ticket redemption time is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_pay_closed_target_ticket_in_cash(
  p_ticket_id uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tk public.tournament_tickets%ROWTYPE;
  v_award public.tournament_satellite_awards%ROWTYPE;
  v_key text;
  v_source text := lower(btrim(COALESCE(p_source,'')));
  v_context jsonb;
  v_setting text;
  v_before numeric;
  v_after numeric;
  v_issue_leg uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_rows integer;
BEGIN
  /* A SATELLITE SEAT IS SEAT OR CASH (2026-10-12). Every direct satellite
     award is a seat_or_cash entitlement. fn_ca_settle_satellite_cohort pays a
     winner whose target is closed in cash at the finish; a winner at the
     four-table cap while the target is still open is held a noncash ticket
     for that one target instead. When that target closes before the ticket is
     used, the ticket can never admit anybody again, so its cash leg applies:
     the escrowed value goes to the holder's wallet in the ticket's own club,
     once, keyed by the ticket. Horses are players and are paid exactly so. */
  IF p_ticket_id IS NULL OR v_source='' THEN
    RAISE EXCEPTION 'closed target ticket cash needs a ticket and a source'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_tk FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found',
      'ticket_id',p_ticket_id);
  END IF;
  v_key:='ticket:'||v_tk.id::text||':closed-target-cash';

  IF v_tk.status='redeemed' THEN
    SELECT l.id INTO v_ledger_id
      FROM public.chip_ledger_idem i JOIN public.chip_ledger l ON l.id=i.leg_id
     WHERE i.idempotency_key=v_key;
    IF v_ledger_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok',true,'replayed',true,
        'ticket_id',v_tk.id,'ledger_id',v_ledger_id,'amount',v_tk.value);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used',
      'ticket_id',v_tk.id);
  END IF;
  IF v_tk.status IS DISTINCT FROM 'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_issued',
      'ticket_id',v_tk.id);
  END IF;
  IF v_tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
     OR v_tk.source_satellite_award_place IS NULL
     OR v_tk.source_refund_entitlement_id IS NOT NULL
     OR v_tk.source_tournament_id IS NULL
     OR v_tk.source_satellite_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason',
      'not_a_direct_satellite_ticket','ticket_id',v_tk.id);
  END IF;
  IF NOT public.fn_ca_satellite_ticket_target_is_closed(
           v_tk.source_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_still_admits',
      'ticket_id',v_tk.id);
  END IF;

  -- The value being paid is exactly what the satellite escrowed for this
  -- award: the immutable award row and its one issue leg.
  SELECT * INTO v_award FROM public.tournament_satellite_awards a
   WHERE a.tournament_id=v_tk.source_satellite_id
     AND a.place=v_tk.source_satellite_award_place
     AND a.ticket_id=v_tk.id AND a.delivery_kind='ticket'
     AND a.user_id=v_tk.holder_id AND a.amount=v_tk.value;
  IF v_award.tournament_id IS NULL THEN
    RAISE EXCEPTION 'satellite ticket % has no exact award row',v_tk.id
      USING ERRCODE='P0404';
  END IF;
  SELECT l.id INTO v_issue_leg
    FROM public.chip_ledger_idem i JOIN public.chip_ledger l ON l.id=i.leg_id
   WHERE i.idempotency_key=v_award.idempotency_key||':ticket_escrow'
     AND l.from_type='prize_liability'
     AND l.from_entity_id=v_tk.source_satellite_id
     AND l.to_type='escrow' AND l.to_entity_id=v_tk.id
     AND l.amount=v_tk.value AND l.club_id=v_tk.club_id
     AND l.category='ticket_issue';
  IF v_issue_leg IS NULL THEN
    RAISE EXCEPTION 'satellite ticket % has no exact escrow issue leg',v_tk.id
      USING ERRCODE='P0404';
  END IF;

  SELECT m.chip_balance INTO v_before FROM public.club_members m
   WHERE m.club_id=v_tk.club_id AND m.user_id=v_tk.holder_id
     AND COALESCE(m.status,'active') IN ('active','approved')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason',
      'holder_not_a_member_of_ticket_club','ticket_id',v_tk.id);
  END IF;
  v_before:=COALESCE(v_before,0);

  SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),''))
    INTO v_context
    FROM unnest(ARRAY[
      'app.ledger_category','app.ledger_counterparty',
      'app.ledger_counterparty_entity','app.ledger_counterparty_label',
      'app.ledger_tournament','app.ledger_idempotency_key',
      'app.ledger_autoskip_club_members',
      'app.ca_closed_target_ticket_cash']) settings(k);

  -- This door writes its own named leg, so the anonymous journal stands down.
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM public.fn_ca_declare_ledger(
    'ticket_redeem','escrow',v_tk.id,NULL,v_key,ARRAY['club_members']);
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'escrow',v_tk.id,'satellite tournament entry ticket',
    'player_wallet',v_tk.holder_id,'player wallet',
    v_tk.value,'ticket_redeem',v_tk.club_id,NULL,
    v_key,'ticket-cash:'||v_tk.id::text,
    'fn_ca_pay_closed_target_ticket_in_cash',
    'Satellite seat paid in cash because its target no longer takes entries',
    jsonb_build_object(
      'kind','closed_target_ticket_cash','ticket_id',v_tk.id,
      'holder_id',v_tk.holder_id,
      'source_satellite_id',v_tk.source_satellite_id,
      'source_tournament_id',v_tk.source_tournament_id,
      'award_place',v_tk.source_satellite_award_place,
      'award_idempotency_key',v_award.idempotency_key,
      'issue_ledger_id',v_issue_leg,'source',v_source),
    v_tk.value,0,v_before,round(v_before+v_tk.value,2))
  RETURNING id INTO v_ledger_id;

  UPDATE public.club_members
     SET chip_balance=round(COALESCE(chip_balance,0)+v_tk.value,2),
         updated_at=now()
   WHERE club_id=v_tk.club_id AND user_id=v_tk.holder_id
     AND COALESCE(status,'active') IN ('active','approved')
   RETURNING chip_balance INTO v_after;
  IF v_after IS DISTINCT FROM round(v_before+v_tk.value,2) THEN
    RAISE EXCEPTION 'ticket % cash credit did not land exactly',v_tk.id
      USING ERRCODE='55000';
  END IF;

  PERFORM set_config('app.ca_closed_target_ticket_cash',v_tk.id::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_tk.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket % changed while it was paid in cash',v_tk.id
      USING ERRCODE='55000';
  END IF;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_tk.club_id,NULL,v_tk.holder_id,v_tk.value,'tournament_ticket_redeem',
    'Satellite Seat Paid In Cash: Target Entry Closed',v_after,
    jsonb_build_object(
      'ticket_id',v_tk.id,'issuer_id',v_tk.issued_by,
      'holder_id',v_tk.holder_id,'escrow_action','release_to_holder',
      'reason','target_entry_closed',
      'source_tournament_id',v_tk.source_tournament_id,
      'source_satellite_id',v_tk.source_satellite_id,
      'source_award_place',v_tk.source_satellite_award_place,
      'ledger_id',v_ledger_id,'idempotency_key',v_key,
      'holder_balance_after',v_after))
  RETURNING id INTO v_tx_id;
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,type,amount,category,description,balance_after)
  VALUES(
    v_tk.holder_id,'PLAYER','credit',v_tk.value,'transfer',
    'Satellite Seat Paid In Cash: Target Entry Closed',v_after);

  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_tk.id,
    'holder_id',v_tk.holder_id,'club_id',v_tk.club_id,'amount',v_tk.value,
    'target_id',v_tk.source_tournament_id,
    'satellite_id',v_tk.source_satellite_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'balance_before',v_before,'balance_after',v_after);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_pay_closed_target_ticket_in_cash(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_ticket_target_is_closed(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_pay_closed_target_tickets_in_cash(
  p_target_id uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_result jsonb;
  v_paid integer:=0;
  v_amount numeric:=0;
  v_unpaid jsonb:='[]'::jsonb;
BEGIN
  /* Runs in the transaction that closes the target, so a ticket that can no
     longer be used is paid at the moment it stops being usable. One ticket
     the door cannot pay never stops the target from closing: that ticket is
     named on a critical alert, in this same transaction, with the reason. */
  IF p_target_id IS NULL
     OR NOT public.fn_ca_satellite_ticket_target_is_closed(p_target_id) THEN
    RETURN jsonb_build_object('ok',true,'paid',0,'amount',0);
  END IF;
  FOR v_id IN
    SELECT tk.id FROM public.tournament_tickets tk
     WHERE tk.source_tournament_id=p_target_id
       AND tk.status='issued'
       AND tk.redemption_mode='tournament_entry_only'
       AND tk.source_satellite_award_place IS NOT NULL
       AND tk.source_refund_entitlement_id IS NULL
     ORDER BY tk.id
  LOOP
    BEGIN
      v_result:=public.fn_ca_pay_closed_target_ticket_in_cash(v_id,p_source);
    EXCEPTION WHEN OTHERS THEN
      v_result:=jsonb_build_object('ok',false,'reason','refused',
        'sqlstate',SQLSTATE,'message',SQLERRM,'ticket_id',v_id);
    END;
    IF COALESCE((v_result->>'ok')::boolean,false) THEN
      IF NOT COALESCE((v_result->>'replayed')::boolean,false) THEN
        v_paid:=v_paid+1;
        v_amount:=round(v_amount+(v_result->>'amount')::numeric,2);
      END IF;
    ELSE
      v_unpaid:=v_unpaid||jsonb_build_array(v_result);
      INSERT INTO public.financial_alerts(severity,source,message,context)
      VALUES('critical','fn_ca_pay_closed_target_tickets_in_cash',
        'A Satellite Ticket For A Closed Target Could Not Be Paid In Cash',
        jsonb_build_object('target_id',p_target_id,'ticket_id',v_id,
          'result',v_result));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok',jsonb_array_length(v_unpaid)=0,
    'paid',v_paid,'amount',v_amount,'unpaid',v_unpaid);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_pay_closed_target_tickets_in_cash(uuid,text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_ca_closed_target_pays_its_satellite_tickets()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_ca_pay_closed_target_tickets_in_cash(
    NEW.id,'target_entry_closed');
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_closed_target_pays_its_satellite_tickets()
  FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS tournament_tickets_issued_direct_by_target
  ON public.tournament_tickets (source_tournament_id)
  WHERE status='issued' AND source_satellite_award_place IS NOT NULL;

-- Rolled-back proof against a real stranded ticket, inside this transaction.
SAVEPOINT closed_target_ticket_cash_trial;
DO $trial$
DECLARE
  v_tk public.tournament_tickets%ROWTYPE;
  v_open uuid;
  v_r jsonb;
  v_replay jsonb;
  v_loop jsonb;
  v_before numeric;
  v_after numeric;
  v_guard text := 'no open-target ticket to try';
BEGIN
  SELECT tk.* INTO v_tk FROM public.tournament_tickets tk
   WHERE tk.status='issued' AND tk.redemption_mode='tournament_entry_only'
     AND tk.source_satellite_award_place IS NOT NULL
     AND tk.source_refund_entitlement_id IS NULL
     AND public.fn_ca_satellite_ticket_target_is_closed(tk.source_tournament_id)
   ORDER BY tk.created_at,tk.id LIMIT 1;
  IF v_tk.id IS NULL THEN
    RAISE EXCEPTION 'CLOSED_TARGET_TICKET_CASH_RESULT_CHANGED: no stranded ticket to prove against';
  END IF;
  SELECT chip_balance INTO v_before FROM public.club_members
   WHERE club_id=v_tk.club_id AND user_id=v_tk.holder_id;
  v_r:=public.fn_ca_pay_closed_target_ticket_in_cash(v_tk.id,'migration_trial');
  v_replay:=public.fn_ca_pay_closed_target_ticket_in_cash(v_tk.id,'migration_trial');
  v_loop:=public.fn_ca_pay_closed_target_tickets_in_cash(
    v_tk.source_tournament_id,'migration_trial');
  SELECT chip_balance INTO v_after FROM public.club_members
   WHERE club_id=v_tk.club_id AND user_id=v_tk.holder_id;
  SELECT tk.id INTO v_open FROM public.tournament_tickets tk
   WHERE tk.status='issued' AND tk.source_satellite_award_place IS NOT NULL
     AND NOT public.fn_ca_satellite_ticket_target_is_closed(tk.source_tournament_id)
   LIMIT 1;
  IF v_open IS NOT NULL THEN
    BEGIN
      PERFORM set_config('app.ca_closed_target_ticket_cash',v_open::text,true);
      UPDATE public.tournament_tickets
         SET status='redeemed',redeemed_at=transaction_timestamp()
       WHERE id=v_open;
      v_guard:='ACCEPTED';
    EXCEPTION WHEN insufficient_privilege THEN
      v_guard:='refused';
    END;
    PERFORM set_config('app.ca_closed_target_ticket_cash','',true);
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  IF COALESCE((v_r->>'ok')::boolean,false) IS NOT TRUE
     OR (v_r->>'replayed')::boolean
     OR (v_r->>'amount')::numeric IS DISTINCT FROM v_tk.value
     OR COALESCE((v_replay->>'replayed')::boolean,false) IS NOT TRUE
     OR COALESCE((v_loop->>'ok')::boolean,false) IS NOT TRUE
     OR v_after IS DISTINCT FROM round(COALESCE(v_before,0)+v_tk.value
          +COALESCE((SELECT sum(o.value) FROM public.tournament_tickets o
                      WHERE o.source_tournament_id=v_tk.source_tournament_id
                        AND o.holder_id=v_tk.holder_id AND o.club_id=v_tk.club_id
                        AND o.id<>v_tk.id AND o.redeemed_at=transaction_timestamp()),0),2)
     OR (SELECT status FROM public.tournament_tickets WHERE id=v_tk.id)<>'redeemed'
     OR (SELECT count(*) FROM public.chip_transactions ct
          WHERE ct.transaction_type='tournament_ticket_redeem'
            AND ct.metadata->>'ticket_id'=v_tk.id::text)<>1
     OR EXISTS (SELECT 1 FROM public.tournament_tickets o
                 WHERE o.source_tournament_id=v_tk.source_tournament_id
                   AND o.status='issued' AND o.source_satellite_award_place IS NOT NULL)
     OR v_guard='ACCEPTED' THEN
    RAISE EXCEPTION 'CLOSED_TARGET_TICKET_CASH_RESULT_CHANGED: % | % | % | wallet % -> % | guard %',
      v_r,v_replay,v_loop,v_before,v_after,v_guard;
  END IF;
  RAISE NOTICE 'closed target ticket cash proved on ticket % (% chips, target %), loop %, guard %',
    v_tk.id,v_tk.value,v_tk.source_tournament_id,v_loop,v_guard;
END
$trial$;
ROLLBACK TO SAVEPOINT closed_target_ticket_cash_trial;
RELEASE SAVEPOINT closed_target_ticket_cash_trial;

CREATE OR REPLACE TRIGGER zz_closed_target_pays_its_satellite_tickets
  AFTER UPDATE OF status, prize_pool_finalized ON public.tournaments
  FOR EACH ROW
  WHEN ((NEW.prize_pool_finalized IS TRUE
         AND OLD.prize_pool_finalized IS NOT TRUE)
     OR (upper(COALESCE(NEW.status::text,'')) IN
           ('COMPLETING','COMPLETED','CANCELLED','CANCELED')
         AND upper(COALESCE(OLD.status::text,'')) NOT IN
           ('COMPLETING','COMPLETED','CANCELLED','CANCELED')))
  EXECUTE FUNCTION public.trg_ca_closed_target_pays_its_satellite_tickets();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT 'tournaments','zz_closed_target_pays_its_satellite_tickets',
  'When a target finalizes its pool, finishes or is cancelled, pays each still-issued direct satellite ticket for it to the holder in cash through fn_ca_pay_closed_target_ticket_in_cash (seat_or_cash). 20261012054804.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ca_declared_money_triggers d
   WHERE d.table_name='tournaments'
     AND d.trigger_name='zz_closed_target_pays_its_satellite_tickets');

DO $prove$
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid='public.tournaments'::regclass
         AND tgname='zz_closed_target_pays_its_satellite_tickets'
         AND NOT tgisinternal)<>1
     OR strpos(pg_get_functiondef(
          'public.fn_ca_satellite_entry_ticket_is_guarded()'::regprocedure),
          'app.ca_closed_target_ticket_cash')=0
     OR has_function_privilege('authenticated',
          'public.fn_ca_pay_closed_target_ticket_in_cash(uuid,text)','EXECUTE')
     OR has_function_privilege('anon',
          'public.fn_ca_pay_closed_target_tickets_in_cash(uuid,text)','EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM public.ca_declared_money_triggers d
                     WHERE d.table_name='tournaments'
                       AND d.trigger_name='zz_closed_target_pays_its_satellite_tickets') THEN
    RAISE EXCEPTION 'CLOSED_TARGET_TICKET_CASH_RESULT_CHANGED: install incomplete';
  END IF;
END
$prove$;

COMMIT;
