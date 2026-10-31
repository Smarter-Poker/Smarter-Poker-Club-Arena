DO $$
DECLARE
 c uuid := '83000000-0000-0000-0000-000000000001';
 u uuid := '83000000-0000-0000-0000-000000000002';
 dst_u uuid := '83000000-0000-0000-0000-000000000032';
 d jsonb; b jsonb; r record; day date; start_at timestamptz; end_at timestamptz;
 label text; expected_hours int;
BEGIN
 d := ca_club_member_win_loss(c,u);
 SELECT * INTO r FROM ca_club_members_win_loss(c,ARRAY[u],'today');
 IF d->'today' IS DISTINCT FROM '{"cash":30,"mtt":3,"net":33}'::jsonb
    OR r.cash IS DISTINCT FROM 30 OR r.mtt IS DISTINCT FROM 3 OR r.net IS DISTINCT FROM 33 THEN
   RAISE EXCEPTION 'Chicago Today boundary mismatch: record %, list %',d->'today',r;
 END IF;
 IF d->>'as_of' <> (now() AT TIME ZONE 'America/Chicago')::date::text THEN
   RAISE EXCEPTION 'Chicago Today date mismatch';
 END IF;
 SELECT value INTO b FROM chicago_longer_baseline;
 FOREACH label IN ARRAY ARRAY['week','month','overall'] LOOP
   IF d->label IS DISTINCT FROM b->label THEN RAISE EXCEPTION 'Changed longer period %',label; END IF;
   SELECT * INTO r FROM ca_club_members_win_loss(c,ARRAY[u],label);
   IF jsonb_build_object('cash',r.cash,'mtt',r.mtt,'net',r.net) IS DISTINCT FROM d->label THEN
     RAISE EXCEPTION 'Longer-period reader disagreement %',label;
   END IF;
 END LOOP;
 -- A real launch accounting cutoff is still honored by the timestamp reader.
 PERFORM set_config('test.cutoff',(((now() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago'+interval '1 second')::text,true);
 INSERT INTO ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,net)
 VALUES(gen_random_uuid(),'83000000-0000-0000-0000-000000000012',c,
        ((now() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago','nlh',10),
       (gen_random_uuid(),'83000000-0000-0000-0000-000000000012',c,now(),'nlh',20);
 IF ca_club_member_chicago_today_cash(c,'83000000-0000-0000-0000-000000000012') <> 20 THEN RAISE EXCEPTION 'Accounting cutoff lost'; END IF;
 PERFORM set_config('test.cutoff','',true);

 -- Winter/summer offsets, 23-hour spring day, 25-hour fall day, year rollover.
 -- Keep fixed-date cases separate from Today's facts, which can land on any
 -- of these boundaries as the real calendar advances.
 FOREACH day IN ARRAY ARRAY[date '2026-01-15',date '2026-07-15',date '2026-03-08',date '2026-11-01',date '2026-12-31'] LOOP
   start_at := day::timestamp AT TIME ZONE 'America/Chicago';
   end_at := (day+1)::timestamp AT TIME ZONE 'America/Chicago';
   expected_hours := CASE day WHEN date '2026-03-08' THEN 23 WHEN date '2026-11-01' THEN 25 ELSE 24 END;
   IF extract(epoch FROM end_at-start_at)/3600 <> expected_hours THEN RAISE EXCEPTION 'DST day length'; END IF;
   INSERT INTO ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,net)
   VALUES(gen_random_uuid(),dst_u,c,start_at-interval '1 microsecond','nlh',100),
         (gen_random_uuid(),dst_u,c,start_at,'nlh',11),
         (gen_random_uuid(),dst_u,c,end_at-interval '1 microsecond','nlh',22),
         (gen_random_uuid(),dst_u,c,end_at,'nlh',1000);
   IF ca_club_member_chicago_today_cash(c,dst_u,start_at) <> 33
      OR ca_club_member_chicago_today_cash(c,dst_u,end_at-interval '1 microsecond') <> 33
      OR ca_club_member_chicago_today_cash(c,dst_u,end_at) <> 1000 THEN
     RAISE EXCEPTION 'DST inclusion boundary %',day;
   END IF;
 END LOOP;

 -- Funded attribution is captured at insertion, exactly as on the record.
 INSERT INTO cash_participant_funding_receipts VALUES(gen_random_uuid(),'buyin',
  '83000000-0000-0000-0000-000000000014','83000000-0000-0000-0000-000000000022',
  '83000000-0000-0000-0000-000000000009',now()-interval '3 days',now());
 INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net)
 VALUES(gen_random_uuid(),'83000000-0000-0000-0000-000000000022',c,
  '83000000-0000-0000-0000-000000000014',now(),'nlh',30);
 IF ca_club_member_chicago_today_cash(c,'83000000-0000-0000-0000-000000000022') <> 0
    OR ca_club_member_chicago_today_cash('83000000-0000-0000-0000-000000000009','83000000-0000-0000-0000-000000000022') <> 30 THEN
   RAISE EXCEPTION 'Funded club attribution lost';
 END IF;

 PERFORM set_config('test.access','none',true);
 IF ca_club_member_win_loss(c,u) IS NOT NULL
    OR EXISTS(SELECT 1 FROM ca_club_members_win_loss(c,ARRAY[u],'today')) THEN
   RAISE EXCEPTION 'Unauthorized money disclosure';
 END IF;
 IF has_function_privilege('authenticated','public.ca_club_member_chicago_today_cash(uuid,uuid,timestamptz)','EXECUTE')
    OR has_function_privilege('anon','public.ca_club_member_chicago_today_cash(uuid,uuid,timestamptz)','EXECUTE') THEN
   RAISE EXCEPTION 'Internal cash helper exposed';
 END IF;
END $$;
