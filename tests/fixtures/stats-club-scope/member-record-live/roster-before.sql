-- Isolated real reader fixture; no live player/club IDs or money writes.
ALTER TABLE profiles ADD COLUMN is_admin boolean DEFAULT false;
ALTER TABLE clubs ADD COLUMN union_id uuid, ADD COLUMN is_union boolean DEFAULT false;
ALTER TABLE club_members ADD COLUMN last_active_at timestamptz;
CREATE TABLE union_clubs(union_id uuid,club_id uuid);
CREATE TABLE fixture_union_staff(club_id uuid,user_id uuid);
CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM fixture_union_staff WHERE club_id=$1 AND user_id=$2) $$;
CREATE TABLE club_roster_hand_totals(club_id uuid,user_id uuid,hands bigint);
ALTER TABLE ca_club_rake_daily_user ADD COLUMN rake_cents bigint DEFAULT 0;
ALTER TABLE ca_club_member_tournament_fee_daily ADD COLUMN fees numeric DEFAULT 0;
CREATE FUNCTION ca_club_member_fee_totals(p_club_id uuid) RETURNS TABLE(user_id uuid,cash_fees numeric,tournament_fees numeric,total_fees numeric)
LANGUAGE sql STABLE AS $$
 WITH c AS (SELECT user_id,sum(rake_cents)::numeric/100 fees FROM ca_club_rake_daily_user WHERE club_id=p_club_id GROUP BY user_id),
 m AS (SELECT user_id,sum(fees) fees FROM ca_club_member_tournament_fee_daily WHERE club_id=p_club_id GROUP BY user_id)
 SELECT coalesce(c.user_id,m.user_id),coalesce(c.fees,0),coalesce(m.fees,0),coalesce(c.fees,0)+coalesce(m.fees,0) FROM c FULL JOIN m USING(user_id)
$$;
ALTER TABLE signals ADD COLUMN event text, ADD COLUMN private boolean;
CREATE OR REPLACE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.signals VALUES(topic,payload,event,private) $$;
\ir roster-scope-preimage.sql
\ir roster-preimage.sql
\ir roster-arena-name.sql
SELECT set_config('test.cutoff','',false),set_config('test.viewer','30000000-0000-0000-0000-000000000002',false);
INSERT INTO clubs(id,name,is_union) VALUES('30000000-0000-0000-0000-000000000001','Funded',false),('40000000-0000-0000-0000-000000000001','Physical',false),('50000000-0000-0000-0000-000000000001','Union',true);
UPDATE clubs SET union_id='50000000-0000-0000-0000-000000000001' WHERE id='30000000-0000-0000-0000-000000000001';
INSERT INTO union_clubs VALUES('50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001');
INSERT INTO profiles(id,alias,username,status,last_seen) VALUES
('30000000-0000-0000-0000-000000000002','Owner','owner','active',now()),
('30000000-0000-0000-0000-000000000003','Player','player','active',now()),
('30000000-0000-0000-0000-000000000009','Outsider','outsider','active',now());
INSERT INTO profiles(id,alias,username,display_name,first_name,last_name,full_name,status) VALUES
('30000000-0000-0000-0000-000000000004',NULL,'PokerHandle','Real Name','Real','Name','Real Name','active'),
('30000000-0000-0000-0000-000000000006',NULL,NULL,'ScreenHandle','Real','Name','Real Name','active'),
('30000000-0000-0000-0000-000000000007',NULL,NULL,'Real Name','Real','Name','Real Name','active');
INSERT INTO club_members(user_id,club_id,role,status,joined_at,chip_balance,promo_balance)
SELECT u,club,CASE WHEN u='30000000-0000-0000-0000-000000000002'::uuid THEN 'owner' ELSE 'player' END,'active',now(),100,5
FROM unnest(ARRAY['30000000-0000-0000-0000-000000000002'::uuid,'30000000-0000-0000-0000-000000000003'::uuid]) u
CROSS JOIN unnest(ARRAY['30000000-0000-0000-0000-000000000001'::uuid,'40000000-0000-0000-0000-000000000001'::uuid]) club;
INSERT INTO club_members(user_id,club_id,role,status,joined_at)
SELECT u,'30000000-0000-0000-0000-000000000001','agent','active',now()
FROM unnest(ARRAY['30000000-0000-0000-0000-000000000004'::uuid,'30000000-0000-0000-0000-000000000006'::uuid,'30000000-0000-0000-0000-000000000007'::uuid]) u;
UPDATE club_members SET agent_id='30000000-0000-0000-0000-000000000004' WHERE user_id='30000000-0000-0000-0000-000000000003' AND club_id='30000000-0000-0000-0000-000000000001';
INSERT INTO cash_participant_funding_receipts VALUES('30000000-0000-0000-0000-000000000005','buyin','30000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',now()-interval '1 hour',now());
INSERT INTO ca_hand_facts(hand_id,user_id,club_id,table_id,played_at,game_variant,net,rake_paid)
SELECT ('30000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'30000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000004',now(),'nlh',-1,0 FROM generate_series(10,21) n;
INSERT INTO club_roster_hand_totals VALUES('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003',12);
INSERT INTO ca_club_rake_daily_user VALUES('30000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',1655);
TRUNCATE signals;
UPDATE club_members SET last_active_at=clock_timestamp() WHERE user_id='30000000-0000-0000-0000-000000000003';
DO $$ DECLARE n bigint; BEGIN
 SELECT total_hands INTO n FROM ca_club_roster_rows('30000000-0000-0000-0000-000000000001') WHERE user_id='30000000-0000-0000-0000-000000000003';
 IF n<>0 THEN RAISE EXCEPTION 'Roster baseline changed %',n; END IF;
 IF (SELECT sum(hands) FROM ca_member_record_daily_facts('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003',NULL,NULL))<>12 THEN RAISE EXCEPTION 'Funded baseline wrong'; END IF;
 IF EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'club-roster:%') THEN RAISE EXCEPTION 'Roster event baseline changed'; END IF;
 IF (ca_club_member_detail('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003',NULL,NULL)#>>'{identity,last_login}')::timestamptz >= (SELECT last_active_at FROM club_members WHERE club_id='30000000-0000-0000-0000-000000000001' AND user_id='30000000-0000-0000-0000-000000000003') THEN RAISE EXCEPTION 'Membership activity baseline no longer stale'; END IF;
 RAISE NOTICE 'REPRODUCED: roster0 vs funded record12, no roster invalidation';
 IF (SELECT alias FROM ca_club_roster_rows('30000000-0000-0000-0000-000000000001') WHERE user_id='30000000-0000-0000-0000-000000000004')='PokerHandle' THEN RAISE EXCEPTION 'Identity mismatch baseline changed'; END IF;
END $$;
