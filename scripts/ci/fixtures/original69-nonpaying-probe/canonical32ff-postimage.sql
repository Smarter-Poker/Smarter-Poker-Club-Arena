-- Read-only qualification input from PR8913 head0a5243885bd73fc39087a7b16e3b154de5bd68f9.
-- This fixture is NOT a shipping migration or replacement payer.
CREATE TABLE smarter_private.tournament_abort_recoveries (
 tournament_id uuid PRIMARY KEY,
 operation_id uuid NOT NULL,
 recovery_id uuid NOT NULL,
 owner_instruction text NOT NULL,
 instance_id text NOT NULL,
 lease_generation uuid NOT NULL,
 release_sha text NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40}$'),
 freeze_started_at timestamptz NOT NULL,
 ownership_token uuid NOT NULL,
 original_target jsonb NOT NULL,
 original_custody jsonb NOT NULL,
 money_snapshot jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE smarter_private.tournament_abort_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.tournament_abort_recoveries FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.tournament_abort_recovery_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'original_tournament_recovery_disposition_immutable' USING ERRCODE='55000'; END $fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_recovery_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER tournament_abort_recovery_immutable BEFORE UPDATE OR DELETE ON smarter_private.tournament_abort_recoveries
FOR EACH ROW EXECUTE FUNCTION smarter_private.tournament_abort_recovery_immutable();
CREATE TRIGGER tournament_abort_recovery_no_truncate BEFORE TRUNCATE ON smarter_private.tournament_abort_recoveries FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.tournament_abort_recovery_immutable();
CREATE FUNCTION smarter_private.assert_tournament_abort_not_recovered(p_operation_id uuid,p_tournament_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private AS $fn$
BEGIN
 -- An older repeatable-read snapshot cannot safely observe a new append-only disposition.
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'operator_abort_read_committed_required' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_recoveries WHERE tournament_id=p_tournament_id AND operation_id=p_operation_id) THEN
  RAISE EXCEPTION 'operator_abort_withdrawn_for_original_recovery' USING ERRCODE='55000';
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.assert_tournament_abort_not_recovered(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_tournament_abort(p_operation_id uuid, p_tournament_id uuid, p_expected_money_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.tournament_abort_targets;t public.tournaments; financial jsonb; v_receipt jsonb; pre_roster jsonb; pre_seats jsonb; before_history jsonb; after_history jsonb;
 player_ids uuid[];refunded_ids uuid[];zero_ids uuid[];table_ids uuid[];seat_ids uuid[];released_ids uuid[];fee_ids uuid[]:='{}';
 fee record;fee_id uuid; rake_before numeric;rake_after numeric;fees_reversed numeric:=0; settled timestamptz:=clock_timestamp();
 actor constant uuid:='2d1cd6c3-5700-4af9-a271-d4863fdab20d'; v_close_note constant text:='Explicit operator started-event abort after generation-bound physical and manager drain';
BEGIN
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 PERFORM smarter_private.assert_tournament_abort_not_recovered(p_operation_id,p_tournament_id);
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'operator_abort_service_required' USING ERRCODE='42501';END IF;
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_target_not_owned';END IF;
 IF a.state='settled' THEN RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id);END IF;
 PERFORM smarter_private.assert_tournament_abort_quiesced(p_operation_id,p_tournament_id);
 IF p_expected_money_hash IS NULL OR p_expected_money_hash IS DISTINCT FROM a.quiescence->>'money_hash' THEN RAISE EXCEPTION 'operator_abort_review_hash_mismatch' USING ERRCODE='55000';END IF;
 IF t.started_at IS NULL OR upper(t.status) NOT IN('RUNNING','BREAK','LATE_REG') THEN RAISE EXCEPTION 'operator_abort_parent_not_running';END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id ORDER BY s.id FOR UPDATE OF s;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'),coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') INTO player_ids,pre_roster FROM public.tournament_players p WHERE tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO table_ids FROM public.tables WHERE tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO seat_ids FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'table_id',s.table_id,'user_id',s.user_id,'seat_number',s.seat_number,'stack',s.stack,'status',s.status,'left_at',s.left_at,'occupancy_id',to_jsonb(s)->'occupancy_id') ORDER BY s.id),'[]'::jsonb) INTO pre_seats FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO released_ids FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id AND s.left_at IS NULL;
 before_history:=jsonb_build_object('awards',a.money_snapshot->'awards','bounty_awards',a.money_snapshot->'bounty_awards','satellite_awards',a.money_snapshot->'satellite_awards',
  'hands',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id)::text,'[]')) FROM public.hand_history h WHERE h.tournament_id=p_tournament_id));
 IF a.asset='diamonds' THEN financial:=smarter_private.diamond_tournament_abort_refunds(p_operation_id,p_tournament_id);
 ELSE financial:=smarter_private.chip_tournament_abort_refunds(p_operation_id,p_tournament_id);END IF;
 IF financial->>'fully_settled' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'operator_abort_financial_receipt_incomplete';END IF;
 SELECT coalesce(sum(rake_amount),0) INTO rake_before FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF rake_before<0 OR rake_before::text IN('NaN','Infinity','-Infinity') OR round(coalesce(t.total_rake,0),2) IS DISTINCT FROM rake_before THEN RAISE EXCEPTION 'operator_abort_rake_cache_mismatch';END IF;
 FOR fee IN SELECT club_id,metadata->>'user_id' user_id,sum(rake_amount) amount,jsonb_agg(id ORDER BY id) source_ids FROM public.rake_records
  WHERE tournament_id=p_tournament_id AND is_tournament GROUP BY club_id,metadata->>'user_id' HAVING sum(rake_amount)>0 ORDER BY club_id,metadata->>'user_id' LOOP
  IF fee.club_id IS NULL OR fee.user_id IS NULL THEN RAISE EXCEPTION 'operator_abort_unattributed_rake_source';END IF;
  INSERT INTO public.rake_records(club_id,rake_amount,pot_size,num_players,bbj_contribution,is_tournament,tournament_id,source,metadata)
  VALUES(fee.club_id,-fee.amount,fee.amount,1,0,true,p_tournament_id,'operator_abort_tournament',jsonb_build_object('kind','tournament_fee_refund','operation_id',p_operation_id,'user_id',fee.user_id,'original_rake_record_ids',fee.source_ids)) RETURNING id INTO fee_id;
  fee_ids:=array_append(fee_ids,fee_id);fees_reversed:=fees_reversed+fee.amount;
 END LOOP;
 SELECT coalesce(sum(rake_amount),0) INTO rake_after FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF rake_after<>0 OR fees_reversed IS DISTINCT FROM rake_before THEN RAISE EXCEPTION 'operator_abort_rake_not_exactly_closed';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=p_tournament_id AND enforced AND closed_at IS NULL AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0) THEN RAISE EXCEPTION 'operator_abort_escrow_not_exact_zero';END IF;
 UPDATE public.tournament_escrow SET closed_at=settled,close_note=v_close_note,updated_at=now() WHERE tournament_id=p_tournament_id;
 -- Keep original eliminated_at, elimination sequence, finish position and prize.
 -- Active remaining virtual stacks are administrative retirements, not results.
 UPDATE public.tournament_players SET status='eliminated',chips=0,current_bounty=0 WHERE tournament_id=p_tournament_id AND status::text<>'eliminated';
 UPDATE public.table_seats s SET left_at=coalesce(s.left_at,settled),status='left',stack=0,leave_pending=false,is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
  FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id;
 UPDATE public.tournaments SET status='CANCELLED',ended_at=settled,updated_at=now(),prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,on_break=false,break_started_at=NULL,break_ends_at=NULL WHERE id=p_tournament_id;
 UPDATE public.tables SET status='closed',lifecycle='closed',current_players=0,terminal_closed_at=settled,updated_at=now() WHERE tournament_id=p_tournament_id;
 after_history:=jsonb_build_object('awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'awards','bounty_awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'bounty_awards','satellite_awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'satellite_awards',
  'hands',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id)::text,'[]')) FROM public.hand_history h WHERE h.tournament_id=p_tournament_id));
 IF before_history IS DISTINCT FROM after_history THEN RAISE EXCEPTION 'operator_abort_earned_results_or_original_hands_changed:%:%:%:%',before_history,after_history,financial->'prior_awards_preserved',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.tournament_obligations o WHERE tournament_id=p_tournament_id AND kind<>'refund');END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refunded_ids FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(financial->'refunds') r WHERE (r->>'user_id')::uuid=p.user_id);
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO zero_ids FROM unnest(player_ids) id WHERE NOT id=ANY(refunded_ids);
 v_receipt:=jsonb_build_object('ok',true,'success',true,'fully_settled',true,'receipt_version',3,'mode','started_operator_abort','operation_id',p_operation_id,'tournament_id',p_tournament_id,'actor_id',actor,'status','CANCELLED',
 'source_player_count',cardinality(player_ids),'refunded_count',cardinality(refunded_ids),'refund_line_count',jsonb_array_length(financial->'refunds'),'ticket_return_count',0,'ticket_returns','[]'::jsonb,'total_ticket_returned',0,
 'total_refunded',(financial->>'total_refunded')::numeric,'fees_reversed',fees_reversed,'closed_table_count',cardinality(table_ids),'source_seat_count',cardinality(seat_ids),'released_seat_count',cardinality(released_ids),'refunds',financial->'refunds','settled_at',settled,
 'original_started_at',t.started_at,'financial',financial,'pre_abort_roster',pre_roster,'pre_abort_seats',pre_seats,'preserved_history',before_history,'quiescence',a.quiescence,'terminal_snapshot',smarter_private.tournament_abort_terminal_snapshot(p_tournament_id));
 UPDATE smarter_private.tournament_abort_targets SET state='settled',receipt=v_receipt,settled_at=settled WHERE tournament_id=p_tournament_id AND operation_id=p_operation_id;
 INSERT INTO public.tournament_cancellation_receipts(tournament_id,actor_id,receipt_version,source_player_count,source_player_ids,refunded_count,refunded_registration_ids,refund_line_count,ticket_return_count,ticket_return_ids,total_ticket_returned,zero_refund_count,zero_refund_registration_ids,total_refunded,fees_reversed,total_rake_before,total_rake_after,closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,released_seat_count,released_seat_ids,fee_reversal_ids,escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,receipt,settled_at)
 VALUES(p_tournament_id,actor,3,cardinality(player_ids),player_ids,cardinality(refunded_ids),refunded_ids,jsonb_array_length(financial->'refunds'),0,'{}',0,cardinality(zero_ids),zero_ids,(financial->>'total_refunded')::numeric,fees_reversed,rake_before,rake_after,cardinality(table_ids),table_ids,cardinality(seat_ids),seat_ids,cardinality(released_ids),released_ids,fee_ids,settled,v_close_note,NULL,v_receipt,settled);
 IF a.asset='chips' THEN PERFORM public.fn_record_accounting_tournament_cancellation(p_tournament_id);END IF;
 RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id);
END $function$
;
