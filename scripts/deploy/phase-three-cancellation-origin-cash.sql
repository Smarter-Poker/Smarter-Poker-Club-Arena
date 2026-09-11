-- Prepared Phase 3 cancellation cash policy correction. NOT APPLIED.
-- Current eligible unstarted cancellation already uses immutable funded entries.
-- Route satellite and redeemed-ticket entries through the same approved exact
-- cash refund payer as unregistration. Preserve stored historical ticket receipts,
-- the never-cancel-started guard, all original ledger proofs and exact replay.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $dependencies$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(
  'public.fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)')
  AND md5(prosrc)='0024ca5acfc4e4e12b51a4609349e98d'
  AND proowner='postgres'::regrole AND prosecdef)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(
  'public.fn_ca_tournament_refund_plan(uuid,uuid)')
  AND md5(prosrc)='27cedb21bac278709f43f037a31403a0'
  AND proowner='postgres'::regrole AND prosecdef)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(
  'public.fn_ca_lock_settlement_lane_global()')
  AND md5(prosrc)='343015440ea5c84ee4ca7ae583c73d30'
  AND proowner='postgres'::regrole AND NOT prosecdef) THEN
  RAISE EXCEPTION 'cancellation cash routing requires the exact current refund, plan and settlement lane authorities';
 END IF;
END $dependencies$;
DO $cash_writer$
DECLARE v_oid oid:=to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)');
 v_source text; v_definition text; v_replacement text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT p.prosrc,pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'
 INTO v_source,v_definition,v_before FROM pg_proc p
 WHERE p.oid=v_oid AND p.proowner='postgres'::regrole AND p.prosecdef
  AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=public, extensions, pg_temp','statement_timeout=120s']::text[]
  AND NOT p.proisstrict AND p.provolatile='v' AND p.proparallel='u'
  AND p.prorettype='jsonb'::regtype AND NOT p.proretset
  AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql');
 IF NOT FOUND THEN RAISE EXCEPTION 'cancellation cash writer authority differs'; END IF;
 IF md5(v_source)='623100aa87ed6d0ef1a3598fb9ccb8b3' THEN RETURN; END IF;
 IF md5(v_source)<>'16ea7acbbf76613a0a1193dff18f1330' THEN RAISE EXCEPTION 'cancellation cash writer source differs'; END IF;
 v_replacement:=v_source;
 IF (length(v_replacement)-length(replace(v_replacement,$old_writer_0$  v_ticket jsonb;
$old_writer_0$,'')))
      IS DISTINCT FROM length($old_writer_0$  v_ticket jsonb;
$old_writer_0$) THEN
  RAISE EXCEPTION 'cancellation cash writer fragment 0 differs'; END IF;
 v_replacement:=replace(v_replacement,$old_writer_0$  v_ticket jsonb;
$old_writer_0$,$new_writer_0$$new_writer_0$);
 IF (length(v_replacement)-length(replace(v_replacement,$old_writer_1$  -- Consume one immutable entitlement at a time. Wallet charges go back as
  -- chips to their exact source club. A satellite-funded seat or spent entry
  -- ticket is not chips: it becomes a tournament-entry-only ticket carrying
  -- the same immutable rails and original satellite identity.$old_writer_1$,'')))
      IS DISTINCT FROM length($old_writer_1$  -- Consume one immutable entitlement at a time. Wallet charges go back as
  -- chips to their exact source club. A satellite-funded seat or spent entry
  -- ticket is not chips: it becomes a tournament-entry-only ticket carrying
  -- the same immutable rails and original satellite identity.$old_writer_1$) THEN
  RAISE EXCEPTION 'cancellation cash writer fragment 1 differs'; END IF;
 v_replacement:=replace(v_replacement,$old_writer_1$  -- Consume one immutable entitlement at a time. Wallet charges go back as
  -- chips to their exact source club. A satellite-funded seat or spent entry
  -- ticket is not chips: it becomes a tournament-entry-only ticket carrying
  -- the same immutable rails and original satellite identity.$old_writer_1$,$new_writer_1$  -- Return each unconsumed funded entitlement as cash to its recorded club.
  -- The exact refund payer proves wallet, satellite transfer or redeemed-ticket
  -- funding and excludes value already returned as a ticket. Stored historical
  -- cancellation receipts continue to replay through their original evidence.$new_writer_1$);
 IF (length(v_replacement)-length(replace(v_replacement,$old_writer_2$      IF v_entitlement.entitlement_kind='wallet_charge' THEN$old_writer_2$,'')))
      IS DISTINCT FROM length($old_writer_2$      IF v_entitlement.entitlement_kind='wallet_charge' THEN$old_writer_2$) THEN
  RAISE EXCEPTION 'cancellation cash writer fragment 2 differs'; END IF;
 v_replacement:=replace(v_replacement,$old_writer_2$      IF v_entitlement.entitlement_kind='wallet_charge' THEN$old_writer_2$,$new_writer_2$      IF v_entitlement.entitlement_kind IN (
          'wallet_charge','satellite_seat','tournament_ticket') THEN$new_writer_2$);
 IF (length(v_replacement)-length(replace(v_replacement,$old_writer_3$           OR v_settle->>'entitlement_kind' IS DISTINCT FROM 'wallet_charge'$old_writer_3$,'')))
      IS DISTINCT FROM length($old_writer_3$           OR v_settle->>'entitlement_kind' IS DISTINCT FROM 'wallet_charge'$old_writer_3$) THEN
  RAISE EXCEPTION 'cancellation cash writer fragment 3 differs'; END IF;
 v_replacement:=replace(v_replacement,$old_writer_3$           OR v_settle->>'entitlement_kind' IS DISTINCT FROM 'wallet_charge'$old_writer_3$,$new_writer_3$           OR v_settle->>'entitlement_kind' IS DISTINCT FROM v_entitlement.entitlement_kind$new_writer_3$);
 IF (length(v_replacement)-length(replace(v_replacement,$old_writer_4$          'entitlement_kind','wallet_charge',$old_writer_4$,'')))
      IS DISTINCT FROM length($old_writer_4$          'entitlement_kind','wallet_charge',$old_writer_4$) THEN
  RAISE EXCEPTION 'cancellation cash writer fragment 4 differs'; END IF;
 v_replacement:=replace(v_replacement,$old_writer_4$          'entitlement_kind','wallet_charge',$old_writer_4$,$new_writer_4$          'entitlement_kind',v_entitlement.entitlement_kind,$new_writer_4$);
 IF (length(v_replacement)-length(replace(v_replacement,$old_writer_5$      ELSIF v_entitlement.entitlement_kind IN (
          'satellite_seat','tournament_ticket') THEN
        v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
          v_entitlement.id,'atomic_cancel_tournament',
          'Cancelled tournament seat returned as entry ticket: '
            ||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_ticket->>'replayed')::boolean,true) IS NOT FALSE
           OR (v_ticket->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_ticket->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_ticket->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_ticket->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee
           OR (v_ticket->>'refund_wallet_club_id')::uuid
                IS DISTINCT FROM v_entitlement.refund_wallet_club_id
           OR NULLIF(v_ticket->>'ticket_id','') IS NULL
           OR NULLIF(v_ticket->>'ledger_id','') IS NULL
           OR NULLIF(v_ticket->>'transaction_id','') IS NULL THEN
          RAISE EXCEPTION 'satellite ticket return refused entitlement %: %',
            v_entitlement.id,v_ticket USING ERRCODE='55000';
        END IF;
        v_ticket_return_ids:=array_append(
          v_ticket_return_ids,(v_ticket->>'ticket_id')::uuid);
        v_ticket_returns:=v_ticket_returns||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind',v_entitlement.entitlement_kind,
          'ticket_id',(v_ticket->>'ticket_id')::uuid,
          'value',(v_ticket->>'value')::numeric,
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'source_satellite_id',v_entitlement.source_satellite_id,
          'refund_prize',(v_ticket->>'refund_prize')::numeric,
          'refund_bounty',(v_ticket->>'refund_bounty')::numeric,
          'refund_fee',(v_ticket->>'refund_fee')::numeric,
          'ledger_id',(v_ticket->>'ledger_id')::uuid,
          'transaction_id',(v_ticket->>'transaction_id')::uuid));
        v_ticket_return_count:=v_ticket_return_count+1;
        v_total_ticket_returned:=round(
          v_total_ticket_returned+(v_ticket->>'value')::numeric,2);
$old_writer_5$,'')))
      IS DISTINCT FROM length($old_writer_5$      ELSIF v_entitlement.entitlement_kind IN (
          'satellite_seat','tournament_ticket') THEN
        v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
          v_entitlement.id,'atomic_cancel_tournament',
          'Cancelled tournament seat returned as entry ticket: '
            ||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_ticket->>'replayed')::boolean,true) IS NOT FALSE
           OR (v_ticket->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_ticket->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_ticket->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_ticket->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee
           OR (v_ticket->>'refund_wallet_club_id')::uuid
                IS DISTINCT FROM v_entitlement.refund_wallet_club_id
           OR NULLIF(v_ticket->>'ticket_id','') IS NULL
           OR NULLIF(v_ticket->>'ledger_id','') IS NULL
           OR NULLIF(v_ticket->>'transaction_id','') IS NULL THEN
          RAISE EXCEPTION 'satellite ticket return refused entitlement %: %',
            v_entitlement.id,v_ticket USING ERRCODE='55000';
        END IF;
        v_ticket_return_ids:=array_append(
          v_ticket_return_ids,(v_ticket->>'ticket_id')::uuid);
        v_ticket_returns:=v_ticket_returns||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind',v_entitlement.entitlement_kind,
          'ticket_id',(v_ticket->>'ticket_id')::uuid,
          'value',(v_ticket->>'value')::numeric,
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'source_satellite_id',v_entitlement.source_satellite_id,
          'refund_prize',(v_ticket->>'refund_prize')::numeric,
          'refund_bounty',(v_ticket->>'refund_bounty')::numeric,
          'refund_fee',(v_ticket->>'refund_fee')::numeric,
          'ledger_id',(v_ticket->>'ledger_id')::uuid,
          'transaction_id',(v_ticket->>'transaction_id')::uuid));
        v_ticket_return_count:=v_ticket_return_count+1;
        v_total_ticket_returned:=round(
          v_total_ticket_returned+(v_ticket->>'value')::numeric,2);
$old_writer_5$) THEN
  RAISE EXCEPTION 'cancellation cash writer fragment 5 differs'; END IF;
 v_replacement:=replace(v_replacement,$old_writer_5$      ELSIF v_entitlement.entitlement_kind IN (
          'satellite_seat','tournament_ticket') THEN
        v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
          v_entitlement.id,'atomic_cancel_tournament',
          'Cancelled tournament seat returned as entry ticket: '
            ||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_ticket->>'replayed')::boolean,true) IS NOT FALSE
           OR (v_ticket->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_ticket->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_ticket->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_ticket->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee
           OR (v_ticket->>'refund_wallet_club_id')::uuid
                IS DISTINCT FROM v_entitlement.refund_wallet_club_id
           OR NULLIF(v_ticket->>'ticket_id','') IS NULL
           OR NULLIF(v_ticket->>'ledger_id','') IS NULL
           OR NULLIF(v_ticket->>'transaction_id','') IS NULL THEN
          RAISE EXCEPTION 'satellite ticket return refused entitlement %: %',
            v_entitlement.id,v_ticket USING ERRCODE='55000';
        END IF;
        v_ticket_return_ids:=array_append(
          v_ticket_return_ids,(v_ticket->>'ticket_id')::uuid);
        v_ticket_returns:=v_ticket_returns||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind',v_entitlement.entitlement_kind,
          'ticket_id',(v_ticket->>'ticket_id')::uuid,
          'value',(v_ticket->>'value')::numeric,
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'source_satellite_id',v_entitlement.source_satellite_id,
          'refund_prize',(v_ticket->>'refund_prize')::numeric,
          'refund_bounty',(v_ticket->>'refund_bounty')::numeric,
          'refund_fee',(v_ticket->>'refund_fee')::numeric,
          'ledger_id',(v_ticket->>'ledger_id')::uuid,
          'transaction_id',(v_ticket->>'transaction_id')::uuid));
        v_ticket_return_count:=v_ticket_return_count+1;
        v_total_ticket_returned:=round(
          v_total_ticket_returned+(v_ticket->>'value')::numeric,2);
$old_writer_5$,$new_writer_5$$new_writer_5$);
 IF md5(v_replacement)<>'623100aa87ed6d0ef1a3598fb9ccb8b3' THEN RAISE EXCEPTION 'cancellation cash writer candidate differs'; END IF;
 EXECUTE replace(v_definition,v_source,v_replacement);
 SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
 IF v_after IS DISTINCT FROM v_before OR NOT EXISTS(SELECT 1 FROM pg_proc
   WHERE oid=v_oid AND md5(prosrc)='623100aa87ed6d0ef1a3598fb9ccb8b3') THEN
  RAISE EXCEPTION 'cancellation cash writer postcondition differs'; END IF;
END $cash_writer$;
DO $cash_verifier$
DECLARE v_oid oid:=to_regprocedure('public.fn_ca_tournament_cancellation_receipt(uuid,uuid)');
 v_source text; v_definition text; v_replacement text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT p.prosrc,pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'
 INTO v_source,v_definition,v_before FROM pg_proc p
 WHERE p.oid=v_oid AND p.proowner='postgres'::regrole AND p.prosecdef
  AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]
  AND NOT p.proisstrict AND p.provolatile='s' AND p.proparallel='u'
  AND p.prorettype='jsonb'::regtype AND NOT p.proretset
  AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql');
 IF NOT FOUND THEN RAISE EXCEPTION 'cancellation cash verifier authority differs'; END IF;
 IF md5(v_source)='0b6abcc8e4bb561856699e5d24a86fc9' THEN RETURN; END IF;
 IF md5(v_source)<>'1e4c6d2f87ac2068455dbff2ace3fb2e' THEN RAISE EXCEPTION 'cancellation cash verifier source differs'; END IF;
 v_replacement:=v_source;
 IF (length(v_replacement)-length(replace(v_replacement,$old_verifier_0$           OR e.entitlement_kind IS DISTINCT FROM 'wallet_charge'$old_verifier_0$,'')))
      IS DISTINCT FROM length($old_verifier_0$           OR e.entitlement_kind IS DISTINCT FROM 'wallet_charge'$old_verifier_0$) THEN
  RAISE EXCEPTION 'cancellation cash verifier fragment 0 differs'; END IF;
 v_replacement:=replace(v_replacement,$old_verifier_0$           OR e.entitlement_kind IS DISTINCT FROM 'wallet_charge'$old_verifier_0$,$new_verifier_0$           OR e.entitlement_kind NOT IN ('wallet_charge','satellite_seat','tournament_ticket')$new_verifier_0$);
 IF md5(v_replacement)<>'0b6abcc8e4bb561856699e5d24a86fc9' THEN RAISE EXCEPTION 'cancellation cash verifier candidate differs'; END IF;
 EXECUTE replace(v_definition,v_source,v_replacement);
 SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
 IF v_after IS DISTINCT FROM v_before OR NOT EXISTS(SELECT 1 FROM pg_proc
   WHERE oid=v_oid AND md5(prosrc)='0b6abcc8e4bb561856699e5d24a86fc9') THEN
  RAISE EXCEPTION 'cancellation cash verifier postcondition differs'; END IF;
END $cash_verifier$;
COMMIT;
