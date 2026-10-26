-- This Week and This Month begin at 12:00 AM America/Chicago (Dan 2026-10-25).
-- Runs after chicago-today-before.sql / chicago-today-after.sql on the same
-- database. Before 20261026011138 the first assertion must fail.
SELECT set_config('test.access','staff',false), set_config('test.cutoff','',false);
SET TIME ZONE 'Asia/Tokyo';
DO $$
DECLARE
 c uuid := '83000000-0000-0000-0000-000000000001';
 w uuid := '84000000-0000-0000-0000-000000000001';
 m uuid := '84000000-0000-0000-0000-000000000002';
 t uuid := '83000000-0000-0000-0000-000000000003';
 today date := (now() AT TIME ZONE 'America/Chicago')::date;
 week_at timestamptz := date_trunc('week', today::timestamp)::date::timestamp AT TIME ZONE 'America/Chicago';
 month_at timestamptz := date_trunc('month', today::timestamp)::date::timestamp AT TIME ZONE 'America/Chicago';
 expected jsonb := '{"cash":11,"mtt":1.1,"net":12.1}'::jsonb;
 dw jsonb; dm jsonb; r record; label text; who uuid;
 range_from date; range_to date; start_at timestamptz; end_at timestamptz; i int := 0;
BEGIN
 -- One microsecond before the Chicago boundary is outside; the boundary and now are inside.
 INSERT INTO ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,net)
 SELECT gen_random_uuid(), x.uid, c, x.at, 'nlh', x.net FROM (VALUES
   (w, week_at - interval '1 microsecond', 100::numeric), (w, week_at, 10), (w, now(), 1),
   (m, month_at - interval '1 microsecond', 100), (m, month_at, 10), (m, now(), 1)) x(uid,at,net);
 INSERT INTO chip_ledger(club_id,from_type,to_type,to_entity_id,amount,tournament_id,status,created_at)
 SELECT club_id,'prize_liability','player_wallet',user_id,net/10,t,'posted',played_at
   FROM ca_hand_facts WHERE user_id IN (w,m);

 dw := ca_club_member_win_loss(c,w);
 dm := ca_club_member_win_loss(c,m);
 IF dw->'week' IS DISTINCT FROM expected OR dm->'month' IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'Chicago week/month boundary mismatch: week %, month %', dw->'week', dm->'month';
 END IF;
 IF dw->>'week_from' <> (date_trunc('week', today::timestamp)::date)::text
    OR dm->>'month_from' <> (date_trunc('month', today::timestamp)::date)::text THEN
   RAISE EXCEPTION 'Chicago week/month start date mismatch';
 END IF;
 FOREACH label IN ARRAY ARRAY['today','week','month','overall'] LOOP
   FOREACH who IN ARRAY ARRAY[w,m] LOOP
     SELECT * INTO r FROM ca_club_members_win_loss(c,ARRAY[who],label);
     IF jsonb_build_object('cash',r.cash,'mtt',r.mtt,'net',r.net)
        IS DISTINCT FROM ca_club_member_win_loss(c,who)->label THEN
       RAISE EXCEPTION 'Record and list disagree on %', label;
     END IF;
   END LOOP;
 END LOOP;

 -- Weeks across spring-forward and fall-back, a month, and a year rollover.
 FOR range_from, range_to IN
   VALUES (date '2026-03-02', date '2026-03-09'), (date '2026-10-26', date '2026-11-02'),
          (date '2026-11-01', date '2026-12-01'), (date '2026-12-28', date '2027-01-04')
 LOOP
   i := i + 1;
   who := ('84000000-0000-0000-0001-'||lpad(i::text,12,'0'))::uuid;
   start_at := range_from::timestamp AT TIME ZONE 'America/Chicago';
   end_at := range_to::timestamp AT TIME ZONE 'America/Chicago';
   INSERT INTO ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,net)
   VALUES(gen_random_uuid(),who,c,start_at-interval '1 microsecond','nlh',100),
         (gen_random_uuid(),who,c,start_at,'nlh',11),
         (gen_random_uuid(),who,c,end_at-interval '1 microsecond','nlh',22),
         (gen_random_uuid(),who,c,end_at,'nlh',1000);
   IF ca_club_member_chicago_cash(c,who,range_from,range_to) <> 33 THEN
     RAISE EXCEPTION 'Chicago range inclusion boundary % to %', range_from, range_to;
   END IF;
 END LOOP;
 IF ca_club_member_chicago_cash(c,w,today,today) <> 0 THEN RAISE EXCEPTION 'Empty range not zero'; END IF;

 -- Launch accounting cutoff is still honored inside the edge scan.
 PERFORM set_config('test.cutoff',(week_at + interval '1 second')::text,true);
 who := '84000000-0000-0000-0000-000000000003';
 INSERT INTO ca_hand_facts(hand_id,user_id,club_id,played_at,game_variant,net)
 VALUES(gen_random_uuid(),who,c,week_at,'nlh',10),(gen_random_uuid(),who,c,now(),'nlh',20);
 IF ca_club_member_chicago_cash(c,who,(week_at AT TIME ZONE 'America/Chicago')::date,today+1) <> 20 THEN
   RAISE EXCEPTION 'Accounting cutoff lost';
 END IF;
 PERFORM set_config('test.cutoff','',true);

 PERFORM set_config('test.access','none',true);
 IF ca_club_member_win_loss(c,w) IS NOT NULL
    OR EXISTS(SELECT 1 FROM ca_club_members_win_loss(c,ARRAY[w],'week'))
    OR EXISTS(SELECT 1 FROM ca_club_members_win_loss(c,ARRAY[m],'month')) THEN
   RAISE EXCEPTION 'Unauthorized money disclosure';
 END IF;
 IF has_function_privilege('authenticated','public.ca_club_member_chicago_cash(uuid,uuid,date,date)','EXECUTE')
    OR has_function_privilege('anon','public.ca_club_member_chicago_cash(uuid,uuid,date,date)','EXECUTE') THEN
   RAISE EXCEPTION 'Internal cash helper exposed';
 END IF;
END $$;
