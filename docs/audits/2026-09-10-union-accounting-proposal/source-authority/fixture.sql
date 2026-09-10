-- ISOLATED PG17 ONLY. This is a helper/admission and real commission-trigger
-- fixture. It does not claim the full accepted stack/journal owner dependency graph.
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
ALTER TABLE public.agents ADD COLUMN player_rakeback_rate numeric DEFAULT .10;
ALTER TABLE public.club_members ADD COLUMN player_rakeback_pct numeric DEFAULT 0;
ALTER TABLE public.club_members ADD COLUMN role text DEFAULT 'player';
ALTER TABLE public.club_members ADD COLUMN status text DEFAULT 'active';
ALTER TABLE public.club_members ADD COLUMN membership_lifecycle_status text DEFAULT 'active';
ALTER TABLE public.table_seats ADD COLUMN id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.table_seats ADD COLUMN joined_at timestamptz DEFAULT '2026-09-10 00:00:00Z';
ALTER TABLE public.clubs ADD COLUMN asset text DEFAULT 'chips';
CREATE TABLE public.hand_atomic_commits (
 hand_id uuid PRIMARY KEY,table_id uuid,hand_number bigint,
 post_commit_payload jsonb,post_commit_payload_hash text,committed_at timestamptz DEFAULT clock_timestamp()
);
CREATE TABLE public.rake_records (
 hand_id uuid,table_id uuid,club_id uuid,rake_amount numeric,is_tournament boolean DEFAULT false,
 tournament_id uuid,source text DEFAULT 'atomic_distribute_rake',rake_method text DEFAULT 'WEIGHTED_CONTRIBUTED',
 player_contributions jsonb,returned_uncalled jsonb DEFAULT '{}'::jsonb
);
CREATE TABLE public.agent_commission_unsettled_rollup (
 club_id uuid,user_id uuid,owed numeric,rows_behind bigint,oldest_unsettled timestamptz,updated_at timestamptz,
 PRIMARY KEY(club_id,user_id)
);
CREATE TABLE public.ca_club_commission_daily (
 club_id uuid,stat_date date,amount numeric,rows_counted bigint,updated_at timestamptz,PRIMARY KEY(club_id,stat_date)
);
CREATE TABLE public.agent_commission_settlements (club_id uuid,user_id uuid,period_start timestamptz,period_end timestamptz);
INSERT INTO public.table_seats(table_id,user_id,club_id,id)
 SELECT '00000000-0000-4000-8000-000000000950',user_id,club_id,
   ('00000000-0000-4000-8000-'||lpad((700+row_number() OVER(ORDER BY user_id))::text,12,'0'))::uuid
 FROM public.club_members;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;
CREATE TABLE public.test_checks(name text PRIMARY KEY,passed boolean);
CREATE FUNCTION public.test_assert(p_name text,p_pass boolean) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF p_pass IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %',p_name; END IF;
 INSERT INTO test_checks VALUES(p_name,true); END $f$;
CREATE FUNCTION public.test_refuses(p_name text,p_sql text,p_message text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_failed boolean:=false;v_message text;
BEGIN
 BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
  IF position(p_message IN v_message)=0 THEN RAISE EXCEPTION 'Unexpected refusal for %: %',p_name,v_message; END IF;
  v_failed:=true;
 END;
 PERFORM test_assert(p_name,v_failed);
END $f$;
CREATE FUNCTION public.test_accept(p_id uuid,p_amount numeric DEFAULT 200,p_contrib jsonb DEFAULT
 '{"00000000-0000-4000-8000-000000000201":100,"00000000-0000-4000-8000-000000000202":100}'::jsonb,
 p_stacks jsonb DEFAULT NULL,p_hash_bad boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_payload jsonb;v_stacks jsonb;
BEGIN
 v_payload:=jsonb_build_object('rake',jsonb_build_object('club_id','00000000-0000-4000-8000-000000000900',
  'amount',p_amount,'contributions',p_contrib,'method','WEIGHTED_CONTRIBUTED','returned_uncalled','{}'::jsonb),
  'accepted_hand_facts',jsonb_build_object('contributions',p_contrib));
 IF p_stacks IS NULL THEN
  SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at)) INTO v_stacks
   FROM public.table_seats WHERE table_id='00000000-0000-4000-8000-000000000950';
 ELSE v_stacks:=p_stacks; END IF;
 INSERT INTO public.hand_atomic_commits(hand_id,table_id,hand_number,post_commit_payload,post_commit_payload_hash)
 VALUES(p_id,'00000000-0000-4000-8000-000000000950',1,v_payload,
  CASE WHEN p_hash_bad THEN 'bad' ELSE encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex') END);
 PERFORM public.fn_ca_capture_cash_commission_source(p_id,v_stacks);
END $f$;
CREATE FUNCTION public.test_bank(p_id uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
 INSERT INTO public.rake_records(hand_id,table_id,club_id,rake_amount,player_contributions,returned_uncalled)
 SELECT hand_id,table_id,requested_club_id,rake_total,contributions,returned_uncalled
 FROM public.ca_cash_commission_sources WHERE hand_id=p_id;
END $f$;
CREATE FUNCTION public.test_accrue(p_id uuid,p_player uuid DEFAULT '00000000-0000-4000-8000-000000000201',
 p_credit numeric DEFAULT 100) RETURNS void LANGUAGE sql AS $f$
 SELECT public.credit_agent_commission_from_rake(p_player,'00000000-0000-4000-8000-000000000900',
 p_credit,'rake_settlement',p_id,'isolated source proof');
$f$;
