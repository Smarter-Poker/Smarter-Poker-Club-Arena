-- UNQUALIFIED disposable-only worker proof; not a migration or source patch.
-- Install prospective capture/ranking/payout/config before synthetic new clubs;
-- then commit exact authorizer + concurrency companion in the disposable DB.
-- This fixture owns rollback, never deletes settled records or changes cron.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $guard$
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
    OR (SELECT count(*) FROM auth.users)<>5
    OR EXISTS(SELECT 1 FROM auth.users WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
    OR (SELECT count(*) FROM public.clubs)<>3
    OR EXISTS(SELECT 1 FROM public.leaderboard_basis_existing_clubs)
    OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
    OR EXISTS(SELECT 1 FROM public.leaderboard_capture_counters)
    OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts)
    OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches)
    OR EXISTS(SELECT 1 FROM public.leaderboard_payout_failures)
    OR (SELECT count(*) FROM public.player_stats_snapshots)<>6
    OR (SELECT promo_balance FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 20
    OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_settle_due_leaderboards()')
      AND md5(p.prosrc)='8f2b1c2ff47e45431be6fee4639f9cb8'
      AND md5(pg_get_functiondef(p.oid))='d0d452a2d2c96400743972370d0f6ece'
      AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'Exact fresh disposable worker fixture required';
  END IF;
END $guard$;
CREATE FUNCTION pg_temp.worker_money_digest() RETURNS text LANGUAGE sql AS $fn$
  SELECT md5(jsonb_build_object(
    'clubs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.clubs t),
    'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,user_id) FROM public.club_members t),
    'union',(SELECT jsonb_agg(to_jsonb(t) ORDER BY union_id) FROM public.union_wallets t),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.chip_ledger t),
    'keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM public.wallet_credit_idempotency t),
    'batches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payout_batches t),
    'payouts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.leaderboard_payouts t),
    'basis',(SELECT jsonb_agg(to_jsonb(t) ORDER BY club_id,period,period_start) FROM public.leaderboard_round_basis_receipts t)
  )::text)
$fn$;
DO $worker$
DECLARE result jsonb; before_digest text; paid_digest text; starts date; ends date;
BEGIN
  SELECT start_date,end_date INTO starts,ends FROM public.fn_leaderboard_period_window('weekly',-1);
  before_digest:=pg_temp.worker_money_digest();
  PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  result:=public.fn_settle_due_leaderboards();
  RESET ROLE;
  IF result->'success' IS DISTINCT FROM 'false'::jsonb
    OR result->'settled' IS DISTINCT FROM '0'::jsonb OR result->'failed' IS DISTINCT FROM '2'::jsonb
    OR pg_temp.worker_money_digest() IS DISTINCT FROM before_digest
    OR (SELECT count(*) FROM public.leaderboard_payout_failures WHERE error_code='settlement_error'
      AND error_message='LEADERBOARD_CAPTURE_UNAVAILABLE' AND attempt_count=1 AND resolved_at IS NULL)<>2 THEN
    RAISE EXCEPTION 'Actual worker missing capture refusal was not atomic and typed';
  END IF;
  SET LOCAL ROLE service_role;
  result:=public.fn_settle_due_leaderboards();
  RESET ROLE;
  IF result->'failed' IS DISTINCT FROM '2'::jsonb OR result->'settled' IS DISTINCT FROM '0'::jsonb
    OR pg_temp.worker_money_digest() IS DISTINCT FROM before_digest
    OR (SELECT count(*) FROM public.leaderboard_payout_failures WHERE attempt_count=2 AND resolved_at IS NULL)<>2 THEN
    RAISE EXCEPTION 'Same unpaid boundary retry moved funds or lost attempts';
  END IF;
  BEGIN
    -- Deliberately inconsistent transient capture metadata; zero financial
    -- rows/history touched. The entire fault is rolled back before valid input.
    INSERT INTO public.leaderboard_complete_captures
      (capture_date,captured_at,capture_timezone,origin,source_contract,row_count,counter_hash,complete)
    SELECT d,(d+time '00:05') AT TIME ZONE 'UTC','UTC','fn_snapshot_player_stats',
      'applied_player_stats_v1',0,md5('deliberately invalid synthetic checksum'),true
    FROM (VALUES(starts-7),(starts),(ends)) dates(d);
    SET LOCAL ROLE service_role;
    result:=public.fn_settle_due_leaderboards();
    RESET ROLE;
    IF result->'failed' IS DISTINCT FROM '2'::jsonb OR result->'settled' IS DISTINCT FROM '0'::jsonb
      OR pg_temp.worker_money_digest() IS DISTINCT FROM before_digest
      OR (SELECT count(*) FROM public.leaderboard_payout_failures WHERE error_message='LEADERBOARD_CAPTURE_INVALID'
        AND error_code='settlement_error' AND attempt_count=3 AND resolved_at IS NULL)<>2 THEN
      RAISE EXCEPTION 'Actual worker invalid capture refusal was not atomic and typed';
    END IF;
    RAISE EXCEPTION USING ERRCODE='Q0001',MESSAGE='Synthetic invalid capture case rollback';
  EXCEPTION WHEN SQLSTATE 'Q0001' THEN NULL;
  END;
  -- Synthetic historical complete captures are not historical producer proof.
  INSERT INTO public.leaderboard_complete_captures
    (capture_date,captured_at,capture_timezone,origin,source_contract,row_count,counter_hash,complete)
  SELECT s.snapshot_date,(s.snapshot_date+time '00:05') AT TIME ZONE 'UTC',
    'UTC','fn_snapshot_player_stats','applied_player_stats_v1',count(*),
    md5(string_agg((jsonb_build_object('user_id',s.user_id,'club_id',s.club_id,
      'hands_played',s.hands_played,'hands_dealt',s.hands_dealt,'sum_big_blind',s.sum_big_blind,
      'total_winnings',s.total_winnings,'total_losses',s.total_losses,'total_rake',s.total_rake,
      'tournaments_played',s.tournaments_played,'tournaments_won',s.tournaments_won))::text,
      E'\n' ORDER BY s.club_id,s.user_id)),true
  FROM public.player_stats_snapshots s GROUP BY s.snapshot_date;
  INSERT INTO public.leaderboard_capture_counters
  SELECT snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,total_winnings,
    total_losses,total_rake,tournaments_played,tournaments_won FROM public.player_stats_snapshots;
  SET LOCAL ROLE service_role;
  result:=public.fn_settle_due_leaderboards();
  RESET ROLE;
  IF result->'success' IS DISTINCT FROM 'true'::jsonb OR result->'settled' IS DISTINCT FROM '2'::jsonb
    OR result->'failed' IS DISTINCT FROM '0'::jsonb
    OR (SELECT count(*) FROM public.leaderboard_payout_batches)<>2
    OR (SELECT sum(total_paid) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 20
    OR (SELECT sum(promo_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 20
    OR (SELECT sum(seed_funded+overlay_funded) FROM public.leaderboard_payout_batches) IS DISTINCT FROM 0
    OR (SELECT count(*) FROM public.leaderboard_round_basis_receipts WHERE basis_version='complete_capture_v2')<>2
    OR (SELECT sum(chip_balance) FROM public.club_members) IS DISTINCT FROM 20
    OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND to_type='leaderboard_round') IS DISTINCT FROM 20
    OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='leaderboard_payout' AND from_type='leaderboard_round') IS DISTINCT FROM 20
    OR (SELECT count(*) FROM public.wallet_credit_idempotency WHERE key LIKE 'leaderboard:%')<>2
    OR (SELECT promo_balance FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 0
    OR (SELECT chip_treasury FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 99980
    OR EXISTS(SELECT 1 FROM public.leaderboard_payout_failures WHERE resolved_at IS NULL) THEN
    RAISE EXCEPTION 'Actual worker complete capture two-round reconciliation failed';
  END IF;
  paid_digest:=pg_temp.worker_money_digest();
  SET LOCAL ROLE service_role;
  result:=public.fn_settle_due_leaderboards();
  RESET ROLE;
  IF result->'success' IS DISTINCT FROM 'true'::jsonb OR result->'settled' IS DISTINCT FROM '0'::jsonb
    OR result->'failed' IS DISTINCT FROM '0'::jsonb OR pg_temp.worker_money_digest() IS DISTINCT FROM paid_digest THEN
    RAISE EXCEPTION 'Worker paid-round replay changed frozen receipts or funds';
  END IF;
END $worker$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
