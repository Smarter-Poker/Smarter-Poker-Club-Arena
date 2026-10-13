CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE TABLE public.cash_player_session(player_id uuid,scope_type text,scope_id uuid,closed_at timestamptz,opened_at timestamptz,baseline numeric);
CREATE TABLE public.poker_diamond_custody(id uuid,user_id uuid,arena_id uuid,purpose text,target_id uuid,entry_key text,balance bigint,state text,created_at timestamptz,released_at timestamptz,seat_id uuid,seat_joined_at timestamptz,occupancy_id uuid);
CREATE TABLE public.poker_diamond_movements(request_id uuid,custody_id uuid,user_id uuid,action text,amount bigint,receipt jsonb,created_at timestamptz);
CREATE TABLE public.hand_history(id uuid,table_id uuid,created_at timestamptz,started_at timestamptz,ended_at timestamptz,hand_number bigint,players jsonb,pot_size numeric);
CREATE TABLE public.ca_hand_facts(hand_id uuid,user_id uuid,table_id uuid,played_at timestamptz,invested numeric,returned numeric,net numeric,vpip boolean);
CREATE TABLE public.cash_seat_move_receipts(move_id uuid,player_id uuid,game_id uuid,club_id uuid,from_table_id uuid,source_occupancy_id uuid,to_table_id uuid,destination_occupancy_id uuid,created_at timestamptz);
CREATE TABLE public.poker_diamond_hand_receipts(table_id uuid,hand_number bigint,request jsonb,receipt jsonb,created_at timestamptz);

INSERT INTO poker_diamond_custody VALUES
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','cash_seat','00000000-0000-4000-8000-000000000004','fixture',1500,'active','2026-10-12 05:00Z',NULL,'00000000-0000-4000-8000-000000000005','2026-10-12 05:00Z','00000000-0000-4000-8000-000000000006');
INSERT INTO poker_diamond_movements VALUES
('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','reserve',1000,'{"stack":1000}', '2026-10-12 05:00Z'),
('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','reserve',500,'{"stack":1400}', '2026-10-12 05:02Z');
INSERT INTO hand_history
 SELECT ('00000000-0000-4000-8000-0000000000' || n)::uuid,'00000000-0000-4000-8000-000000000004',t::timestamptz,t::timestamptz,t::timestamptz,1000000+n,
 jsonb_build_array(jsonb_build_object('userId','00000000-0000-4000-8000-000000000002','stack',s)),200
 FROM (VALUES (21,'2026-10-12 05:01Z',900),(22,'2026-10-12 05:03Z',1350),(23,'2026-10-12 05:04Z',1500)) x(n,t,s);
INSERT INTO ca_hand_facts
 SELECT h.id,'00000000-0000-4000-8000-000000000002',h.table_id,h.created_at,i,r,r-i,v
 FROM hand_history h JOIN (VALUES (1000021,100,0,false),(1000022,50,0,true),(1000023,50,200,true)) x(n,i,r,v) ON h.hand_number=x.n;
CREATE TABLE public.poker_diamond_jackpot_ledger(id bigint,kind text,amount bigint,table_id uuid,hand_number bigint,recipient_user_id uuid,wallet_journal_id uuid);
CREATE TABLE public.notifications(id uuid PRIMARY KEY,user_id uuid,type text,title text,message text,metadata jsonb,read boolean DEFAULT false);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON public.notifications TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated;
CREATE POLICY own_read ON public.notifications FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY service_insert ON public.notifications FOR INSERT TO service_role WITH CHECK(true);
CREATE FUNCTION public.fixture_refuse_notification_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'notification_update_is_forbidden'; END $$;
CREATE TRIGGER fixture_never_update BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.fixture_refuse_notification_update();

