-- DRAFT companion: appended to the guarded authorization transaction BEFORE
-- its explicit isolated-only COMMIT. Never execute standalone or on source.
DO $guard$
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap'
     OR current_user<>'leaderboard_qualification_bootstrap'
     OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
     OR (SELECT count(*) FROM auth.users)<>5
     OR EXISTS(SELECT 1 FROM auth.users WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
     OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches)
     OR EXISTS(SELECT 1 FROM public.player_stats_snapshots) THEN
    RAISE EXCEPTION 'Isolated concurrency companion preimage required';
  END IF;
END;
$guard$;
DO $prepare$
DECLARE result jsonb; starts date; earlier date; ends date; monthly_next date; terms jsonb;
  membership_preimage jsonb; expected_joined timestamptz; changed integer;
  club constant uuid:='92000000-0000-4000-8000-000000000002';
  owner constant uuid:='90000000-0000-4000-8000-000000000002';
  program constant uuid:='94000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000005',true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  result:=public.fn_join_club(club);
  IF result->>'role' IS DISTINCT FROM 'player' OR COALESCE(result->>'status','') NOT IN ('active','approved')
     OR (result->>'chip_balance')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Synthetic second-recipient join failed';
  END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',owner::text,true);
  result:=public.fn_diamond_game_fund_promo(club,20,'leaderboard_isolated_concurrency_fund');
  IF (result->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Synthetic concurrency Promo funding failed';
  END IF;
  RESET ROLE;
  SELECT start_date,end_date INTO starts,ends FROM public.fn_leaderboard_period_window('weekly',-1);
  earlier:=starts-7;
  -- Only synthetic history is adjusted, after real club creation. Its creation
  -- predates both tested rounds, making baseline/worker eligibility credible.
  UPDATE public.clubs SET created_at=(earlier-1)::timestamp AT TIME ZONE 'UTC'
  WHERE id=club;
  IF (SELECT created_at FROM public.clubs WHERE id=club)
      IS DISTINCT FROM (earlier-1)::timestamp AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'Synthetic historical club creation boundary unavailable';
  END IF;
  -- Both established recipients actually joined in this fresh transaction.
  -- Adjust only their synthetic chronology, not balances or membership data;
  -- old membership alone would not establish any prior playing activity.
  IF (SELECT count(*) FROM public.club_members
      WHERE club_id=club AND user_id IN (
        '90000000-0000-4000-8000-000000000004'::uuid,
        '90000000-0000-4000-8000-000000000005'::uuid)
        AND joined_at >= transaction_timestamp() AND joined_at <= clock_timestamp()
        AND role::text='player' AND status::text IN ('active','approved')
        AND chip_balance=0) <> 2 THEN
    RAISE EXCEPTION 'Historical membership preparation requires exact fresh real joins';
  END IF;
  SELECT jsonb_agg(to_jsonb(m)-'joined_at' ORDER BY m.user_id)
    INTO membership_preimage FROM public.club_members m
    WHERE m.club_id=club AND m.user_id IN (
      '90000000-0000-4000-8000-000000000004'::uuid,
      '90000000-0000-4000-8000-000000000005'::uuid);
  expected_joined := (earlier-1)::timestamp AT TIME ZONE 'UTC';
  UPDATE public.club_members SET joined_at=expected_joined
    WHERE club_id=club AND user_id IN (
      '90000000-0000-4000-8000-000000000004'::uuid,
      '90000000-0000-4000-8000-000000000005'::uuid);
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>2 OR (SELECT count(*) FROM public.club_members
       WHERE club_id=club AND user_id IN (
         '90000000-0000-4000-8000-000000000004'::uuid,
         '90000000-0000-4000-8000-000000000005'::uuid)
         AND joined_at=expected_joined AND joined_at < (earlier::timestamp AT TIME ZONE 'UTC'))<>2
     OR (SELECT jsonb_agg(to_jsonb(m)-'joined_at' ORDER BY m.user_id)
         FROM public.club_members m WHERE m.club_id=club AND m.user_id IN (
           '90000000-0000-4000-8000-000000000004'::uuid,
           '90000000-0000-4000-8000-000000000005'::uuid))
       IS DISTINCT FROM membership_preimage THEN
    RAISE EXCEPTION 'Historical membership chronology changed non-chronology fixture data';
  END IF;
  SELECT end_date INTO monthly_next FROM public.fn_leaderboard_period_window('monthly',0);
  terms:=jsonb_build_object('club_id',club,'version',2,'rewards_enabled',true,
    'payout_metric','profit','weekly_prizes','[{"rank":1,"amount":10}]'::jsonb,
    'monthly_prizes','[]'::jsonb,'funding_owner_type','club','funding_union_id',NULL,
    'weekly_effective_from',earlier,'monthly_effective_from',monthly_next);
  -- Historical synthetic configuration, NOT proof public RPC permits backdating.
  INSERT INTO public.leaderboard_reward_program_versions(id,club_id,version,operation_id,
    rewards_enabled,payout_metric,weekly_prizes,monthly_prizes,suggestion_key,
    funding_owner_type,funding_union_id,weekly_effective_from,monthly_effective_from,
    published_by,program_hash,overlay_enabled)
  VALUES(program,club,2,'94000000-0000-4000-8000-000000000002',true,'profit',
    '[{"rank":1,"amount":10}]','[]','custom','club',NULL,earlier,monthly_next,owner,md5(terms::text),false);
  IF public.fn_get_leaderboard_reward_plan(club,'weekly',starts)->>'program_id'
      IS DISTINCT FROM program::text THEN
    RAISE EXCEPTION 'Synthetic closed-period plan selection failed';
  END IF;
  INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,
    hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,total_rake,
    tournaments_played,tournaments_won)
  VALUES('90000000-0000-4000-8000-000000000004',club,earlier,0,0,0,0,0,0,0,0),
    ('90000000-0000-4000-8000-000000000005',club,earlier,0,0,0,0,0,0,0,0),
    ('90000000-0000-4000-8000-000000000004',club,starts,20,20,40,100,0,0,0,0),
    ('90000000-0000-4000-8000-000000000005',club,starts,20,20,40,50,0,0,0,0),
    ('90000000-0000-4000-8000-000000000004',club,ends,40,40,80,200,0,0,0,0),
    ('90000000-0000-4000-8000-000000000005',club,ends,40,40,80,100,0,0,0,0);
END;
$prepare$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
