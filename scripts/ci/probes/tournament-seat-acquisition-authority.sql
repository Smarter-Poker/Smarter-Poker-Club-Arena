-- Run after 20260909014433. This probe is read-only: it verifies the installed
-- root lock hierarchy, raw-DML guard, public wrapper ACLs and service-only
-- atomic assignment. The final PASS exception prevents accidental state from
-- being committed if this file is ever extended.
DO $probe$
DECLARE
  v_source text;
  v_global integer;
  v_maintenance integer;
  v_mission integer;
  v_launch integer;
  v_tournament integer;
BEGIN
  IF to_regprocedure(
       'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_seat_cap(uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_rebuy_window(uuid)') IS NULL
     OR to_regprocedure(
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)') IS NULL
     OR to_regprocedure(
       'public.fn_tournament_live_seat_acquisition_requires_authority()') IS NULL THEN
    RAISE EXCEPTION 'FAIL tournament seat acquisition authority is incomplete';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure;
  v_global:=position('ca:tournament-terminal-settlement:v1' IN v_source);
  v_maintenance:=position('pg_advisory_xact_lock_shared(530090,1)' IN v_source);
  v_mission:=position('public.fn_lock_daily_mission_user(p_user_id)' IN v_source);
  v_launch:=position('FROM public.tournament_launch_receipts r' IN v_source);
  v_tournament:=position('FROM public.tournaments t' IN v_source);
  IF v_global=0 OR v_maintenance<=v_global OR v_mission<=v_maintenance
     OR v_launch<=v_mission OR v_tournament<=v_launch
     OR v_source ~* 'NOWAIT|pg_try_advisory|deadlock_detected|pg_sleep'
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL tournament seat root lock order or ACL changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure;
  IF position('FROM pg_catalog.pg_locks l' IN v_source)=0
     OR position('l.pid=pg_backend_pid()' IN v_source)=0
     OR position('l.objsubid=1' IN v_source)=0
     OR position('TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
          IN v_source)=0
     OR v_source ~* 'pg_(try_)?advisory'
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid='public.table_seats'::regclass
          AND g.tgname='a0_tournament_live_seat_root_guard'
          AND g.tgfoid=
            'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure
          AND NOT g.tgisinternal AND g.tgenabled='O' AND g.tgtype=23)
     OR has_function_privilege(
       'service_role',
       'public.fn_tournament_live_seat_acquisition_requires_authority()',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL raw tournament seat acquisition guard changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)'::regprocedure;
  IF position('fn_caller_is_engine' IN v_source)=0
     OR position('fn_ca_lock_tournament_seat_acquisition' IN v_source)=0
     OR position('fn_ca_assign_tournament_player_seat_locked' IN v_source)=0
     OR position('INSERT INTO public.table_seats' IN v_source)>0
     OR position('UPDATE public.tournament_players' IN v_source)>0
     OR position('UPDATE public.tables' IN v_source)>0
     OR has_function_privilege(
       'anon',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL atomic tournament seat assignment changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_tournament_seat_cap(uuid)'::regprocedure;
  IF position('WHEN v_format=''spin''' IN v_source)=0
     OR position('THEN 3' IN v_source)=0
     OR position('WHEN v_format=''sng''' IN v_source)=0
     OR position('NULLIF(v_t.max_players,0),6' IN v_source)=0
     OR position('NULLIF(v_t.table_size,0),9' IN v_source)=0
     OR position('WHEN ''plo5'' THEN 9' IN v_source)=0
     OR position('WHEN ''plo6'' THEN 7' IN v_source)=0
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_seat_cap(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL tournament format/deck seat cap changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)'::regprocedure;
  IF position('INSERT INTO public.table_seats' IN v_source)=0
     OR position('UPDATE public.tournament_players tp' IN v_source)=0
     OR position('UPDATE public.tables tb' IN v_source)=0
     OR position('current_players' IN v_source)=0
     OR position('replayed' IN v_source)=0
     OR position('v_expected_club_id:=public.fn_seat_club_for_user' IN v_source)=0
     OR position('player_id=NULL' IN v_source)=0
     OR position('member_id=NULL' IN v_source)=0
     OR position('horse_id=v_expected_horse_id' IN v_source)=0
     OR position('club_id=v_expected_club_id' IN v_source)=0
     OR position('time_bank_remaining=v_time_bank_seconds' IN v_source)=0
     OR position('time_bank_uses_remaining=v_time_bank_uses' IN v_source)=0
     OR position('atomic tournament seat assignment final proof is not exact'
          IN v_source)=0
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL owner-only tournament seat assignment core changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure;
  IF position('fn_ensure_late_registration_capacity' IN v_source)=0
     OR position('FOR UPDATE OF tb' IN v_source)=0
     OR position('TOURNAMENT_SEAT_CAPACITY_UNAVAILABLE' IN v_source)=0
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL owner-only tournament seat chooser changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure;
  IF position('FROM public.settlement_idempotency_keys k' IN v_source)=0
     OR position('FROM public.tournament_knockout_candidates c' IN v_source)=0
     OR position('FROM public.hand_atomic_commits a' IN v_source)=0
     OR position('a.hand_id=v_candidate_hand_id' IN v_source)=0
     OR position('a.stack_result->>''hand_id''' IN v_source)=0
     OR position('k.hand_id=v_settlement_hand_id' IN v_source)=0
     OR position('k.status=''succeeded''' IN v_source)=0
     OR position('k.completed_at IS NOT NULL' IN v_source)=0
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL exact accepted-hand rebuy evidence changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure;
  IF position('NULLIF(v_t.rebuy_levels,0)' IN v_source)=0
     OR position('NULLIF(v_t.late_reg_levels,0)' IN v_source)=0
     OR position('make_interval(mins=>v_t.late_reg_mins)' IN v_source)=0
     OR position('v_t.addon_period_started_at' IN v_source)=0
     OR position('v_t.addon_period_ends_at' IN v_source)=0
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_rebuy_window(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL single rebuy-window policy changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
  IF position('p_client_token IS NULL OR length(btrim(p_client_token))=0' IN v_source)=0
     OR position('length(btrim(p_client_token))>128' IN v_source)=0
     OR position('v_club:=v_p.club_id' IN v_source)=0
     OR position('refusing a substituted wallet' IN v_source)=0
     OR position('v_was_seated:=true' IN v_source)=0
     OR position('''seated'',v_was_seated' IN v_source)=0
     OR position('trunc(v_total*v_ratio*100+0.000001)/100' IN v_source)=0
     OR position('trunc(v_total*0.1*100+0.000001)/100' IN v_source)=0
     OR position('round(COALESCE(v_t.bounty_amount,0),2)' IN v_source)=0
     OR v_source ~* 'GREATEST[[:space:]]*\([[:space:]]*1[[:space:]]*,[[:space:]]*round[[:space:]]*\([[:space:]]*v_total'
     OR v_source ~* 'double_submit_collapsed|1500 milliseconds|:\#|v_legacy|fn_player_home_club'
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL private tournament money core kept a legacy substitute';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
  IF position('public.fn_caller_session_is_live()' IN v_source)=0
     OR position('SESSION_REVOKED' IN v_source)=0
     OR position('ca:tournament-terminal-settlement:v1' IN v_source)=0
     OR position('FROM public.entry_purchase_idempotency_receipts r' IN v_source)=0
     OR position('fn_claim_entry_purchase_receipt' IN v_source)=0
     OR position('fn_entry_purchases_frozen' IN v_source)=0
     OR position('fn_ca_latest_committed_knockout_candidate' IN v_source)=0
     OR position('fn_ca_tournament_rebuy_window' IN v_source)=0
     OR position('fn_ca_process_tournament_chip_purchase_money_v1' IN v_source)=0
     OR (length(v_source)-length(replace(v_source,'atomic-table:','')))
          /length('atomic-table:')<>2
     OR position('v_table_id:=v_candidate_peek.table_id' IN v_source)=0
     OR position('Add-on live table changed after its atomic-table lock' IN v_source)=0
     OR position('UPDATE public.tournament_knockout_candidates c' IN v_source)=0
     OR position('SET user_id=p_user_id,player_id=NULL,member_id=NULL' IN v_source)=0
     OR position('v_final_seat.status::text<>''active''' IN v_source)=0
     OR position('COALESCE(v_final_seat.is_sitting_out,false)' IN v_source)=0
     OR position('COALESCE(v_final_seat.leave_pending,false)' IN v_source)=0
     OR position('v_final_seat.horse_id IS DISTINCT FROM v_expected_horse_id'
          IN v_source)=0
     OR position(
          'v_final_seat.club_id IS DISTINCT FROM v_expected_club_id'
          IN v_source)=0
     OR position('fn_ca_assign_tournament_player_seat_locked' IN v_source)=0
     OR position('fn_record_entry_purchase_receipt' IN v_source)=0
     OR position('atomic_tournament_chip_purchase' IN v_source)=0
     OR position('FROM public.entry_purchase_idempotency_receipts r' IN v_source)
          > position('fn_ca_latest_committed_knockout_candidate' IN v_source)
     OR position('double_submit_collapsed' IN v_source)>0
     OR position('process_tournament_rebuy_before_' IN v_source)>0
     OR has_function_privilege(
       'anon',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'authenticated',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL atomic tournament chip purchase changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes i
     WHERE i.schemaname='public'
       AND i.indexname='idx_tournament_knockout_candidates_user_hand'
       AND i.indexdef LIKE '%(tournament_id, eliminated_user_id, hand_number DESC, id DESC)%') THEN
    RAISE EXCEPTION 'FAIL latest-player knockout generation index changed';
  END IF;
  IF to_regprocedure(
       'public.process_tournament_rebuy_before_maintenance_announcement_gate(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure(
       'public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure(
       'public.process_tournament_rebuy_before_bounty_guard_20260907(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure(
       'public.process_tournament_rebuy_before_one_minute_addon(uuid,uuid,text,numeric,numeric,integer,text)') IS NOT NULL
     OR to_regprocedure('public.fn_after_tournament_rebuy(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL retired tournament chip purchase path survived';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_sync_seat_first_player_count(uuid)'::regprocedure;
  IF position('ca:tournament-terminal-settlement:v1' IN v_source)>0
     OR position('v_book := public.fn_spin_book_entry' IN v_source)=0
     OR has_function_privilege(
       'service_role','public.fn_sync_seat_first_player_count(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL AFTER-seat sync reacquired globally or was exposed';
  END IF;

  IF has_function_privilege(
       'anon','public.fn_take_seat_and_buy_in(uuid,integer)','EXECUTE')
     OR NOT has_function_privilege(
       'authenticated','public.fn_take_seat_and_buy_in(uuid,integer)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_seat_horse_in_seat_first_game(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_seat_horse_in_seat_first_game(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_seat_late_registrant(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_seat_late_registrant(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL tournament seat public wrapper ACL changed';
  END IF;

  RAISE EXCEPTION 'PASS tournament seat acquisition authority is exact';
END;
$probe$;
