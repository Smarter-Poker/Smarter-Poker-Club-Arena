\set ON_ERROR_STOP on
-- ISOLATED POSTGRES ONLY. Refuse any other database before fixture DDL.
DO $$ BEGIN
 IF current_database()<>'poker_arena_phase2_test' OR inet_server_addr() IS NOT NULL
    OR current_setting('port')<>'55472' THEN
   RAISE EXCEPTION 'This Fixture Requires The Isolated Phase 2 Unix Socket Database';
 END IF;
END $$;
DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA auth;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt()->>'sub','')::uuid $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated,anon,service_role;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, role text DEFAULT 'player');
CREATE TABLE public.clubs(id uuid PRIMARY KEY, club_id integer, slug text, asset text NOT NULL,
 is_platform boolean NOT NULL DEFAULT false, union_id uuid, is_union boolean DEFAULT false,
 lifecycle_status text DEFAULT 'active', chip_treasury numeric DEFAULT 0,chip_pool numeric DEFAULT 0,
 promo_balance numeric DEFAULT 0,insurance_balance numeric DEFAULT 0);
CREATE TABLE public.club_members(club_id uuid REFERENCES clubs,id uuid DEFAULT gen_random_uuid(),user_id uuid,
 role text, status text,chip_balance numeric DEFAULT 0,credit_limit numeric DEFAULT 0,credit_used numeric DEFAULT 0,
 promo_balance numeric DEFAULT 0,held_chips numeric DEFAULT 0,agent_id uuid,parent_agent_id uuid);
CREATE TABLE public.ca_arena_settings(id int PRIMARY KEY,club_id uuid REFERENCES clubs);
CREATE TABLE public.union_clubs(club_id uuid,union_id uuid);
CREATE TABLE public.tables(id uuid PRIMARY KEY,club_id uuid REFERENCES clubs,union_id uuid);
CREATE TABLE public.tournaments(id uuid PRIMARY KEY,club_id uuid REFERENCES clubs,union_id uuid);
CREATE TABLE public.table_seats(id uuid PRIMARY KEY,table_id uuid REFERENCES tables,user_id uuid,stack numeric);
CREATE TABLE public.agents(id uuid,club_id uuid);
CREATE TABLE public.player_agent_assignments(id uuid,club_id uuid);
CREATE TABLE public.agent_commissions(id uuid,club_id uuid);
CREATE FUNCTION public.fn_union_oversees_club(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_can_create_games(p_club_id uuid,p_user_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM public.club_members WHERE club_id=p_club_id AND user_id=p_user_id AND role='owner');
END;
$$;
CREATE FUNCTION public.is_club_admin(p_club_id uuid,p_user_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 RETURN true; -- adversarial old ownership grant; the migration must override Diamond only
END;
$$;
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT coalesce((SELECT role IN ('admin','superadmin','god') FROM public.profiles WHERE id=auth.uid()),false)
$$;
CREATE FUNCTION public.get_club_home(p_club_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 RETURN jsonb_build_object('found',true,'membership',jsonb_build_object('chip_balance',123));
END;
$$;
ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournaments ENABLE ROW LEVEL SECURITY;
CREATE POLICY original_public_tables ON public.tables FOR SELECT USING(true);
CREATE POLICY original_public_tournaments ON public.tournaments FOR SELECT USING(true);
GRANT SELECT ON public.clubs,public.tables,public.tournaments,public.profiles,public.club_members TO authenticated,anon;
INSERT INTO profiles(id) VALUES ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
INSERT INTO clubs(id,club_id,slug,asset,is_platform) VALUES
 ('20000000-0000-4000-8000-000000000001',10001,'shark','chips',false),
 ('20000000-0000-4000-8000-000000000002',10002,'diamond','diamonds',true);
INSERT INTO ca_arena_settings VALUES(1,'20000000-0000-4000-8000-000000000002');
INSERT INTO club_members(club_id,user_id,role,status) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner','active'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','owner','active');
INSERT INTO tables VALUES
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',null),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002',null);
INSERT INTO tournaments SELECT id,club_id,union_id FROM tables;
\ir ../../supabase/migrations/20260908135547_poker_arena_identity_and_access.sql

BEGIN;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE c jsonb; n bigint; BEGIN
 c:=public.fn_poker_arena_context('diamond');
 IF c->>'member'<>'true' OR c->>'role'<>'player' THEN RAISE EXCEPTION 'Automatic membership failed'; END IF;
 c:=public.fn_poker_arena_context('shark');
 IF c->>'member'<>'false' THEN RAISE EXCEPTION 'Unjoined Shark access'; END IF;
 IF public.fn_poker_arena_context('missing') IS NOT NULL THEN RAISE EXCEPTION 'Unknown identity accepted'; END IF;
 SELECT count(*) INTO n FROM public.tables; IF n<>1 THEN RAISE EXCEPTION 'Outsider table scope: %',n; END IF;
 SELECT count(*) INTO n FROM public.tournaments; IF n<>1 THEN RAISE EXCEPTION 'Outsider tournament scope: %',n; END IF;
 IF public.get_club_home('shark')->>'reason' IS DISTINCT FROM 'membership_required' THEN RAISE EXCEPTION 'Aggregate lobby leaked to outsider'; END IF;
 IF public.get_club_home('diamond') ? 'membership' OR public.get_club_home('diamond')->>'access_only' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Diamond aggregate inherited chip membership'; END IF;
 RAISE NOTICE 'PASS: Automatic membership, player role, unjoined Shark denial, unknown identity, table and tournament RLS, aggregate lobby boundaries (8)';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE n bigint; BEGIN
 SELECT count(*) INTO n FROM public.tables;IF n<>2 THEN RAISE EXCEPTION 'Joined chip club lost access';END IF;
 IF NOT public.fn_can_create_games('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'Chip owner lost management';END IF;
 IF public.fn_can_create_games('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'Inherited Diamond ownership';END IF;
 IF public.is_club_admin('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'Diamond club-admin grant inherited'; END IF;
 IF NOT public.is_club_admin('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'Chip club-admin grant lost'; END IF;
 IF public.get_club_home('shark')->'membership'->>'chip_balance' IS DISTINCT FROM '123' THEN RAISE EXCEPTION 'Joined chip aggregate changed'; END IF;
 RAISE NOTICE 'PASS: Joined chip access and management preserved; Diamond club grants denied, joined aggregate preserved (6)';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
SET LOCAL ROLE anon;
DO $$ DECLARE n bigint; BEGIN
 SELECT count(*) INTO n FROM public.tables;IF n<>0 THEN RAISE EXCEPTION 'Anonymous game access';END IF;
 BEGIN PERFORM public.fn_poker_arena_context('diamond');RAISE EXCEPTION 'Anonymous RPC allowed';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 RAISE NOTICE 'PASS: Anonymous table access and RPC denied (2)';
END $$;
RESET ROLE;
DO $$ DECLARE diamond uuid:='20000000-0000-4000-8000-000000000002'; n bigint; BEGIN
 SELECT count(*) INTO n FROM public.club_members WHERE club_id=diamond AND role='player' AND status='automatic';
 IF n<>1 THEN RAISE EXCEPTION 'Legacy membership transition failed';END IF;
 BEGIN UPDATE public.clubs SET chip_treasury=1 WHERE id=diamond;RAISE EXCEPTION 'Diamond chip treasury accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE public.clubs SET asset='chips',is_platform=false WHERE id=diamond;RAISE EXCEPTION 'Asset conversion accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE public.club_members SET chip_balance=1 WHERE club_id=diamond;RAISE EXCEPTION 'Chip wallet accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE public.club_members SET role='agent' WHERE club_id=diamond;RAISE EXCEPTION 'Agent role accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE public.club_members SET status='active' WHERE club_id=diamond;RAISE EXCEPTION 'Private membership accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN INSERT INTO public.union_clubs VALUES(diamond,gen_random_uuid());RAISE EXCEPTION 'Union accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN INSERT INTO public.agents VALUES(gen_random_uuid(),diamond);RAISE EXCEPTION 'Agent row accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN INSERT INTO public.agent_commissions VALUES(gen_random_uuid(),diamond);RAISE EXCEPTION 'Commission accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN UPDATE public.tables SET club_id=diamond WHERE id='30000000-0000-4000-8000-000000000001';RAISE EXCEPTION 'Game asset change accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 BEGIN INSERT INTO public.table_seats VALUES(gen_random_uuid(),'30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',1);RAISE EXCEPTION 'Unfunded Diamond seat accepted';EXCEPTION WHEN check_violation THEN NULL;END;
 INSERT INTO public.table_seats VALUES(gen_random_uuid(),'30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1);
 RAISE NOTICE 'PASS: Historical row retained, ten Diamond mutation denials, chip seating preserved (12)';
END $$;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
DO $$ BEGIN
 BEGIN UPDATE public.clubs SET slug=slug WHERE asset='diamonds'; RAISE EXCEPTION 'Player managed Diamond identity'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.tables SET union_id=null WHERE club_id='20000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'Player managed Diamond table'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE public.profiles SET role='admin' WHERE id=auth.uid();
 UPDATE public.clubs SET slug=slug WHERE asset='diamonds';
 UPDATE public.tables SET union_id=null WHERE club_id='20000000-0000-4000-8000-000000000002';
 RAISE NOTICE 'PASS: Player management denied, platform staff updates allowed (4)';
END $$;
ROLLBACK;
\echo PHASE2_LOCAL_SQL_PASS_32_ASSERTIONS
