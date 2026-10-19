-- 20261019093516_ticket_late_registration_calls_the_canonical_capacity_functi.sql
--
-- A LATE TICKET ENTRY CALLS THE CAPACITY FUNCTION THAT EXISTS (2026-10-19)
--
-- WHAT WAS BROKEN, READ FROM PRODUCTION
--
-- public.fn_ca_register_for_tournament_with_ticket_for seats a ticket holder
-- straight into a running tournament while late registration is open. When
-- the first seating attempt fails (no open chair, or the seat gate refuses
-- with 55000) it opens capacity and tries again. Both of those retries called
--
--     PERFORM public.fn_create_late_registration_capacity(p_tournament_id);
--
-- That function was dropped on purpose on 2026-09-08 (20260908042200) and
-- replaced by public.fn_ensure_late_registration_capacity(uuid, integer). The
-- stale call came back in the 2026-10-17 rewrite
-- 20261017004440_satellites_seat_bounty_targets, which copied an older body.
-- PL/pgSQL resolves a call only when it runs, so nothing failed at install:
-- the first time a late ticket entry needed a new table, the call raised
-- 42883 "function does not exist", which no handler catches, and the WHOLE
-- registration rolled back - the ticket stayed unredeemed and the player (a
-- human or a horse; the engine reaches this path through
-- horseEntryRefusalBackoff.ts) was refused an entry they were owed.
--
-- THE FIX (CLAUDE.md 10.11, the line that produced the outcome)
--
-- Both calls now read
--
--     PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,0);
--
-- RESERVED ENTRIES IS 0, NOT 1, AND WHY. By the time this retry runs, this
-- function has already inserted the entrant into tournament_players with
-- status 'registered' and no chair (line "INSERT INTO public.tournament_players"
-- above the retry). fn_ensure_late_registration_capacity counts every
-- registered/playing entrant without a usable chair as demand, so the entrant
-- is already counted once. That is exactly how fn_seat_late_registrant itself
-- calls it ("The entry already exists here, so reserve no second entry").
-- 1 would count this player twice, and because a non-zero reservation also
-- requires the entry window to still read open, an entrant who is the one who
-- fills the field would get 'entry_window_closed', no table, and the same
-- refusal. fn_register_for_tournament and fn_register_horse_for_tournament
-- pass 1 because their failed first attempt is ROLLED BACK before they call
-- it, so their entrant is not yet a row; that is not this function's shape.
-- (The unapplied Stage-B draft 20260910055955_*.sql.pending wrote 1 here; it
-- never ran and is not followed.)
--
-- Nothing else changes: every other byte is the production body (md5 of
-- pg_get_functiondef read 2026-10-19 = 377446dc1ccce91cbf8a7af0c713ec7f),
-- the grants are restated exactly as production holds them, and the closing
-- block proves the post-image and that no live function anywhere still calls
-- the dropped name. Live path only: no sweep, no repair job (10.12).
-- Pinned by tests/a-late-ticket-entry-calls-a-capacity-function-that-exists.law.test.ts.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)) = 'e0d819b12bce27a76df329f89506194f'

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
DECLARE v_md5 text;
BEGIN
  v_md5 := md5(pg_get_functiondef(
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure));
  IF v_md5 IS DISTINCT FROM '377446dc1ccce91cbf8a7af0c713ec7f'
     AND v_md5 IS DISTINCT FROM 'e0d819b12bce27a76df329f89506194f' THEN
    RAISE EXCEPTION 'TICKET_LATE_CAPACITY_PREIMAGE_CHANGED: %', v_md5;
  END IF;
  IF to_regprocedure('public.fn_ensure_late_registration_capacity(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'TICKET_LATE_CAPACITY_REPLACEMENT_MISSING';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(p_tournament_id uuid, p_ticket_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_split record;
  v_username text;
  v_registration_id uuid;
  v_ledger_id uuid;
  v_tx_id uuid;
  v_entitlement_id uuid;
  v_resolved_club uuid;
  v_is_bounty boolean;
  v_late_open boolean:=false;
  v_start_chips integer:=0;
  v_seat jsonb;
  v_seat_reason text;
  v_players_before integer;
  v_wallet_rows_before bigint;
  v_wallet_rows_after bigint;
  v_rows integer;
  v_key text;
  v_ticket_use_token uuid:=gen_random_uuid();
  v_previous_ticket_use_token text:=
    current_setting('app.ca_satellite_ticket_use_token',true);
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_ticket_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament, ticket and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;

  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.id=p_ticket_id FOR UPDATE;
  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_found');
  END IF;
  IF v_ticket.holder_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_owned');
  END IF;
  IF v_ticket.redemption_mode IS DISTINCT FROM 'tournament_entry_only' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_is_wallet_only');
  END IF;

  IF v_ticket.source_refund_entitlement_id IS NOT NULL THEN
    SELECT count(*) INTO v_rows
      FROM public.tournament_refund_entitlements source_e
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key='tourney:'
             ||source_e.tournament_id::text
             ||':satellite-ticket-return:'||source_e.id::text
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_e.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
     WHERE source_e.id=v_ticket.source_refund_entitlement_id
       AND v_ticket.source_satellite_award_place IS NULL
       AND source_e.user_id=v_uid
       AND source_e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND source_e.gross=v_ticket.value
       AND source_e.refund_prize=v_ticket.entry_prize
       AND source_e.refund_bounty=v_ticket.entry_bounty
       AND source_e.refund_fee=v_ticket.entry_fee
       AND source_e.source_satellite_id=v_ticket.source_satellite_id
       AND source_e.tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=source_e.id)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1;
  ELSE
    -- A cap-blocked satellite winner never held a target registration, so its
    -- noncash ticket is sourced directly by the immutable satellite award.
    SELECT count(*) INTO v_rows
      FROM public.tournament_satellite_awards source_a
      JOIN public.tournament_satellite_settlements source_h
        ON source_h.tournament_id=source_a.tournament_id
      JOIN public.tournament_payouts source_p ON source_p.id=source_a.payout_id
      JOIN public.chip_ledger issue_l
        ON issue_l.idempotency_key=source_a.idempotency_key||':ticket_escrow'
       AND issue_l.from_type='prize_liability'
       AND issue_l.from_entity_id=source_a.tournament_id
       AND issue_l.to_type='escrow' AND issue_l.to_entity_id=v_ticket.id
       AND issue_l.club_id=v_ticket.club_id AND issue_l.amount=v_ticket.value
       AND issue_l.category='ticket_issue'
       AND issue_l.tournament_id=source_a.tournament_id
       AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
       AND issue_l.metadata->>'ticket_id'=v_ticket.id::text
       AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
       AND issue_l.metadata->>'satellite_target_id'=
             v_ticket.source_tournament_id::text
       AND issue_l.metadata->>'user_id'=source_a.user_id::text
       AND COALESCE(issue_l.metadata->>'position',issue_l.metadata->>'award_slot')=source_a.place::text
     WHERE source_a.tournament_id=v_ticket.source_satellite_id
       AND source_a.place=v_ticket.source_satellite_award_place
       AND source_a.user_id=v_uid
       AND source_a.delivery_kind='ticket'
       AND source_a.ticket_id=v_ticket.id
       AND source_a.amount=v_ticket.value
       AND source_a.payout_source='satellite_ticket'
       AND source_p.tournament_id=source_a.tournament_id
       AND source_p.user_id=source_a.user_id
       AND (source_p."position"=source_a.place OR source_h.receipt_version>=3)
       AND source_p.amount=source_a.amount
       AND source_p.source=source_a.payout_source
       AND source_p.idempotency_key=source_a.idempotency_key
       AND source_h.target_id=v_ticket.source_tournament_id
       AND source_h.ticket_cost=v_ticket.value
       -- A bounty target's seat ticket carries its bounty slice: the
       -- target's buy-in is the ticket's prize plus bounty (2026-10-16).
       AND source_h.target_buy_in=round(v_ticket.entry_prize+v_ticket.entry_bounty,2)
       AND source_h.target_fee=v_ticket.entry_fee
       AND p_tournament_id=v_ticket.source_tournament_id
       AND NOT EXISTS(
         SELECT 1 FROM public.wallet_credit_idempotency wallet_key
          WHERE wallet_key.key=source_a.idempotency_key)
       AND (SELECT count(*) FROM public.chip_transactions issue_tx
             WHERE issue_tx.transaction_type='tournament_ticket_issue'
               AND issue_tx.club_id=v_ticket.club_id
               AND issue_tx.from_user_id IS NULL AND issue_tx.to_user_id=v_uid
               AND issue_tx.amount=v_ticket.value
               AND issue_tx.metadata->>'ticket_id'=v_ticket.id::text
               AND issue_tx.metadata->>'source_tournament_id'=
                     p_tournament_id::text
               AND issue_tx.metadata->>'source_satellite_id'=source_a.tournament_id::text
               AND issue_tx.metadata->>'source_award_place'=source_a.place::text
               AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
               AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
               AND issue_tx.metadata->>'idempotency_key'=
                     source_a.idempotency_key)=1;
  END IF;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket has no exact noncash issue evidence'
      USING ERRCODE='P0404';
  END IF;

  IF v_ticket.status='redeemed' THEN
    SELECT count(*),min(e.id::text)::uuid,min(e.registration_id::text)::uuid
      INTO v_rows,v_entitlement_id,v_registration_id
      FROM public.tournament_refund_entitlements e
      JOIN public.tournament_players tp ON tp.id=e.registration_id
     WHERE e.source_ticket_id=v_ticket.id
       AND e.entitlement_kind='tournament_ticket'
       AND e.tournament_id=p_tournament_id
       AND e.user_id=v_uid
       AND tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id;
    IF v_rows=1 AND v_entitlement_id IS NOT NULL
       AND v_registration_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok',true,'replayed',true,'ticket_id',v_ticket.id,
        'registration_id',v_registration_id,
        'entitlement_id',v_entitlement_id,'wallet_chips_credited',0);
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','ticket_already_used');
  END IF;
  IF v_ticket.status<>'issued' THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_not_available');
  END IF;

  IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND (lower(COALESCE(v_t.variant,''))='spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players>0 AND v_t.max_players<=2)) THEN
    RETURN jsonb_build_object('ok',false,'reason','seat_first_variant');
  END IF;
  IF v_t.status='RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id)
                 AND NOT COALESCE(v_t.prize_pool_finalized,false);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED','REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
  END IF;
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_full');
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id=p_tournament_id AND tp.user_id=v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','already_registered');
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.club_members m
     WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
       AND COALESCE(m.status,'active') IN ('active','approved')) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_membership_inactive');
  END IF;
  IF v_t.union_id IS NULL AND v_t.club_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_club_mismatch');
  END IF;
  IF v_t.union_id IS NOT NULL
     AND v_ticket.club_id IS DISTINCT FROM v_t.club_id AND NOT EXISTS(
    SELECT 1 FROM public.union_clubs uc
     WHERE uc.union_id=v_t.union_id AND uc.club_id=v_ticket.club_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_union_mismatch');
  END IF;
  v_resolved_club:=public.fn_tournament_club_for_user(
    v_uid,p_tournament_id,v_ticket.club_id);
  IF v_resolved_club IS DISTINCT FROM v_ticket.club_id THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_source_club_unavailable');
  END IF;

  IF COALESCE(v_t.authorized_to_register,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_registration_approvals a
        WHERE a.tournament_id=p_tournament_id AND a.user_id=v_uid)
     AND NOT public.is_club_admin(v_ticket.club_id,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized_to_register');
  END IF;
  IF COALESCE(v_t.is_vip_only,false)
     AND NOT EXISTS(
       SELECT 1 FROM public.profiles pr
        WHERE pr.id=v_uid AND COALESCE(pr.is_vip,false)
          AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at>now()))
     AND NOT EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=v_ticket.club_id AND m.user_id=v_uid
          AND m.role IN ('owner','co_owner','admin','agent')) THEN
    RETURN jsonb_build_object('ok',false,'reason','vip_only');
  END IF;

  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<=0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2)
     OR v_ticket.value IS DISTINCT FROM v_split.charge
     OR v_ticket.entry_prize IS DISTINCT FROM v_split.prize
     OR v_ticket.entry_bounty IS DISTINCT FROM v_split.bounty
     OR v_ticket.entry_fee IS DISTINCT FROM v_split.rake THEN
    RETURN jsonb_build_object('ok',false,'reason','ticket_entry_contract_mismatch');
  END IF;

  IF COALESCE(v_t.early_bird_enabled,false)
     AND now()<v_t.start_time AND COALESCE(v_t.early_bird_chips,0)>0 THEN
    v_start_chips:=v_t.early_bird_chips;
  END IF;
  SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(p.username,''),'Player')
    INTO v_username FROM public.profiles p WHERE p.id=v_uid;
  v_username:=COALESCE(v_username,'Player');

  PERFORM public.fn_ca_escrow_apply(p_tournament_id,'ticket admission prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  SELECT count(*) INTO v_wallet_rows_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     -- A running bounty event's bank is its pool less what knockouts have
     -- already paid from it, so a late ticket seat compares against that
     -- (2026-10-16), as both settlement authorities do.
     OR v_escrow_before.bounty_balance IS DISTINCT FROM
          round(COALESCE(v_t.bounty_pool,0)-COALESCE(v_t.bounty_pool_paid,0),2)
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance THEN
    RAISE EXCEPTION 'ticket admission found divergent tournament escrow'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_players(
    tournament_id,user_id,username,chips,status,current_bounty,
    mystery_bounty_value,bounties_collected,bounty_winnings,
    club_id,is_satellite_qualifier,source_satellite_id)
  VALUES(
    p_tournament_id,v_uid,v_username,v_start_chips,'registered',
    v_split.bounty,0,0,0,v_ticket.club_id,true,v_ticket.source_satellite_id)
  RETURNING id INTO v_registration_id;

  v_key:='ticket:'||v_ticket.id::text||':tournament:'
         ||p_tournament_id::text||':entry';
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    v_uid,'escrow',v_ticket.id,'tournament entry ticket',
    'prize_liability',p_tournament_id,'tournaments escrow',
    v_ticket.value,'ticket_redeem',v_ticket.club_id,p_tournament_id,
    v_key,'ticket-entry:'||v_ticket.id::text,
    'fn_register_for_tournament_with_ticket',
    'Tournament-entry ticket committed to tournament admission',
    jsonb_build_object(
      'kind','tournament_entry_ticket_admission','ticket_id',v_ticket.id,
      'user_id',v_uid,'registration_id',v_registration_id,
      'source_tournament_id',v_ticket.source_tournament_id,
      'source_satellite_id',v_ticket.source_satellite_id,
      'entry_prize',v_ticket.entry_prize,
      'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee),
    v_ticket.value,0,
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance,2),
    round(v_escrow_before.prize_balance+v_escrow_before.bounty_balance
          +v_escrow_before.fee_balance+v_ticket.value,2))
  RETURNING id INTO v_ledger_id;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'tournament-entry ticket admission',
    p_gross_in=>v_ticket.value,p_bounty_in=>v_ticket.entry_bounty);
  IF v_ticket.entry_fee>0 THEN
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(
      NULL,NULL,v_ticket.club_id,v_ticket.entry_fee,v_ticket.value,1,
      0,true,p_tournament_id,'fn_register_for_tournament_with_ticket',
      jsonb_build_object(
        'kind','tournament_ticket_entry_fee','user_id',v_uid,
        'registration_id',v_registration_id,'ticket_id',v_ticket.id));
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before+1,
         prize_pool=round(v_t.prize_pool+v_ticket.entry_prize,2),
         bounty_pool=round(v_t.bounty_pool+v_ticket.entry_bounty,2),
         total_rake=round(v_t.total_rake+v_ticket.entry_fee,2),
         updated_at=now()
   WHERE id=p_tournament_id
     -- Before the start the canonical roster trigger has already counted
     -- the row inserted above. A RUNNING field is not counted on INSERT
     -- (20260922141704): this door publishes that count itself, as the
     -- wallet doors do. Expect exactly the state the trigger left.
     AND current_players IS NOT DISTINCT FROM CASE
       WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
       ELSE v_players_before
     END
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'ticket admission tournament cache changed'
      USING ERRCODE='55000';
  END IF;

  INSERT INTO public.tournament_ticket_admission_authorizations(
    token,ticket_id,tournament_id,user_id,registration_id)
  VALUES(
    v_ticket_use_token,v_ticket.id,p_tournament_id,v_uid,v_registration_id);

  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',v_ticket_use_token::text,true);
  UPDATE public.tournament_tickets
     SET status='redeemed',redeemed_at=transaction_timestamp()
   WHERE id=v_ticket.id AND status='issued';
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',
    COALESCE(v_previous_ticket_use_token,''),true);
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament-entry ticket changed during admission'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.tournament_ticket_admission_authorizations a
     WHERE a.token=v_ticket_use_token) THEN
    RAISE EXCEPTION
      'tournament-entry ticket authorization was not consumed by admission'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    source_ticket_id,escrow_bucket,evidence_kind,created_at)
  VALUES(
    p_tournament_id,v_uid,'tournament_ticket','tournament_ticket',
    v_ticket.club_id,v_ticket.value,v_ticket.entry_prize,
    v_ticket.entry_bounty,v_ticket.entry_fee,v_ledger_id,
    v_registration_id,v_ticket.source_satellite_id,NULL,v_ticket.id,
    'ticket_gross','atomic_tournament_ticket',transaction_timestamp())
  RETURNING id INTO v_entitlement_id;

  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_ticket.club_id,v_uid,NULL,v_ticket.value,
    'tournament_ticket_entry','Tournament-Entry Ticket Used',NULL,
    jsonb_build_object(
      'ticket_id',v_ticket.id,'holder_id',v_uid,
      'target_tournament_id',p_tournament_id,
      'registration_id',v_registration_id,
      'entitlement_id',v_entitlement_id,'ledger_id',v_ledger_id,
      'idempotency_key',v_key,'wallet_chips_credited',0))
  RETURNING id INTO v_tx_id;

  IF v_late_open THEN
    BEGIN
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,0);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
    END;
    v_seat_reason:=v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean,false)
       AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
      PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,0);
      v_seat:=public.fn_seat_late_registrant(p_tournament_id,v_uid);
      v_seat_reason:=v_seat->>'reason';
      IF NOT COALESCE((v_seat->>'ok')::boolean,false)
         AND COALESCE(v_seat_reason,'')<>'already_seated_or_missing' THEN
        RAISE EXCEPTION
          'Late ticket admission could not seat the player (%)',
          COALESCE(v_seat_reason,'unknown') USING ERRCODE='55000';
      END IF;
    END IF;
    -- The wake reasons are a closed list (fn_emit_tournament_manager_wake
    -- and tournament_manager_wakes_reason_check); the engine acts on
    -- 'late_registration'. A reason outside it rolled back every late
    -- ticket entry (20261012).
    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_registration');
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_wallet_rows_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_uid;
  IF v_escrow_after.prize_balance IS DISTINCT FROM
       round(v_escrow_before.prize_balance+v_ticket.entry_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
       round(v_escrow_before.bounty_balance+v_ticket.entry_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
       round(v_escrow_before.fee_balance+v_ticket.entry_fee,2)
     OR v_wallet_rows_after IS DISTINCT FROM v_wallet_rows_before THEN
    RAISE EXCEPTION 'ticket admission did not preserve exact noncash rails'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'registration_id',v_registration_id,'entitlement_id',v_entitlement_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id,
    'ticket_value',v_ticket.value,'wallet_chips_credited',0,
    'prize_contribution',v_ticket.entry_prize,
    'bounty_contribution',v_ticket.entry_bounty,
    'fee_contribution',v_ticket.entry_fee,'late_registration',v_late_open,
    'seat',v_seat);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $postimage$
DECLARE v_md5 text; v_acl text; v_stale text;
BEGIN
  v_md5 := md5(pg_get_functiondef(
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure));
  IF v_md5 IS DISTINCT FROM 'e0d819b12bce27a76df329f89506194f' THEN
    RAISE EXCEPTION 'TICKET_LATE_CAPACITY_POSTIMAGE_CHANGED: %', v_md5;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p
   WHERE p.oid='public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'TICKET_LATE_CAPACITY_ACL_CHANGED: %', v_acl;
  END IF;
  -- No live function in any user schema may still call the dropped name.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_stale
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
     AND p.prokind IN ('f','p')
     AND p.prosrc LIKE '%fn_create_late_registration_capacity%';
  IF v_stale IS NOT NULL THEN
    RAISE EXCEPTION 'TICKET_LATE_CAPACITY_STALE_CALLER_REMAINS: %', v_stale;
  END IF;
END
$postimage$;

COMMIT;
