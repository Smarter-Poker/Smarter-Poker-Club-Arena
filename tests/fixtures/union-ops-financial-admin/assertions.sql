DO $fixture$
DECLARE
  u constant uuid := 'fade0000-0000-0000-0000-000000000001';
  c1 constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  c2 constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  outsider_club constant uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  extra_union constant uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  admin constant uuid := '90000000-0000-4000-8000-000000000001';
  other_admin constant uuid := '90000000-0000-4000-8000-000000000002';
  union_admin_user constant uuid := '90000000-0000-4000-8000-000000000003';
  house_owner constant uuid := '90000000-0000-4000-8000-000000000004';
  house_admin constant uuid := '90000000-0000-4000-8000-000000000005';
  ordinary_member constant uuid := '90000000-0000-4000-8000-000000000006';
  multi_overseer constant uuid := '90000000-0000-4000-8000-000000000007';
  a1 constant uuid := 'd0000000-0000-4000-8000-000000000001';
  a2 constant uuid := 'e0000000-0000-4000-8000-000000000002';
  a3 constant uuid := 'f0000000-0000-4000-8000-000000000003';
  p1 constant uuid := '10000000-0000-4000-8000-000000000001';
  p2 constant uuid := '10000000-0000-4000-8000-000000000002';
  p3 constant uuid := '10000000-0000-4000-8000-000000000003';
  p4 constant uuid := '10000000-0000-4000-8000-000000000004';
  p5 constant uuid := '10000000-0000-4000-8000-000000000005';
  tournament_rake constant uuid := '70000000-0000-4000-8000-000000000001';
  tournament_cancel constant uuid := '70000000-0000-4000-8000-000000000002';
  house_hand constant uuid := '70000000-0000-4000-8000-000000000003';
  cash_record constant uuid := '70000000-0000-4000-8000-000000000004';
  cash_hand constant uuid := '80000000-0000-4000-8000-000000000004';
  house_cash_hand constant uuid := '80000000-0000-4000-8000-000000000005';
  p5_record constant uuid := '70000000-0000-4000-8000-000000000006';
  p5_hand constant uuid := '80000000-0000-4000-8000-000000000006';
  gap_record constant uuid := '70000000-0000-4000-8000-000000000007';
  gap_hand constant uuid := '80000000-0000-4000-8000-000000000007';
  missing_gap_record constant uuid := '70000000-0000-4000-8000-000000000008';
  missing_gap_hand constant uuid := '80000000-0000-4000-8000-000000000008';
  since_at constant timestamptz := '2026-09-28 12:30:00+00';
  r record;
  d jsonb;
  direct_rake numeric;
  direct_comm numeric;
  plan json;
  fn_src text;
  s jsonb;
  started timestamptz;
BEGIN
  INSERT INTO public.unions(id,name,owner_id) VALUES
    (u,'Midway Union',admin),
    (extra_union,'alpha union',multi_overseer),
    (outsider_club,'Outside Union',other_admin);
  INSERT INTO public.clubs(id,name,union_id,owner_id,is_union) VALUES
    (u,'Midway Union',u,house_owner,true),
    (c1,'Club One',NULL,NULL,false),
    (c2,'Club Two',u,NULL,false),
    (outsider_club,'Outside Club',NULL,NULL,false);
  -- The two membership stores deliberately disagree. Risk follows the
  -- canonical union_clubs roster plus the house; distribution preserves its
  -- accounting scope of clubs.union_id plus the house.
  INSERT INTO public.union_clubs(union_id,club_id) VALUES (u,c1);
  INSERT INTO public.union_admins(union_id,user_id) VALUES
    (u,union_admin_user),(u,multi_overseer);
  INSERT INTO public.profiles(id,username,display_name,alias) VALUES
    (a1,'agent_one','Agent One Real','Agent One'),
    (a2,'agent_two','Agent Two Real','Agent Two');
  INSERT INTO public.agents(user_id,club_id,role) VALUES
    (a1,c1,'agent'),(a2,c1,'agent'),(a3,c1,'agent'),
    (a2,c2,'super_agent'),(a1,u,'agent');
  INSERT INTO public.club_members(club_id,user_id,agent_id,credit_used,joined_at) VALUES
    (c1,p1,a1,10,'2026-02-01 00:00:00+00'),
    -- The house membership is older, but real union_clubs membership must
    -- still win the inherited canonical attribution rule.
    (u,p1,a1,0,'2026-01-01 00:00:00+00'),
    (c1,p2,a1,5,'2026-01-02 00:00:00+00'),
    -- This second agent receives one exact share of a positive hand-backed
    -- unsealed gap record. The JSON and rake-attribution allocations below
    -- are deliberately identical so the successor path proves player/agent
    -- parity rather than merely preserving the club-wide total.
    (c1,p4,a2,0,'2026-01-02 12:00:00+00'),
    (c2,p3,a2,7,'2026-01-03 00:00:00+00'),
    (u,p5,a1,2,'2026-01-04 00:00:00+00'),
    (outsider_club,p4,a1,500,'2026-01-05 00:00:00+00');
  INSERT INTO public.club_members(club_id,user_id,role,status) VALUES
    (c1,a1,'agent','active'),
    (u,house_admin,'admin','active'),
    (c1,ordinary_member,'member','active');
  UPDATE public.club_members SET chip_balance=0.50
   WHERE club_id=c1 AND user_id=a1;
  UPDATE public.clubs SET chip_treasury=1.00 WHERE id=c1;
  INSERT INTO public.union_wallets(union_id,rake_wallet) VALUES (u,9.00);
  INSERT INTO public.union_rakeback_log(union_id,period_start,period_end)
  VALUES (u,since_at,since_at + interval '7 days');
  INSERT INTO public.table_seats(user_id,club_id,left_at) VALUES
    (p1,c1,NULL),(p2,outsider_club,NULL);
  INSERT INTO public.rake_attributions(
    hand_id,rake_record_id,player_id,club_id,rake_amount,created_at) VALUES
    (cash_hand,cash_record,p1,c1,2.60,since_at + interval '1 hour'),
    (cash_hand,cash_record,p2,c1,1.40,since_at + interval '1 hour'),
    (gen_random_uuid(),gen_random_uuid(),p3,c2,4.50,since_at + interval '3 hours'),
    (p5_hand,p5_record,p5,u,0.50,since_at + interval '4 hours'),
    (house_cash_hand,house_hand,p2,c1,1.00,since_at + interval '3 hours'),
    (gen_random_uuid(),gen_random_uuid(),p1,outsider_club,100,since_at + interval '4 hours');
  INSERT INTO public.rake_attributions(
    hand_id,rake_record_id,player_id,club_id,rake_amount,
    eligible_contribution,created_at) VALUES
    (gap_hand,gap_record,p1,c1,4.50,3,'2026-09-29 06:30:00+00'),
    (gap_hand,gap_record,p4,c1,1.50,1,'2026-09-29 06:30:00+00');
  INSERT INTO public.chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,status,created_at) VALUES
    (c1,'player_wallet',p1,'table_stack',gen_random_uuid(),20,'posted',since_at + interval '1 hour'),
    (c1,'table_stack',gen_random_uuid(),'player_wallet',p1,30,'posted',since_at + interval '2 hours'),
    (c1,'player_wallet',p2,'table_stack',gen_random_uuid(),12,'posted',since_at + interval '1 hour'),
    (c1,'table_stack',gen_random_uuid(),'player_wallet',p2,5,'posted',since_at + interval '2 hours'),
    (c2,'player_wallet',p3,'table_stack',gen_random_uuid(),8,'posted',since_at + interval '1 hour'),
    (c2,'table_stack',gen_random_uuid(),'player_wallet',p3,8,'posted',since_at + interval '2 hours'),
    (u,'player_wallet',p5,'table_stack',gen_random_uuid(),2,'posted',since_at + interval '1 hour'),
    (u,'table_stack',gen_random_uuid(),'player_wallet',p5,3,'posted',since_at + interval '2 hours'),
    (outsider_club,'table_stack',gen_random_uuid(),'player_wallet',p1,100,'posted',since_at + interval '2 hours');
  INSERT INTO public.agent_commissions(user_id,club_id,amount,created_at) VALUES
    (a1,c1,2.50,since_at + interval '1 hour'),
    (a1,c1,1.50,since_at + interval '3 days'),
    (a2,c1,77.00,since_at + interval '4 days'),
    (a1,c1,0.25,'2026-10-10 01:00:00+00'),
    (a2,c2,1.00,since_at + interval '1 hour'),
    (a2,c2,0.50,'2026-10-10 01:00:00+00'),
    -- The preimage counts only positive agent-pair totals in its headline,
    -- but its independent club-shortage scan includes every signed amount.
    -- Keeping this negative pair proves both views survive scan unification.
    (a3,c1,-1.00,since_at + interval '3 days'),
    (a1,u,1.00,since_at + interval '1 hour'),
    (a2,c2,99.00,since_at - interval '1 hour'),
    (a1,outsider_club,100,since_at + interval '1 hour');
  -- One partial paid period leaves a1's later 1.50 open; a2's full-period
  -- settlement makes all 77.00 disappear without a per-row predicate call.
  INSERT INTO public.agent_commission_settlements(
    club_id,user_id,union_id,period_start,period_end,amount,rows_count)
  VALUES
    (c1,a1,u,since_at,since_at + interval '2 hours',2.50,1),
    (c1,a2,u,since_at,since_at + interval '7 days',77.00,1);
  INSERT INTO public.rake_records(club_id,rake_amount,is_tournament,created_at) VALUES
    -- A sealed prior UTC day contains both a tournament fee and its signed
    -- reversal. The distribution law must retain both, not read cash display
    -- facts or a positive-only partial index.
    (c2,7,true,'2026-09-29 01:00:00+00'),
    (c2,-2,true,'2026-09-29 02:00:00+00'),
    (c2,2,false,'2026-09-29 03:00:00+00'),
    (u,0.5,false,'2026-09-29 04:00:00+00'),
    (c1,50,false,'2026-09-29 05:00:00+00'),
    (c2,99,true,since_at - interval '1 hour'),
    (c2,1,true,'2026-10-10 01:00:00+00'),
    (outsider_club,100,false,'2026-09-29 06:00:00+00');
  -- Risk keeps the preimage's signed player allocation. Production
  -- rake_attributions rejects negatives, so cancellation/reversal evidence
  -- must remain on signed rake_records and retain its contribution map.
  INSERT INTO public.rake_records(
    id,hand_id,club_id,rake_amount,player_contributions,is_tournament,created_at) VALUES
    (cash_record,cash_hand,c1,4,jsonb_build_object(p1::text,3.25,p2::text,1.75),false,since_at + interval '1 hour'),
    (gen_random_uuid(),cash_hand,c1,-1,jsonb_build_object(p1::text,1),false,since_at + interval '4 hours'),
    (gen_random_uuid(),cash_hand,c1,-0.5,jsonb_build_object(p1::text,1),false,'2026-10-10 01:00:00+00'),
    (p5_record,p5_hand,u,0.5,jsonb_build_object(p5::text,1),false,since_at + interval '4 hours'),
    (gap_record,gap_hand,c1,6,jsonb_build_object(p1::text,3,p4::text,1),false,
     '2026-09-29 06:30:00+00'),
    -- A hand-backed row without rake_attributions must retain the historical
    -- JSON allocation instead of disappearing from the report.
    (missing_gap_record,missing_gap_hand,c1,2,jsonb_build_object(p2::text,1),false,
     '2026-09-29 06:45:00+00'),
    (gen_random_uuid(),gen_random_uuid(),outsider_club,100,jsonb_build_object(p1::text,1),false,since_at + interval '4 hours');
  -- Production cancellations retain the original contribution map and link
  -- the signed reversal to the positive tournament rake row. This pair nets
  -- to zero; a separate house-hosted hand proves its player credits c1 once.
  INSERT INTO public.rake_records(
    id,hand_id,club_id,rake_amount,player_contributions,is_tournament,source,metadata,created_at) VALUES
    (tournament_rake,NULL,u,2,jsonb_build_object(p1::text,1,p2::text,1),true,
     'fn_spin_book_entry','{}'::jsonb,since_at + interval '1 hour'),
    (tournament_cancel,NULL,u,-2,jsonb_build_object(p1::text,1,p2::text,1),true,
     'atomic_cancel_tournament',
     jsonb_build_object(
       'kind','spin_rake_refund',
       'original_source','fn_spin_book_entry',
       'original_rake_record_id',tournament_rake::text),
     since_at + interval '2 hours'),
    (house_hand,house_cash_hand,u,1,jsonb_build_object(p2::text,1),false,
     'cash_hand','{}'::jsonb,since_at + interval '3 hours');
  INSERT INTO public.rakeback_periods(user_id,club_id,rakeback_amount,period_start,status) VALUES
    (p1,c1,2,since_at::date,'pending'),
    (p2,c1,1,since_at::date,'pending'),
    (p3,c2,1,since_at::date,'pending'),
    (p4,outsider_club,50,since_at::date,'pending');

  IF NOT EXISTS (
    SELECT 1
      FROM public.rake_records positive
      JOIN public.rake_records cancellation
        ON cancellation.metadata->>'original_rake_record_id' = positive.id::text
     WHERE positive.id = tournament_rake
       AND cancellation.id = tournament_cancel
       AND positive.source = 'fn_spin_book_entry'
       AND cancellation.source = 'atomic_cancel_tournament'
       AND cancellation.metadata->>'kind' = 'spin_rake_refund'
       AND cancellation.metadata->>'original_source' = 'fn_spin_book_entry'
       AND cancellation.player_contributions = positive.player_contributions
       AND cancellation.rake_amount = -positive.rake_amount
  ) THEN
    RAISE EXCEPTION 'tournament cancellation fixture does not match production signed linkage';
  END IF;

  -- Large unrelated evidence must not enter the union arithmetic or determine
  -- its latency. The candidate's club-first indexes skip these rows.
  INSERT INTO public.agent_commissions(user_id,club_id,amount,created_at)
  SELECT p4, outsider_club, 1, since_at + interval '1 hour'
    FROM generate_series(1,50000);
  INSERT INTO public.rake_records(club_id,rake_amount,created_at)
  SELECT outsider_club, 1, since_at + interval '1 hour'
    FROM generate_series(1,50000);
  INSERT INTO public.rake_records(club_id,rake_amount,is_tournament,created_at)
  SELECT c2, CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END, (g % 3 = 0),
         '2026-09-29 05:00:00+00'::timestamptz
    FROM generate_series(1,20000) g;
  ANALYZE public.agent_commissions;
  ANALYZE public.rake_records;

  IF has_function_privilege('anon', 'public.fn_union_overseer_options()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_union_overseer_options()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_union_overseer_options()', 'EXECUTE') THEN
    RAISE EXCEPTION 'overseer option reader grants are not least privilege';
  END IF;
  IF (SELECT p.proacl::text
        FROM pg_proc p
       WHERE p.oid =
         'public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure)
       IS DISTINCT FROM
         '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     OR (SELECT p.proacl::text
           FROM pg_proc p
          WHERE p.oid =
            'public.fn_union_settlement_preview(uuid,timestamptz,timestamptz)'::regprocedure)
       IS DISTINCT FROM
         '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     OR (SELECT p.proacl::text
           FROM pg_proc p
          WHERE p.oid =
            'public.fn_union_distribution_check(uuid,timestamptz)'::regprocedure)
       IS DISTINCT FROM
         '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' THEN
    RAISE EXCEPTION 'rewritten Union Ops reader grants are not least privilege';
  END IF;

  PERFORM set_config('app.engine','off',false);
  PERFORM set_config('app.user_id',admin::text,false);
  IF (SELECT array_agg(o.union_id) FROM public.fn_union_overseer_options() o)
       IS DISTINCT FROM ARRAY[u]::uuid[] THEN
    RAISE EXCEPTION 'union owner was not restricted to their exact union';
  END IF;
  PERFORM set_config('app.user_id',multi_overseer::text,false);
  IF (SELECT array_agg(o.union_id) FROM public.fn_union_overseer_options() o)
       IS DISTINCT FROM ARRAY[extra_union,u]::uuid[]
     OR (SELECT array_agg(o.union_name) FROM public.fn_union_overseer_options() o)
       IS DISTINCT FROM ARRAY['alpha union','Midway Union']::text[] THEN
    RAISE EXCEPTION 'multi-union options lost deterministic authorized shape/order';
  END IF;
  PERFORM set_config('app.user_id',union_admin_user::text,false);
  IF (SELECT array_agg(o.union_id) FROM public.fn_union_overseer_options() o)
       IS DISTINCT FROM ARRAY[u]::uuid[] THEN
    RAISE EXCEPTION 'union admin was not offered their exact union';
  END IF;
  PERFORM set_config('app.user_id',house_owner::text,false);
  IF (SELECT array_agg(o.union_id) FROM public.fn_union_overseer_options() o)
       IS DISTINCT FROM ARRAY[u]::uuid[] THEN
    RAISE EXCEPTION 'house-club owner was not offered their exact union';
  END IF;
  PERFORM set_config('app.user_id',house_admin::text,false);
  IF (SELECT array_agg(o.union_id) FROM public.fn_union_overseer_options() o)
       IS DISTINCT FROM ARRAY[u]::uuid[] THEN
    RAISE EXCEPTION 'house-club admin was not offered their exact union';
  END IF;
  PERFORM set_config('app.user_id',ordinary_member::text,false);
  IF EXISTS (SELECT 1 FROM public.fn_union_overseer_options()) THEN
    RAISE EXCEPTION 'ordinary club member was offered union operations';
  END IF;
  PERFORM set_config('app.user_id',other_admin::text,false);
  IF (SELECT array_agg(o.union_id) FROM public.fn_union_overseer_options() o)
       IS DISTINCT FROM ARRAY[outsider_club]::uuid[] THEN
    RAISE EXCEPTION 'cross-union actor saw another union option';
  END IF;
  PERFORM set_config('app.user_id','',false);
  IF EXISTS (SELECT 1 FROM public.fn_union_overseer_options()) THEN
    RAISE EXCEPTION 'anonymous caller received union options';
  END IF;

  PERFORM set_config('app.engine','on',false);
  started := clock_timestamp();
  SELECT * INTO r FROM public.fn_union_agent_risk_report(u,since_at)
   WHERE agent_user_id=a1 AND club_name='Club One';
  IF r.players IS DISTINCT FROM 2 OR r.seated_now IS DISTINCT FROM 1
     OR r.rake_generated IS DISTINCT FROM 10.00 OR r.player_net IS DISTINCT FROM 3.00
     OR r.commission_accrued IS DISTINCT FROM 4.25 OR r.credit_extended IS DISTINCT FROM 15.00 THEN
    RAISE EXCEPTION 'risk report changed exact Club One accounting: %', to_jsonb(r);
  END IF;
  SELECT * INTO r FROM public.fn_union_agent_risk_report(u,since_at)
   WHERE agent_user_id=a2 AND club_name='Club One';
  IF r.players IS DISTINCT FROM 1 OR r.seated_now IS DISTINCT FROM 0
     OR r.rake_generated IS DISTINCT FROM 1.50 OR r.player_net IS DISTINCT FROM 0.00
     OR r.commission_accrued IS DISTINCT FROM 77.00 OR r.credit_extended IS DISTINCT FROM 0.00 THEN
    RAISE EXCEPTION 'risk report changed gap-hand eligible allocation: %', to_jsonb(r);
  END IF;
  SELECT * INTO r FROM public.fn_union_agent_risk_report(u,since_at)
   WHERE agent_user_id=a1 AND club_name='Midway Union';
  IF r.players IS DISTINCT FROM 2 OR r.seated_now IS DISTINCT FROM 0
     OR r.rake_generated IS DISTINCT FROM 0.50 OR r.player_net IS DISTINCT FROM 1.00
     OR r.commission_accrued IS DISTINCT FROM 1.00 OR r.credit_extended IS DISTINCT FROM 2.00 THEN
    RAISE EXCEPTION 'risk report changed exact house-club accounting: %', to_jsonb(r);
  END IF;
  IF (SELECT count(*) FROM public.fn_union_agent_risk_report(u,since_at)) <> 3 THEN
    RAISE EXCEPTION 'risk report lost canonical/house membership or admitted mirror-only/outsider rows';
  END IF;
  IF (SELECT SUM(x.rake_generated) FROM public.fn_union_agent_risk_report(u,since_at) x)
       IS DISTINCT FROM 12.00 THEN
    RAISE EXCEPTION 'house-hosted multi-membership rake was lost or duplicated';
  END IF;
  EXECUTE format(
    'EXPLAIN (FORMAT JSON) SELECT SUM(rake_amount) FROM public.rake_records '
    || 'WHERE club_id=ANY(ARRAY[%L::uuid,%L::uuid]) AND created_at >= %L::timestamptz '
    || 'AND player_contributions IS NOT NULL',
    c1,u,since_at)
    INTO plan;
  IF position('idx_rake_records_union_signed_window' in plan::text) = 0 THEN
    RAISE EXCEPTION 'signed risk plan did not use the new full covering index: %', plan;
  END IF;
  fn_src := pg_get_functiondef(
    'public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure);
  IF (length(fn_src) - length(replace(fn_src, 'jsonb_each_text(', '')))
       / length('jsonb_each_text(') IS DISTINCT FROM 1
     OR position('scoped_rake_records AS MATERIALIZED' in fn_src) > 0
     OR position('club_rake_daily_user' in fn_src) = 0
     OR position('club_rake_rollup_complete' in fn_src) = 0
     OR position('edge_attribution_rake AS' in fn_src) = 0
     OR position('gap_days AS MATERIALIZED' in fn_src) = 0
     OR position('gap_hand_records AS MATERIALIZED' in fn_src) = 0
     OR position('gap_hand_fallback_records AS MATERIALIZED' in fn_src) = 0
     OR position('gap_hand_rake AS' in fn_src) = 0
     OR position('PARTITION BY a.rake_record_id' in fn_src) = 0
     OR position('JOIN public.rake_records r ON r.id = x.id' in fn_src) = 0
     OR position('UNION ALL SELECT * FROM gap_hand_rake' in fn_src) = 0
     OR position(E'FROM gap_days gd\n      JOIN public.rake_records r' in fn_src) > 0
     OR (length(fn_src) - length(replace(fn_src, 'OFFSET 0', '')))
        / length('OFFSET 0') IS DISTINCT FROM 4
     OR position('flow_legs AS MATERIALIZED' in fn_src) > 0
     OR position('flows AS MATERIALIZED' in fn_src) = 0
     OR position('l.to_entity_id = p.player_id' in fn_src) = 0
     OR position('l.from_entity_id = p.player_id' in fn_src) = 0
     OR position('comm_pairs AS MATERIALIZED' in fn_src) = 0
     OR position('comm AS MATERIALIZED' in fn_src) = 0
     OR position('smarter_private.agent_commission_report_daily' in fn_src) = 0
     OR position('comm_gap_days AS MATERIALIZED' in fn_src) = 0
     OR position('v_comm_head_end' in fn_src) = 0
     OR position('GREATEST(v_comm_today,v_from)' in fn_src) = 0
     OR position('ac.user_id = p.agent_user_id' in fn_src) = 0
     OR position('ac.club_id = p.club_id' in fn_src) = 0
     OR position('JOIN public.agent_commissions ac' in fn_src) > 0
     OR position('GROUP BY ac.user_id, ac.club_id' in fn_src) > 0
     OR position('JOIN edge_windows' in fn_src) > 0
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure
          AND p.proconfig IS NOT DISTINCT FROM
              ARRAY['search_path=public','jit=off']::text[])
     OR position('LEFT JOIN LATERAL (' in fn_src) > 0 THEN
    RAISE EXCEPTION 'risk report lost bounded facts or pair-keyed flow/commission reads';
  END IF;

  d := public.fn_union_distribution_check(u,since_at);
  SELECT COALESCE(SUM(rr.rake_amount),0) INTO direct_rake
    FROM public.rake_records rr
    JOIN public.clubs c ON c.id=rr.club_id AND (c.union_id=u OR c.id=u)
   WHERE rr.created_at>=since_at;
  SELECT COALESCE(SUM(ac.amount),0) INTO direct_comm
    FROM public.agent_commissions ac
    JOIN public.clubs c ON c.id=ac.club_id AND (c.union_id=u OR c.id=u)
   WHERE ac.created_at>=since_at;
  IF direct_rake IS DISTINCT FROM 10.00
     OR (d->>'rake_collected')::numeric IS DISTINCT FROM direct_rake
     OR direct_comm IS DISTINCT FROM 2.50
     OR (d->>'agent_commissions')::numeric IS DISTINCT FROM direct_comm
     OR (d->>'player_rakeback')::numeric IS DISTINCT FROM 1.00
     OR (d->>'total_distributed')::numeric IS DISTINCT FROM 3.50
     OR (d->>'over_distributed_by')::numeric IS DISTINCT FROM 0.00
     OR (d->>'healthy')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'distribution check changed exact conservation arithmetic: %', d;
  END IF;
  d := public.fn_union_distribution_check(u,'2026-09-29 02:30:00+00');
  IF (d->>'rake_collected')::numeric IS DISTINCT FROM 3.50
     OR (d->>'agent_commissions')::numeric IS DISTINCT FROM 0.50 THEN
    RAISE EXCEPTION 'distribution changed the arbitrary lower-bound/open-ended contract: %', d;
  END IF;
  fn_src := pg_get_functiondef(
    'public.fn_union_distribution_check(uuid,timestamptz)'::regprocedure);
  IF position('ca_club_commission_daily' in fn_src) = 0
     OR position('v_rollup_from_date' in fn_src) = 0
     OR position('v_head_end' in fn_src) = 0
     OR position('GREATEST(v_from, v_today_start)' in fn_src) = 0
     OR (length(fn_src) - length(replace(
           fn_src, 'FROM public.agent_commissions ac', '')))
        / length('FROM public.agent_commissions ac') IS DISTINCT FROM 2
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid =
          'public.fn_union_distribution_check(uuid,timestamptz)'::regprocedure
          AND p.proconfig IS NOT DISTINCT FROM
              ARRAY['search_path=public','jit=off']::text[]) THEN
    RAISE EXCEPTION 'distribution check lost exact daily facts or UTC edge reads';
  END IF;

  fn_src := pg_get_functiondef(
    'public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure);
  IF position('l.to_entity_id = p.player_id' in fn_src) = 0
     OR position('l.from_entity_id = p.player_id' in fn_src) = 0
     OR position('flow_legs AS MATERIALIZED' in fn_src) <> 0
     OR position('comm AS MATERIALIZED' in fn_src) = 0
     OR position('smarter_private.agent_commission_report_daily' in fn_src) = 0
     OR position('comm_gap_days AS MATERIALIZED' in fn_src) = 0
     OR position('v_comm_head_end' in fn_src) = 0
     OR position('GREATEST(v_comm_today,v_from)' in fn_src) = 0
     OR position('ac.user_id = p.agent_user_id' in fn_src) = 0
     OR position('ac.club_id = p.club_id' in fn_src) = 0
     OR position('JOIN public.agent_commissions ac' in fn_src) <> 0
     OR position('GROUP BY ac.user_id, ac.club_id' in fn_src) <> 0
     OR position('gap_hand_records AS MATERIALIZED' in fn_src) = 0
     OR position('gap_hand_fallback_records AS MATERIALIZED' in fn_src) = 0
     OR position('gap_hand_rake AS' in fn_src) = 0
     OR NOT EXISTS (
       SELECT 1
         FROM pg_index i
        WHERE i.indexrelid =
              'public.idx_chip_ledger_risk_in_player_window'::regclass
          AND i.indisvalid AND i.indisready AND i.indislive)
     OR NOT EXISTS (
       SELECT 1
         FROM pg_index i
        WHERE i.indexrelid =
              'public.idx_chip_ledger_risk_out_player_window'::regclass
          AND i.indisvalid AND i.indisready AND i.indislive)
     OR pg_get_indexdef(
          'public.idx_rake_records_union_gap_hand_window'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_records_union_gap_hand_window ON public.rake_records USING btree (club_id, created_at) INCLUDE (id, rake_amount) WHERE ((hand_id IS NOT NULL) AND (rake_amount > (0)::numeric) AND (player_contributions IS NOT NULL))'
     OR pg_get_indexdef(
          'public.idx_rake_records_union_gap_handless_window'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_records_union_gap_handless_window ON public.rake_records USING btree (club_id, created_at) INCLUDE (id, rake_amount, player_contributions) WHERE ((hand_id IS NULL) AND (rake_amount > (0)::numeric) AND (player_contributions IS NOT NULL))'
     OR pg_get_indexdef(
          'public.idx_rake_attributions_union_gap_record_player'::regclass)
        IS DISTINCT FROM
          'CREATE INDEX idx_rake_attributions_union_gap_record_player ON public.rake_attributions USING btree (rake_record_id, player_id) INCLUDE (eligible_contribution) WHERE (eligible_contribution > (0)::numeric)' THEN
    RAISE EXCEPTION 'risk report lost exact pair-keyed chip flow or commission reads';
  END IF;

  d := public.fn_union_settlement_preview(u,since_at,since_at + interval '7 days');
  IF (d#>>'{round1,already_executed}')::boolean IS DISTINCT FROM true
     OR (d#>>'{round1,rake_treasury_available}')::numeric IS DISTINCT FROM 9.00
     OR (d#>>'{round2,payees}')::int IS DISTINCT FROM 1
     OR (d#>>'{round2,amount}')::numeric IS DISTINCT FROM 1.50
     -- The positive a1 pair remains the 1.50 headline. The independent
     -- preimage shortage view includes a3's -1.00 pair, leaving 0.50 owed
     -- against 1.00 treasury and therefore no Round-2 shortage.
     OR (d#>>'{round2,clubs_short}')::int IS DISTINCT FROM 0
     OR (d#>>'{round2,short_by}')::numeric IS DISTINCT FROM 0.00
     OR d#>'{round2,detail}' IS DISTINCT FROM '[]'::jsonb
     OR (d#>>'{round3,payees}')::int IS DISTINCT FROM 2
     OR (d#>>'{round3,amount}')::numeric IS DISTINCT FROM 3.00
     OR (d#>>'{round3,agents_short}')::int IS DISTINCT FROM 1
     OR (d#>>'{round3,short_by}')::numeric IS DISTINCT FROM 2.50
     OR (d#>>'{round3,detail,0,agent_user_id}')::uuid IS DISTINCT FROM a1
     OR (d#>>'{round3,detail,0,agent}') IS DISTINCT FROM 'Agent One'
     OR (d->>'total_to_move')::numeric IS DISTINCT FROM 4.50
     OR (d->>'has_blockers')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'settlement preview changed paid-period or shortage accounting: %', d;
  END IF;
  fn_src := pg_get_functiondef(
    'public.fn_union_settlement_preview(uuid,timestamptz,timestamptz)'::regprocedure);
  IF position('fn_agent_commission_paid_by_period' in fn_src) > 0
     OR position('fn_caller_is_engine()' in fn_src) = 0
     OR position('auth.uid() IS NULL' in fn_src) = 0
     OR (length(fn_src) - length(replace(
           fn_src, 'FROM public.agent_commissions ac', '')))
        / length('FROM public.agent_commissions ac') IS DISTINCT FROM 1
     OR (length(fn_src) - length(replace(
           fn_src, 'FROM public.rakeback_periods rp', '')))
        / length('FROM public.rakeback_periods rp') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'settlement preview changed authorization or restored an unbounded scan';
  END IF;
  EXECUTE format(
    'EXPLAIN (FORMAT JSON) SELECT SUM(rake_amount) FROM public.rake_records '
    || 'WHERE club_id=ANY(ARRAY[%L::uuid,%L::uuid]) AND created_at >= %L::timestamptz',
    c2,u,since_at)
    INTO plan;
  IF position('idx_rake_records_union_signed_window' in plan::text) = 0 THEN
    RAISE EXCEPTION 'signed rake plan did not use the new full covering index: %', plan;
  END IF;
  IF clock_timestamp() - started > interval '8 seconds' THEN
    RAISE EXCEPTION 'focused Union Ops reads exceeded signed-in budget';
  END IF;

  PERFORM set_config('app.engine','off',false);
  PERFORM set_config('app.user_id',other_admin::text,false);
  BEGIN
    PERFORM public.fn_union_agent_risk_report(u,since_at);
    RAISE EXCEPTION 'another union overseer read Midway risk';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'not_authorised' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_union_distribution_check(u,since_at);
    RAISE EXCEPTION 'another union overseer read Midway distribution';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'not_authorised' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_union_settlement_preview(u,since_at,since_at + interval '7 days');
    RAISE EXCEPTION 'another union overseer read Midway settlement preview';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'not_authorised' THEN RAISE; END IF;
  END;

  PERFORM set_config('app.user_id','',false);
  BEGIN
    PERFORM public.fn_union_settlement_preview(u,since_at,since_at + interval '7 days');
    RAISE EXCEPTION 'an unauthenticated non-engine caller read Midway settlement preview';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM 'not_authorised' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.engine','on',false);
  PERFORM public.fn_union_settlement_preview(u,since_at,since_at + interval '7 days');
  PERFORM set_config('app.engine','off',false);

  PERFORM set_config('app.user_id',admin::text,false);
  s := public.fn_union_law_selftest_status();
  IF (s->>'available')::boolean IS DISTINCT FROM true
     OR s->>'run_status' IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'migration did not seed an immediately available law verdict: %', s;
  END IF;
  UPDATE cron.job SET active=false WHERE jobid=121;
  s := public.fn_union_law_selftest_status();
  IF (s->>'available')::boolean IS DISTINCT FROM false
     OR s->>'run_status' IS DISTINCT FROM 'inactive' THEN
    RAISE EXCEPTION 'an inactive audit job left cached green visible: %', s;
  END IF;
  UPDATE cron.job SET active=true WHERE jobid=121;
  DELETE FROM cron.job WHERE jobid=121;
  s := public.fn_union_law_selftest_status();
  IF (s->>'available')::boolean IS DISTINCT FROM false
     OR s->>'run_status' IS DISTINCT FROM 'missing' THEN
    RAISE EXCEPTION 'a missing audit job left cached green visible: %', s;
  END IF;
  INSERT INTO cron.job(jobid,jobname,schedule,command,active,username,database) VALUES
    (121,'union-law-selftest','20 0 * * *',
     'SET statement_timeout = ''600s''; SELECT public.fn_union_law_selftest_record();',true,
     'postgres','postgres');
  UPDATE public.union_law_selftest_runs
     SET completed_at=clock_timestamp()-interval '48 hours';
  s := public.fn_union_law_selftest_status();
  IF (s->>'available')::boolean IS DISTINCT FROM false
     OR s->>'run_status' IS DISTINCT FROM 'stale' THEN
    RAISE EXCEPTION 'an aged law verdict remained green: %', s;
  END IF;
  UPDATE public.union_law_selftest_runs SET completed_at=clock_timestamp();
  TRUNCATE public.union_law_selftest_runs RESTART IDENTITY;
  s := public.fn_union_law_selftest_status();
  IF (s->>'available')::boolean IS DISTINCT FROM false
     OR s->>'run_status' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'uncached law status did not preserve the latest scheduler state: %', s;
  END IF;
  PERFORM public.fn_union_law_selftest_record();
  s := public.fn_union_law_selftest_status();
  IF (s->>'available')::boolean IS DISTINCT FROM true
     OR (s->>'healthy')::boolean IS DISTINCT FROM true
     OR jsonb_array_length(s->'warnings') <> 1 THEN
    RAISE EXCEPTION 'cached law status changed the scheduled verdict: %', s;
  END IF;
  INSERT INTO cron.job_run_details(jobid,status,start_time,end_time,return_message) VALUES
    (121,'failed',clock_timestamp() + interval '1 second',clock_timestamp() + interval '2 seconds',
     'statement timeout');
  s := public.fn_union_law_selftest_status();
  IF (s->>'available')::boolean IS DISTINCT FROM false
     OR s->>'run_status' IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'a newer failed audit left an older cached green visible: %', s;
  END IF;
  IF (SELECT command FROM cron.job WHERE jobid=121) IS DISTINCT FROM
     'SET statement_timeout = ''600s''; SELECT public.fn_union_law_selftest_record();' THEN
    RAISE EXCEPTION 'daily law producer was not repointed to the recorder';
  END IF;
END
$fixture$;

-- Exercise the recent unsealed-gap branches against yesterday on every run.
-- The three records are inserted one at a time so each successor path has an
-- exact observable delta: attribution weights, missing-attribution JSON
-- fallback, then the retained handless JSON allocation.
DO $recent_gap_paths$
DECLARE
  recent_union constant uuid := 'fade0000-0000-4000-8000-000000000002';
  recent_club constant uuid := 'abababab-abab-4bab-8bab-abababababab';
  admin constant uuid := '90000000-0000-4000-8000-000000000001';
  a1 constant uuid := 'd0000000-0000-4000-8000-000000000001';
  a2 constant uuid := 'e0000000-0000-4000-8000-000000000002';
  p1 constant uuid := '10000000-0000-4000-8000-000000000001';
  p2 constant uuid := '10000000-0000-4000-8000-000000000002';
  p3 constant uuid := '10000000-0000-4000-8000-000000000003';
  p4 constant uuid := '10000000-0000-4000-8000-000000000004';
  attributed_record constant uuid := '70000000-0000-4000-8000-000000000107';
  attributed_hand constant uuid := '80000000-0000-4000-8000-000000000107';
  fallback_record constant uuid := '70000000-0000-4000-8000-000000000108';
  fallback_hand constant uuid := '80000000-0000-4000-8000-000000000108';
  handless_record constant uuid := '70000000-0000-4000-8000-000000000109';
  recent_start timestamptz := date_trunc('day', now()) - interval '1 day';
  a1_rake numeric;
  a2_rake numeric;
  total_rake numeric;
BEGIN
  INSERT INTO public.unions(id,name,owner_id)
  VALUES (recent_union,'Recent Gap Union',admin);
  INSERT INTO public.clubs(id,name,union_id,owner_id,is_union) VALUES
    (recent_union,'Recent Gap Union',recent_union,admin,true),
    (recent_club,'Recent Gap Club',NULL,NULL,false);
  INSERT INTO public.union_clubs(union_id,club_id)
  VALUES (recent_union,recent_club);
  INSERT INTO public.agents(user_id,club_id,role) VALUES
    (a1,recent_club,'agent'),(a2,recent_club,'agent');
  INSERT INTO public.club_members(club_id,user_id,agent_id,joined_at) VALUES
    (recent_club,p1,a1,recent_start - interval '30 days'),
    (recent_club,p2,a1,recent_start - interval '30 days'),
    (recent_club,p3,a2,recent_start - interval '30 days'),
    (recent_club,p4,a2,recent_start - interval '30 days');

  INSERT INTO public.rake_records(
    id,hand_id,club_id,rake_amount,player_contributions,is_tournament,created_at)
  VALUES (
    attributed_record,attributed_hand,recent_club,8,
    jsonb_build_object(p1::text,3,p4::text,1),false,
    recent_start + interval '6 hours');
  INSERT INTO public.rake_attributions(
    hand_id,rake_record_id,player_id,club_id,rake_amount,
    eligible_contribution,created_at) VALUES
    (attributed_hand,attributed_record,p1,recent_club,6,3,
     recent_start + interval '6 hours'),
    (attributed_hand,attributed_record,p4,recent_club,2,1,
     recent_start + interval '6 hours');

  PERFORM set_config('app.engine','on',false);
  SELECT MAX(r.rake_generated) FILTER (WHERE r.agent_user_id=a1),
         MAX(r.rake_generated) FILTER (WHERE r.agent_user_id=a2),
         SUM(r.rake_generated)
    INTO a1_rake,a2_rake,total_rake
    FROM public.fn_union_agent_risk_report(recent_union,recent_start) r;
  IF a1_rake IS DISTINCT FROM 6.00
     OR a2_rake IS DISTINCT FROM 2.00
     OR total_rake IS DISTINCT FROM 8.00 THEN
    RAISE EXCEPTION 'recent gap attributed split changed: a1 %, a2 %, total %',
      a1_rake,a2_rake,total_rake;
  END IF;

  INSERT INTO public.rake_records(
    id,hand_id,club_id,rake_amount,player_contributions,is_tournament,created_at)
  VALUES (
    fallback_record,fallback_hand,recent_club,3,
    jsonb_build_object(p2::text,1),false,
    recent_start + interval '6 hours 10 minutes');
  SELECT MAX(r.rake_generated) FILTER (WHERE r.agent_user_id=a1),
         MAX(r.rake_generated) FILTER (WHERE r.agent_user_id=a2),
         SUM(r.rake_generated)
    INTO a1_rake,a2_rake,total_rake
    FROM public.fn_union_agent_risk_report(recent_union,recent_start) r;
  IF a1_rake IS DISTINCT FROM 9.00
     OR a2_rake IS DISTINCT FROM 2.00
     OR total_rake IS DISTINCT FROM 11.00 THEN
    RAISE EXCEPTION 'recent gap missing-attribution fallback changed: a1 %, a2 %, total %',
      a1_rake,a2_rake,total_rake;
  END IF;

  INSERT INTO public.rake_records(
    id,hand_id,club_id,rake_amount,player_contributions,is_tournament,created_at)
  VALUES (
    handless_record,NULL,recent_club,5,
    jsonb_build_object(p3::text,1),false,
    recent_start + interval '6 hours 20 minutes');
  SELECT MAX(r.rake_generated) FILTER (WHERE r.agent_user_id=a1),
         MAX(r.rake_generated) FILTER (WHERE r.agent_user_id=a2),
         SUM(r.rake_generated)
    INTO a1_rake,a2_rake,total_rake
    FROM public.fn_union_agent_risk_report(recent_union,recent_start) r;
  IF a1_rake IS DISTINCT FROM 9.00
     OR a2_rake IS DISTINCT FROM 7.00
     OR total_rake IS DISTINCT FROM 16.00 THEN
    RAISE EXCEPTION 'recent gap handless JSON allocation changed: a1 %, a2 %, total %',
      a1_rake,a2_rake,total_rake;
  END IF;
END
$recent_gap_paths$;

-- Match the production roster dimension without changing the small-data
-- parity case above: 587 roster rows / 586 distinct players in the union.
INSERT INTO public.club_members(club_id,user_id,agent_id,joined_at)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
       ('20000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,
       'd0000000-0000-4000-8000-000000000001'::uuid,
       '2026-01-01 00:00:00+00'::timestamptz
  FROM generate_series(1,582) g;

-- Production-shaped Risk qualification. One million selected cash rows are
-- represented by the exact completed-day per-player facts the production
-- reader is required to use. Three hundred thousand table-stack movements
-- exercise both player-keyed covering-index legs.
INSERT INTO public.rake_records(
  hand_id,club_id,rake_amount,player_contributions,is_tournament,source,metadata,created_at)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
       0.06,
       jsonb_build_object(
         '10000000-0000-4000-8000-000000000001',1,
         '10000000-0000-4000-8000-000000000002',1,
         '90000000-0000-4000-8000-000000000001',1,
         '90000000-0000-4000-8000-000000000002',1,
         '90000000-0000-4000-8000-000000000003',1,
         '90000000-0000-4000-8000-000000000006',1),
       false,'cash_hand','{}'::jsonb,'2026-09-30 12:30:00+00'::timestamptz
  FROM generate_series(1,1000000);

INSERT INTO public.club_rake_daily_user(
  club_id,day,user_id,rake_amount,hands) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-09-30',
   '10000000-0000-4000-8000-000000000001',10000.00,1000000),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-09-30',
   '10000000-0000-4000-8000-000000000002',10000.00,1000000);
INSERT INTO public.club_rake_rollup_complete(club_id,day,rows_written)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-09-30',2);

INSERT INTO public.chip_ledger(
  club_id,from_type,from_entity_id,to_type,to_entity_id,amount,status,created_at)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
       CASE WHEN g % 2 = 0 THEN 'player_wallet' ELSE 'table_stack' END,
       CASE WHEN g % 2 = 0
            THEN '10000000-0000-4000-8000-000000000001'::uuid
            ELSE gen_random_uuid() END,
       CASE WHEN g % 2 = 0 THEN 'table_stack' ELSE 'player_wallet' END,
       CASE WHEN g % 2 = 0
            THEN gen_random_uuid()
            ELSE '10000000-0000-4000-8000-000000000001'::uuid END,
       CASE WHEN g % 2 = 0 THEN 0.01 ELSE 0.02 END,
       'posted','2026-09-30 13:30:00+00'::timestamptz
  FROM generate_series(1,300000) g;

ANALYZE public.rake_records;
ANALYZE public.chip_ledger;

-- The hosted PGDG image has LLVM available while production does not. Keep
-- the caller JIT-enabled so this scale case proves the function-local guard
-- rather than hiding the ambient-host dependency in fixture configuration.
SET jit = 'on';
SET work_mem = '4MB';
SET statement_timeout = '8s';
DO $risk_scale$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_total numeric;
  v_net numeric;
  v_rows integer;
BEGIN
  SELECT count(*), SUM(r.rake_generated), SUM(r.player_net)
    INTO v_rows, v_total, v_net
    FROM public.fn_union_agent_risk_report(
      'fade0000-0000-0000-0000-000000000001'::uuid,
      '2026-09-28 12:30:00+00'::timestamptz) r;
  IF current_setting('jit') IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'risk report leaked its function-local JIT setting';
  END IF;
  -- Baseline Player Net is +4.00. The scaled p1 ledger adds 150,000 *
  -- (+0.02) inbound and 150,000 * (-0.01) outbound = +1,500.00.
  IF v_rows IS DISTINCT FROM 3
     OR v_total IS DISTINCT FROM 20012.00
     OR v_net IS DISTINCT FROM 1504.00 THEN
    RAISE EXCEPTION 'scaled risk result changed signed allocation/flow: rows %, rake %, net %',
      v_rows, v_total, v_net;
  END IF;
  RAISE NOTICE 'scaled Risk: 1,000,000 six-way JSON rows + 300,000 flows in % ms',
    round(extract(epoch FROM clock_timestamp() - v_started) * 1000);
END
$risk_scale$;
RESET statement_timeout;
RESET work_mem;
RESET jit;

-- Release the Risk scale relations before building the commission-scale case;
-- the fixture runs on the external SSD and must not retain two large cases at
-- once. Functional parity was proved above before this local-only truncation.
TRUNCATE public.rake_records, public.chip_ledger;

-- Production-shaped Preview qualification. The historical Round-2 incident
-- involved roughly 2.2 million commission rows. 1.7 million are behind a
-- settlement row covering the entire requested period and must be skipped at
-- pair scope; the remaining half million are read once through the partial
-- open index and explicit settlement anti-join.
INSERT INTO public.agent_commissions(user_id,club_id,amount,created_at)
SELECT 'e0000000-0000-4000-8000-000000000002'::uuid,
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
       0.01,'2026-10-02 12:30:00+00'::timestamptz
  FROM generate_series(1,1700000);
INSERT INTO public.agent_commissions(user_id,club_id,amount,created_at)
SELECT 'd0000000-0000-4000-8000-000000000001'::uuid,
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
       0.01,'2026-10-01 12:30:00+00'::timestamptz
  FROM generate_series(1,500000);

ANALYZE public.agent_commissions;

-- Match the JIT-enabled hosted caller used by the Risk scale gate. The
-- distribution function disables JIT only for its own statement and must
-- restore the caller setting when it returns.
SET jit = 'on';
SET work_mem = '4MB';
SET statement_timeout = '8s';
DO $preview_scale$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_preview jsonb;
  v_distribution jsonb;
  v_risk_rows integer;
  v_commission numeric;
BEGIN
  SELECT count(*), MAX(r.commission_accrued) FILTER (
           WHERE r.agent_user_id='d0000000-0000-4000-8000-000000000001'::uuid
             AND r.club_name='Club One')
    INTO v_risk_rows, v_commission
    FROM public.fn_union_agent_risk_report(
      'fade0000-0000-0000-0000-000000000001'::uuid,
      '2026-09-28 12:30:00+00'::timestamptz) r;
  IF v_risk_rows IS DISTINCT FROM 3
     OR v_commission IS DISTINCT FROM 5004.25 THEN
    RAISE EXCEPTION 'scaled Risk commission pair filter changed: rows %, commission %',
      v_risk_rows, v_commission;
  END IF;

  v_preview := public.fn_union_settlement_preview(
    'fade0000-0000-0000-0000-000000000001'::uuid,
    '2026-09-28 12:30:00+00'::timestamptz,
    '2026-10-05 12:30:00+00'::timestamptz);
  IF (v_preview#>>'{round2,payees}')::int IS DISTINCT FROM 1
     OR (v_preview#>>'{round2,amount}')::numeric IS DISTINCT FROM 5001.50
     -- 5,001.50 positive-pair headline - 1.00 negative-pair adjustment
     -- - 1.00 treasury = 4,999.50 exact club shortage.
     OR (v_preview#>>'{round2,short_by}')::numeric IS DISTINCT FROM 4999.50
     OR (v_preview#>>'{round3,amount}')::numeric IS DISTINCT FROM 3.00
     OR (v_preview->>'total_to_move')::numeric IS DISTINCT FROM 5004.50 THEN
    RAISE EXCEPTION 'scaled preview changed exact paid-period accounting: %',
      v_preview;
  END IF;
  PERFORM set_config('app.engine','on',false);
  v_distribution := public.fn_union_distribution_check(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    '2026-09-28 12:30:00+00'::timestamptz);
  PERFORM set_config('app.engine','off',false);
  IF (v_distribution->>'agent_commissions')::numeric IS DISTINCT FROM 22080.25 THEN
    RAISE EXCEPTION 'scaled distribution changed exact commission accounting: %',
      v_distribution;
  END IF;
  IF current_setting('jit') IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'distribution check leaked its function-local JIT setting';
  END IF;
  RAISE NOTICE 'scaled Preview: 2,200,000 commission rows in % ms',
    round(extract(epoch FROM clock_timestamp() - v_started) * 1000);
END
$preview_scale$;
RESET statement_timeout;
RESET work_mem;
RESET jit;

TRUNCATE public.agent_commissions, public.rakeback_periods,
         public.agent_commission_settlements;

SELECT 'union_ops_financial_admin_pg17_ok' AS result;
