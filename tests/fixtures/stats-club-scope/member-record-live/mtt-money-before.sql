-- Tournament money fixture: stack-chip hand results differ from the ledger money
-- a member actually paid and won. Isolated IDs; no live data.
CREATE TABLE chip_ledger(id bigserial PRIMARY KEY,club_id uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,
 amount numeric,tournament_id uuid,status text,created_at timestamptz);
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,game_type text);
CREATE OR REPLACE FUNCTION public.ca_club_member_tournament_money(p_club_id uuid, p_user_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(sum(leg.signed), 0)
    FROM (
      SELECT l.amount AS signed
        FROM public.chip_ledger l
       WHERE l.club_id = p_club_id
         AND l.to_entity_id = p_user_id
         AND l.to_type = 'player_wallet'
         AND l.from_type = 'prize_liability'
         AND l.tournament_id IS NOT NULL
         AND l.status = 'posted'
         AND (p_from IS NULL OR l.created_at >= p_from)
         AND (p_to IS NULL OR l.created_at < p_to)
      UNION ALL
      SELECT -l.amount
        FROM public.chip_ledger l
       WHERE l.club_id = p_club_id
         AND l.from_entity_id = p_user_id
         AND l.from_type = 'player_wallet'
         AND l.to_type = 'prize_liability'
         AND l.tournament_id IS NOT NULL
         AND l.status = 'posted'
         AND (p_from IS NULL OR l.created_at >= p_from)
         AND (p_to IS NULL OR l.created_at < p_to)
    ) leg;
$function$;
-- The production fee reader returns total_fees, which 20261019021553 reads.
DROP FUNCTION ca_club_member_fee_totals(uuid,date,date,uuid);
CREATE FUNCTION ca_club_member_fee_totals(uuid,date,date,uuid) RETURNS TABLE(user_id uuid,cash_fees numeric,tournament_fees numeric,total_fees numeric)
 LANGUAGE sql AS $$ SELECT $4,16.55::numeric,0::numeric,16.55::numeric $$;
CREATE FUNCTION fn_ca_fee_counting_start() RETURNS date LANGUAGE sql AS $$ SELECT '2026-01-01'::date $$;
SELECT set_config('test.access','',false),set_config('test.cutoff','',false);
INSERT INTO clubs(id,name) VALUES('60000000-0000-0000-0000-000000000001','Money'),('60000000-0000-0000-0000-000000000009','Other');
INSERT INTO profiles(id,alias,status) VALUES('60000000-0000-0000-0000-000000000002','Grinder','active');
INSERT INTO club_members(user_id,club_id,role,status,joined_at,chip_balance,promo_balance)
 VALUES('60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001','player','active',now(),0,0);
-- T1 NLH three days ago: buy-in 10, prize 25. T2 PLO4 yesterday: buy-in 20, no prize.
INSERT INTO tournaments VALUES('60000000-0000-0000-0000-0000000000a1','60000000-0000-0000-0000-000000000001','NLH'),
 ('60000000-0000-0000-0000-0000000000a2','60000000-0000-0000-0000-000000000001','PLO4');
INSERT INTO tournament_players VALUES('60000000-0000-0000-0000-0000000000a1','60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001'),
 ('60000000-0000-0000-0000-0000000000a2','60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001');
INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,tournament_id,status,created_at) VALUES
 ('60000000-0000-0000-0000-000000000001','player_wallet','60000000-0000-0000-0000-000000000002','prize_liability','60000000-0000-0000-0000-0000000000a1',10,'60000000-0000-0000-0000-0000000000a1','posted',(current_date-3)::timestamp AT TIME ZONE 'UTC'+interval '1 hour'),
 ('60000000-0000-0000-0000-000000000001','prize_liability','60000000-0000-0000-0000-0000000000a1','player_wallet','60000000-0000-0000-0000-000000000002',25,'60000000-0000-0000-0000-0000000000a1','posted',(current_date-3)::timestamp AT TIME ZONE 'UTC'+interval '5 hours'),
 ('60000000-0000-0000-0000-000000000001','player_wallet','60000000-0000-0000-0000-000000000002','prize_liability','60000000-0000-0000-0000-0000000000a2',20,'60000000-0000-0000-0000-0000000000a2','posted',(current_date-1)::timestamp AT TIME ZONE 'UTC'+interval '1 hour'),
 -- Never counted: another club, a pending leg, a non-tournament wallet leg.
 ('60000000-0000-0000-0000-000000000009','prize_liability','60000000-0000-0000-0000-0000000000a1','player_wallet','60000000-0000-0000-0000-000000000002',500,'60000000-0000-0000-0000-0000000000a1','posted',now()),
 ('60000000-0000-0000-0000-000000000001','prize_liability','60000000-0000-0000-0000-0000000000a1','player_wallet','60000000-0000-0000-0000-000000000002',700,'60000000-0000-0000-0000-0000000000a1','pending',now()),
 ('60000000-0000-0000-0000-000000000001','table_stack',NULL,'player_wallet','60000000-0000-0000-0000-000000000002',900,NULL,'posted',now());
-- Tournament hands move thousands of stack chips; cash hands are real money.
INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,tournament_id,played_at,game_variant,net,rake_paid,vpip,pfr)
SELECT ('60000000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,'60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001',
 '60000000-0000-0000-0000-000000000004',CASE WHEN n<5 THEN '60000000-0000-0000-0000-0000000000a1'::uuid ELSE '60000000-0000-0000-0000-0000000000a2'::uuid END,
 CASE WHEN n<5 THEN (current_date-3)::timestamp AT TIME ZONE 'UTC'+interval '2 hours' ELSE (current_date-1)::timestamp AT TIME ZONE 'UTC'+interval '2 hours' END,
 CASE WHEN n<5 THEN 'NLH' ELSE 'PLO4' END,-1000,0,true,false FROM generate_series(1,8) n;
INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net,rake_paid,vpip,pfr)
SELECT ('60000000-0000-0000-0002-'||lpad(n::text,12,'0'))::uuid,'60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001',
 '60000000-0000-0000-0000-000000000005',(current_date-1)::timestamp AT TIME ZONE 'UTC'+interval '3 hours',CASE WHEN n<4 THEN 'nlh' ELSE 'plo4' END,
 CASE WHEN n<4 THEN 7 ELSE -2 END,1,false,false FROM generate_series(1,6) n;
-- Cash: nlh 3 x 7 = 21, plo4 3 x -2 = -6. Tournament money: nlh +15, plo4 -20.
DO $$ DECLARE d jsonb; s jsonb; BEGIN
 d:=ca_club_member_detail('60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',NULL,NULL);
 s:=ca_club_member_statistics('60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',NULL,NULL,NULL);
 IF (d#>>'{stats,mtt_winnings}')::numeric<>-8000 OR (d#>>'{stats,total_winnings}')::numeric<>15 OR (s->>'net')::numeric<>-7985 THEN
   RAISE EXCEPTION 'Tournament chip baseline changed % %',d->'stats',s->'net'; END IF;
 IF (ca_club_member_win_loss('60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002')#>>'{overall,mtt}')::numeric<>-5 THEN
   RAISE EXCEPTION 'Win/Loss tournament money baseline wrong'; END IF;
 RAISE NOTICE 'REPRODUCED: record MTT -8000 stack chips and statistics net -7985 vs Win/Loss tournament money -5';
END $$;
