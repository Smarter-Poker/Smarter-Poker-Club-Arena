-- Phase 3: eligible funded satellite unregisters use the approved cash rail.
-- No historical tickets or balances are changed. Preserve the installed start authority.
-- Follows the actual-start migration installed as 20260909215545; preserves its rules.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $patch$
DECLARE v_definition text; v_before text; v_after text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)'::regprocedure) INTO v_definition;
  v_before := $replace_0$  -- tranche. A funded satellite seat is deliberately excluded: that source
  -- can be returned only as another tournament-entry ticket, never as chips.$replace_0$;
  v_after := $replace_0$  -- tranche. Satellite entry value is ordinary funded target escrow under
  -- the approved cash rule. Its original transfer must be proved exactly;
  -- a ticket already issued for this entitlement consumes that same value.$replace_0$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_settle_tournament_refund_exact replacement 0 source changed';
  END IF;
  v_before := $replace_1$     AND e.entitlement_kind='wallet_charge'
   ORDER BY e.entitlement_kind,e.id$replace_1$;
  v_after := $replace_1$     AND e.entitlement_kind IN ('wallet_charge','satellite_seat','tournament_ticket')
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
   ORDER BY e.entitlement_kind,e.id$replace_1$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_settle_tournament_refund_exact replacement 1 source changed';
  END IF;
  v_before := $replace_2$  SELECT count(*) INTO v_rows FROM public.chip_ledger l
   WHERE l.id=v_entitlement.source_ledger_id
     AND l.tournament_id=v_entitlement.tournament_id
     AND l.club_id=v_entitlement.refund_wallet_club_id
     AND l.from_type='player_wallet'
     AND l.from_entity_id=v_entitlement.user_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_entitlement.tournament_id
     AND lower(l.category)=v_entitlement.charge_category
     AND l.amount=v_entitlement.gross;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'refund entitlement lost its exact wallet-debit source'
      USING ERRCODE = 'P0404';
  END IF;$replace_2$;
  v_after := $replace_2$  SELECT count(*) INTO v_rows FROM public.chip_ledger l
   WHERE l.id=v_entitlement.source_ledger_id
     AND l.club_id=v_entitlement.refund_wallet_club_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_entitlement.tournament_id
     AND l.amount=v_entitlement.gross
     AND (
       (v_entitlement.entitlement_kind='wallet_charge'
        AND l.tournament_id=v_entitlement.tournament_id
        AND l.from_type='player_wallet'
        AND l.from_entity_id=v_entitlement.user_id
        AND lower(l.category)=v_entitlement.charge_category)
       OR (v_entitlement.entitlement_kind='satellite_seat'
        AND l.from_type='prize_liability'
        AND l.from_entity_id=v_entitlement.source_satellite_id
        AND l.metadata->>'user_id'=v_entitlement.user_id::text
        AND l.metadata->>'registration_id'=v_entitlement.registration_id::text)
       OR (v_entitlement.entitlement_kind='tournament_ticket'
        AND l.tournament_id=v_entitlement.tournament_id
        AND l.from_type='escrow'
        AND l.from_entity_id=v_entitlement.source_ticket_id
        AND l.category='ticket_redeem'
        AND l.metadata->>'user_id'=v_entitlement.user_id::text
        AND l.metadata->>'registration_id'=v_entitlement.registration_id::text
        AND EXISTS (
          SELECT 1 FROM public.tournament_tickets tk
           WHERE tk.id=v_entitlement.source_ticket_id
             AND tk.holder_id=v_entitlement.user_id AND tk.status='redeemed'
             AND tk.redemption_mode='tournament_entry_only'
             AND tk.value=v_entitlement.gross
             AND tk.entry_prize=v_entitlement.refund_prize
             AND tk.entry_bounty=v_entitlement.refund_bounty
             AND tk.entry_fee=v_entitlement.refund_fee
             AND tk.source_satellite_id=v_entitlement.source_satellite_id)));
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'refund entitlement lost its exact funded source'
      USING ERRCODE = 'P0404';
  END IF;$replace_2$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_settle_tournament_refund_exact replacement 2 source changed';
  END IF;
  v_before := $replace_3$  -- The debit journal is the immutable source-wallet fact. A refund may land
  -- only in that same club wallet, and never through the generic tournament
  -- wallet chooser. Existing credits in that wallet reduce its remaining
  -- capacity, so even an owner-only caller cannot redirect or over-credit it.$replace_3$;
  v_after := $replace_3$  -- Wallet debits and funded satellite transfers are separate sources.
  -- The immutable entitlement fixes the recipient club. Existing cash refunds
  -- reduce capacity; a value already returned as a ticket cannot fund cash.$replace_3$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_settle_tournament_refund_exact replacement 3 source changed';
  END IF;
  v_before := $replace_4$     AND l.category IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_credits$replace_4$;
  v_after := $replace_4$     AND l.category IN ('tournament_buyin','rebuy','addon');
  SELECT v_source_debits + round(COALESCE(sum(e.gross),0),2)
    INTO v_source_debits
    FROM public.tournament_refund_entitlements e
    JOIN public.chip_ledger l ON l.id=e.source_ledger_id
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.refund_wallet_club_id=p_source_wallet_club_id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND l.club_id=e.refund_wallet_club_id
     AND l.to_type='prize_liability' AND l.to_entity_id=e.tournament_id
     AND l.amount=e.gross
     AND l.metadata->>'user_id'=e.user_id::text
     AND l.metadata->>'registration_id'=e.registration_id::text
     AND ((e.entitlement_kind='satellite_seat'
           AND l.from_type='prize_liability'
           AND l.from_entity_id=e.source_satellite_id)
       OR (e.entitlement_kind='tournament_ticket'
           AND l.from_type='escrow' AND l.from_entity_id=e.source_ticket_id
           AND l.category='ticket_redeem'))
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_credits$replace_4$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_settle_tournament_refund_exact replacement 4 source changed';
  END IF;
  EXECUTE v_definition;
END;
$patch$;
DO $patch$
DECLARE v_definition text; v_before text; v_after text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'::regprocedure) INTO v_definition;
  v_before := $replace_0$  v_ticket jsonb;
$replace_0$;
  v_after := $replace_0$$replace_0$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact replacement 0 source changed';
  END IF;
  v_before := $replace_1$         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind='wallet_charge'),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind IN ('satellite_seat','tournament_ticket')),0),2)$replace_1$;
  v_after := $replace_1$         round(COALESCE(sum(e.gross),0),2),
         0::numeric$replace_1$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact replacement 1 source changed';
  END IF;
  v_before := $replace_2$  -- A satellite seat, including a returned ticket that was used for a later
  -- target entry, is a noncash entry for its entire registration lifecycle.
  -- Any wallet-charge entitlement attached to that registration is corrupt;
  -- refuse the whole transaction instead of ever returning chips.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND (v_wallet_amount<>0 OR v_ticket_amount<=0
       OR v_refund_total IS DISTINCT FROM v_ticket_amount) THEN
    RAISE EXCEPTION
      'satellite-funded registration % can return only a tournament ticket',
      v_reg.id USING ERRCODE='P0404';
  END IF;$replace_2$;
  v_after := $replace_2$  -- A funded satellite entry does not invent a player-wallet debit.
  -- It returns the same escrow value in cash through its exact source proof.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND EXISTS (
       SELECT 1 FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND e.entitlement_kind='wallet_charge'
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_refund_tranches tr
             WHERE tr.entitlement_id=e.id)) THEN
    RAISE EXCEPTION
      'satellite-funded registration % has an unexpected wallet charge',
      v_reg.id USING ERRCODE='P0404';
  END IF;$replace_2$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact replacement 2 source changed';
  END IF;
  v_before := $replace_3$     OR v_wallet_refunds_before>v_wallet_debits THEN$replace_3$;
  v_after := $replace_3$     OR v_wallet_refunds_before>(
       SELECT COALESCE(sum(e.gross),0)
         FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_tickets tk
             WHERE tk.source_refund_entitlement_id=e.id)) THEN$replace_3$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact replacement 3 source changed';
  END IF;
  v_before := $replace_4$  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.entitlement_kind='wallet_charge'$replace_4$;
  v_after := $replace_4$  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)$replace_4$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact replacement 4 source changed';
  END IF;
  v_before := $replace_5$     ORDER BY e.id
  LOOP
    v_running_owed$replace_5$;
  v_after := $replace_5$     ORDER BY e.entitlement_kind,e.id
  LOOP
    v_running_owed$replace_5$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact replacement 5 source changed';
  END IF;
  v_before := $replace_6$  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.registration_id=v_reg.id
       AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
      v_ent.id,'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
       OR (v_ticket->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_ticket->>'refund_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id
       OR (v_ticket->>'ticket_id') IS NULL THEN
      RAISE EXCEPTION 'registration % tournament-ticket return failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_ticket_ids:=array_append(v_ticket_ids,(v_ticket->>'ticket_id')::uuid);
  END LOOP;

$replace_6$;
  v_after := $replace_6$$replace_6$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact replacement 6 source changed';
  END IF;
  EXECUTE v_definition;
END;
$patch$;
DO $patch$
DECLARE v_definition text; v_before text; v_after text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)'::regprocedure) INTO v_definition;
  v_before := $replace_0$     AND e.entitlement_kind='wallet_charge'
     AND tr.wallet_transaction_id$replace_0$;
  v_after := $replace_0$     AND e.entitlement_kind IN ('wallet_charge','satellite_seat','tournament_ticket')
     AND tr.wallet_transaction_id$replace_0$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_tournament_unregistration_receipt replacement 0 source changed';
  END IF;
  v_before := $replace_1$'wallet_chips_from_satellite_entitlements',0$replace_1$;
  v_after := $replace_1$'wallet_chips_from_satellite_entitlements',(
      SELECT COALESCE(sum(tr.amount_paid_now),0)
        FROM public.tournament_refund_tranches tr
        JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
       WHERE e.id=ANY(v_r.entitlement_ids)
         AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
         AND tr.wallet_transaction_id=ANY(v_r.wallet_transaction_ids)
         AND tr.credit_ledger_id=ANY(v_r.credit_ledger_ids)
         AND tr.tournament_id=v_r.tournament_id AND tr.user_id=v_r.user_id)$replace_1$;
  v_matches := (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before);
  IF v_matches=1 THEN
    v_definition:=replace(v_definition,v_before,v_after);
  ELSIF v_matches=0 AND (v_after='' OR position(v_after IN v_definition)>0) THEN
    NULL; -- The reserved actual-start migration may already include this correction.
  ELSE
    RAISE EXCEPTION 'fn_ca_tournament_unregistration_receipt replacement 1 source changed';
  END IF;
  EXECUTE v_definition;
END;
$patch$;
COMMIT;
