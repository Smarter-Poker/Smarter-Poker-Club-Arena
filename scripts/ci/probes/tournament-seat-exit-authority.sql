-- Run after the tournament seat-exit authority migration. This is a read-only
-- structural, cutover-receipt, and ACL probe: it proves the exact historical
-- backlog recorded by the one-time cutover is still closed, every future live
-- tournament seat-exit door is guarded, generic cash paths refuse tournament
-- tables, and move replay is backed by one immutable owner-only receipt.
DO $probe$
DECLARE
  v_source text;
  v_count integer;
  v_signature text;
BEGIN
  IF to_regclass('public.tournament_seat_exit_authority_cutover') IS NULL
     OR to_regclass('public.tournament_seat_exit_authorizations') IS NULL
     OR to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regprocedure(
       'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])') IS NULL
     OR to_regprocedure(
       'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)') IS NULL
     OR to_regprocedure(
       'public.fn_tournament_live_seat_exit_requires_authority()') IS NULL
     OR to_regprocedure(
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_tournament_seat_move_receipt(uuid)') IS NULL THEN
    RAISE EXCEPTION 'FAIL tournament seat-exit authority is incomplete';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.tournament_seat_exit_authority_cutover c
   WHERE c.authority='tournament_seat_exit_authority:v1'
     AND c.migration_version='20260909014545'
     AND c.installed_at IS NOT NULL
     AND c.installed_at<=clock_timestamp()
     AND c.repaired_seat_count=cardinality(c.repaired_seat_ids)
     AND c.repaired_table_count=cardinality(c.repaired_table_ids)
     AND c.repaired_roster_count=cardinality(c.repaired_roster_ids)
     AND c.repaired_chip_count=cardinality(c.repaired_chip_roster_ids)
     AND c.repaired_stakes_count=cardinality(c.repaired_stakes_table_ids)
     AND c.closed_duplicate_table_count=
         cardinality(c.closed_duplicate_table_ids)
     AND c.repaired_player_count_count=
         cardinality(c.repaired_player_count_tournament_ids)
     AND array_position(c.repaired_seat_ids,NULL) IS NULL
     AND array_position(c.repaired_table_ids,NULL) IS NULL
     AND array_position(c.repaired_roster_ids,NULL) IS NULL
     AND array_position(c.repaired_chip_roster_ids,NULL) IS NULL
     AND array_position(c.repaired_stakes_table_ids,NULL) IS NULL
     AND array_position(c.closed_duplicate_table_ids,NULL) IS NULL
     AND array_position(c.repaired_player_count_tournament_ids,NULL) IS NULL;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'FAIL exact tournament seat-exit cutover receipt is missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_seat_ids) repaired(id)
      LEFT JOIN public.table_seats s ON s.id=repaired.id
     WHERE s.id IS NULL OR s.left_at IS NULL OR s.status<>'left')
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.repaired_table_ids) repaired(id)
     LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0)
     OR EXISTS (
    SELECT 1
      FROM public.tournament_seat_exit_authority_cutover c
      CROSS JOIN unnest(c.closed_duplicate_table_ids) repaired(id)
      LEFT JOIN public.tables tb ON tb.id=repaired.id
     WHERE tb.id IS NULL OR lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'FAIL cutover receipt no longer matches durable closed state';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger g
   WHERE g.tgrelid='public.table_seats'::regclass
     AND g.tgname='zy_tournament_live_seat_exit_requires_authority'
     AND g.tgfoid=
       'public.fn_tournament_live_seat_exit_requires_authority()'::regprocedure
     AND NOT g.tgisinternal AND g.tgenabled='O'
     AND g.tgtype=27;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'FAIL live tournament seat-exit trigger shape changed';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger g
   WHERE g.tgrelid='public.tournament_seat_move_receipts'::regclass
     AND g.tgname='tournament_seat_move_receipts_append_only'
     AND g.tgfoid=
       'public.fn_tournament_seat_move_receipts_append_only()'::regprocedure
     AND NOT g.tgisinternal AND g.tgenabled='O'
     AND g.tgtype=27;
  IF v_count<>1 THEN
    RAISE EXCEPTION 'FAIL tournament move receipt is not append-only';
  END IF;

  IF has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authority_cutover','DELETE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_exit_authorizations','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','SELECT')
     OR has_table_privilege(
       'authenticated','public.tournament_seat_exit_authorizations','INSERT')
     OR has_table_privilege(
       'authenticated','public.tournament_seat_move_receipts','INSERT')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_open_tournament_hand_seat_exit_authority(uuid,uuid,uuid[])',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role','public.fn_ca_tournament_seat_move_receipt(uuid)','EXECUTE')
     OR has_function_privilege(
       'anon',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL tournament seat-exit ACL boundary changed';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_tournament_live_seat_exit_requires_authority()'::regprocedure)
    INTO v_source;
  IF position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0
     OR position('app.tournament_seat_exit_token' IN v_source)=0
     OR position('tournament_seat_exit_authorizations' IN v_source)=0
     OR position('tournament_players' IN v_source)<>0
     OR position('OLD.stack=0' IN replace(v_source,' ',''))<>0 THEN
    RAISE EXCEPTION 'FAIL tournament seat-exit token proof changed';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure)
    INTO v_source;
  IF position('fn_ca_open_tournament_hand_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority' IN v_source)=0
     OR position('v_expected_vacated<>v_consumed' IN replace(v_source,' ',''))=0
     OR position('accepted_hand_bust' IN v_source)=0
     OR position('fn_emit_tournament_manager_wake' IN v_source)=0
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL accepted-hand seat capability boundary changed';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_emit_tournament_manager_wake(uuid,text)'::regprocedure)
    INTO v_source;
  IF position('accepted_hand_bust' IN v_source)=0
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='public.tournament_manager_wakes'::regclass
          AND c.conname='tournament_manager_wakes_reason_check'
          AND pg_get_constraintdef(c.oid) LIKE '%accepted_hand_bust%') THEN
    RAISE EXCEPTION 'FAIL accepted-hand bust has no durable manager wake rail';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid)'::regprocedure)
    INTO v_source;
  IF position('tournament_seat_move_receipts' IN v_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority' IN v_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_source)=0
     OR position('UPDATE public.tournament_players' IN v_source)=0
     OR position('UPDATE public.table_seats' IN v_source)=0 THEN
    RAISE EXCEPTION 'FAIL atomic tournament move lost a required commit member';
  END IF;

  FOREACH v_source IN ARRAY ARRAY[
    pg_get_functiondef(
      'public.atomic_seat_cashout_locked(uuid,uuid,integer,text)'::regprocedure),
    pg_get_functiondef(
      'public.fn_admin_kick_player(uuid,uuid,text)'::regprocedure),
    pg_get_functiondef(
      'public.fn_clear_table_seats(uuid,boolean)'::regprocedure),
    pg_get_functiondef(
      'public.force_close_table_and_refund(uuid,uuid,text)'::regprocedure),
    pg_get_functiondef(
      'public.player_leave_table(uuid,uuid)'::regprocedure)
  ] LOOP
    IF position('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY' IN v_source)=0
       OR position('tournament_id' IN v_source)=0 THEN
      RAISE EXCEPTION 'FAIL a generic seat-exit door no longer refuses tournaments';
    END IF;
  END LOOP;

  IF to_regprocedure('public.fn_clear_seats_on_game_end()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_spin_reap_stale_boards(integer,boolean,boolean,integer)')
       IS NOT NULL
     OR to_regprocedure(
       'public.fn_reconcile_tournament_denormals()') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_live_seat_chips(uuid)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_sync_tournament_chips(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_release_seats_on_tournament_finish()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid='public.tournaments'::regclass
          AND tg.tgname='trg_release_seats_on_tournament_finish'
          AND NOT tg.tgisinternal)
     OR EXISTS (
       SELECT 1 FROM cron.job
        WHERE jobname='reconcile-tournament-denormals'
           OR command LIKE '%fn_reconcile_tournament_denormals(%') THEN
    RAISE EXCEPTION 'FAIL delayed tournament seat reconcilers still exist';
  END IF;

  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
     AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'];
  IF v_source IS NULL
     OR v_source NOT LIKE '%stakes%trim_scale(v_sb)%trim_scale(v_bb)%'
     OR has_function_privilege(
       'service_role',
       'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL late seating still depends on a stakes reconciler';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid='public.fn_update_managed_game(text,uuid,jsonb)'::regprocedure
     AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'];
  IF v_source IS NULL
     OR v_source NOT LIKE '%stakes=trim_scale(v_sb)%trim_scale(v_bb)%'
     OR has_function_privilege(
       'authenticated','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_update_managed_game(text,uuid,jsonb)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL managed blind edits still depend on a reconciler';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
    'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'
  ] LOOP
    SELECT p.prosrc INTO v_source FROM pg_proc p
     WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef;
    IF v_source IS NULL
       OR v_source NOT LIKE '%fn_ca_open_tournament_seat_exit_authority%'
       OR v_source NOT LIKE '%fn_ca_close_tournament_seat_exit_authority%'
       OR v_source LIKE '%UPDATE public.table_seats%'
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL elimination wrapper or ACL changed: %',v_signature;
    END IF;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)',
    'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
    'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)',
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'
  ] LOOP
    SELECT p.prosrc INTO v_source FROM pg_proc p
     WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef;
    IF v_source IS NULL
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR has_function_privilege('service_role',v_signature,'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL private elimination owner changed: %',v_signature;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)'::regprocedure;
  IF v_source NOT LIKE '%fn_eliminate_player_legacy_candidate_20260907%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'FAIL ordinary elimination bridge changed owner';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_claim_tournament_bounty_elimination_pre_seat_guard(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;
  IF v_source NOT LIKE '%fn_claim_bounty_legacy_candidate_20260907%'
     OR v_source LIKE '%UPDATE public.table_seats%' THEN
    RAISE EXCEPTION 'FAIL bounty elimination bridge changed owner';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure;
  IF v_source NOT LIKE '%UPDATE public.table_seats%'
     OR v_source NOT LIKE '%left_at%' THEN
    RAISE EXCEPTION 'FAIL ordinary elimination direct owner changed';
  END IF;
  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid=
     'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure;
  IF v_source NOT LIKE '%UPDATE public.table_seats%'
     OR v_source NOT LIKE '%left_at%' THEN
    RAISE EXCEPTION 'FAIL bounty elimination direct owner changed';
  END IF;

  IF to_regprocedure(
       'public.atomic_tournament_unregister(uuid,uuid,numeric)') IS NOT NULL
     OR to_regprocedure(
       'public.fn_tournament_unregister_counter(uuid,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL amount-trusting legacy unregister still exists';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname=ANY(ARRAY[
         'atomic_seat_horse',
         'atomic_table_withdraw',
         'distribute_tournament_prizes'
       ])
  ) THEN
    RAISE EXCEPTION 'FAIL a retired wallet writer exists';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND (p.prosrc LIKE '%atomic_tournament_unregister%'
         OR p.prosrc LIKE '%fn_tournament_unregister_counter%'
         OR p.prosrc LIKE '%atomic_seat_horse%'
         OR p.prosrc LIKE '%atomic_table_withdraw%'
         OR p.prosrc LIKE '%distribute_tournament_prizes%')
  ) THEN
    RAISE EXCEPTION 'FAIL a persistent function body names a retired wallet writer';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_club_arena_global_wallet_check()',
    'public.fn_union_money_path_check()',
    'public.fn_union_overload_check()'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR has_function_privilege('anon',v_signature,'EXECUTE')
       OR has_function_privilege('authenticated',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature)
            AND p.prosecdef
            AND p.proconfig @> ARRAY['search_path=public']
       ) THEN
      RAISE EXCEPTION 'FAIL diagnostic ACL or definer changed: %',v_signature;
    END IF;
  END LOOP;

  SELECT p.prosrc INTO v_source FROM pg_proc p
   WHERE p.oid='public.guard_wallet_balance_write()'::regprocedure
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public']
     AND NOT has_function_privilege(
       'anon','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'authenticated','public.guard_wallet_balance_write()','EXECUTE')
     AND NOT has_function_privilege(
       'service_role','public.guard_wallet_balance_write()','EXECUTE');
  IF v_source IS NULL
     OR v_source LIKE '%atomic_tournament_unregister%' THEN
    RAISE EXCEPTION 'FAIL wallet balance guard retained legacy authority';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_unregister_from_tournament(uuid)',
    'public.fn_unregister_from_tournament(uuid,uuid)',
    'public.fn_leave_seat_and_refund(uuid)',
    'public.fn_leave_seat_and_refund(uuid,uuid)',
    'public.fn_admin_remove_tournament_player(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL
       OR NOT has_function_privilege('service_role',v_signature,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid=to_regprocedure(v_signature) AND p.prosecdef
       ) THEN
      RAISE EXCEPTION 'FAIL supported tournament exit RPC changed: %',v_signature;
    END IF;
  END LOOP;

  IF has_function_privilege(
       'service_role',
       'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.atomic_cancel_tournament(uuid,uuid)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_players','DELETE') THEN
    RAISE EXCEPTION 'FAIL tournament roster exit ACL has a bypass';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players';
  IF v_count<>1 OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid=
       'public.fn_ca_unregister_tournament_player_exact_pre_seat_guard(uuid,uuid,uuid,text,uuid)'::regprocedure
       AND p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+(public\.)?tournament_players'
  ) THEN
    RAISE EXCEPTION 'FAIL a second direct tournament roster delete owner exists';
  END IF;

  RAISE EXCEPTION 'PASS tournament seat-exit authority is exact';
END;
$probe$;
