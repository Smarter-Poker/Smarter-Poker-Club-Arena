CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.club_members(user_id uuid,club_id uuid,chip_balance numeric);
CREATE TABLE public.chip_ledger(to_entity_id uuid,from_entity_id uuid,to_type text,from_type text,status text,created_at timestamptz,club_id uuid,amount numeric);
CREATE FUNCTION public.fn_diamond_arena_club() RETURNS uuid LANGUAGE sql AS $$SELECT 'dddddddd-0000-0000-0000-000000000000'::uuid$$;
CREATE FUNCTION public.fn_sp_digest_player_totals(p_day date) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('day',p_day,'players',jsonb_build_array(jsonb_build_object('user_id','aaaaaaaa-0000-0000-0000-000000000001','username','fixture','net',1.25,'cash_net',1,'tournament_net',0.25,'cash_rake',0.1,'tournament_rake',0.2,'hands',10,'minutes',5)),'totals',jsonb_build_object('players',1,'hands',10))$$;
INSERT INTO public.club_members VALUES ('aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',100);
