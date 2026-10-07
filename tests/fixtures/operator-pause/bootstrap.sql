CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
CREATE TABLE public.clubs(id uuid PRIMARY KEY,asset text);
CREATE TABLE public.tables(id uuid PRIMARY KEY,club_id uuid,union_id uuid,status text,tournament_id uuid);
CREATE TABLE public.profiles(id uuid PRIMARY KEY,role text);
CREATE TABLE public.club_members(club_id uuid,user_id uuid,role text);
CREATE TABLE public.unions(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE public.union_admins(union_id uuid,user_id uuid);
CREATE TABLE public.union_clubs(union_id uuid,club_id uuid);
INSERT INTO public.clubs VALUES ('11111111-1111-4111-8111-111111111111','chips'),('22222222-2222-4222-8222-222222222222','diamonds');
INSERT INTO public.tables VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',NULL,'running',NULL),('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222',NULL,'running',NULL);
INSERT INTO public.club_members VALUES ('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555','co_owner');
INSERT INTO public.profiles VALUES ('55555555-5555-4555-8555-555555555555','user'),('66666666-6666-4666-8666-666666666666','god');

CREATE TABLE public.engine_table_leases(table_id uuid PRIMARY KEY,instance_id text,lease_generation uuid,protocol_version integer,heartbeat_at timestamptz);
CREATE TABLE public.engine_tournament_leases(tournament_id uuid PRIMARY KEY,instance_id text,lease_generation uuid,protocol_version integer,heartbeat_at timestamptz);
CREATE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 30 $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
ALTER TABLE public.clubs ADD COLUMN union_id uuid;
ALTER TABLE public.tables ADD COLUMN name text DEFAULT 'Owned table', ADD COLUMN game_variant text,
 ADD COLUMN current_players integer DEFAULT 0, ADD COLUMN max_players integer DEFAULT 6,
 ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now(),
 ADD COLUMN small_blind numeric, ADD COLUMN big_blind numeric, ADD COLUMN min_buy_in numeric,
 ADD COLUMN max_buy_in numeric, ADD COLUMN is_deleted boolean DEFAULT false;
CREATE TABLE public.tournaments(id uuid,club_id uuid,union_id uuid,name text,status text,
 game_type text,variant text,current_players integer,max_players integer,start_time timestamptz,
 created_at timestamptz,updated_at timestamptz,buy_in_amount numeric,format_contract text);
CREATE TABLE public.managed_game_schedules(schedule_id uuid,execute_at timestamptz,status text,game_kind text,game_id uuid,created_at timestamptz);
CREATE TABLE public.managed_game_contract_versions(game_kind text,game_id uuid,version integer,contract_hash text,published_at timestamptz,published_by uuid,change_reason text);
CREATE TABLE public.managed_game_command_receipts(game_kind text,game_id uuid,command_id uuid,command_action text,status text,contract_version_before integer,contract_version_after integer,created_at timestamptz,completed_at timestamptz);
CREATE TABLE public.table_seats(table_id uuid,left_at timestamptz);
CREATE FUNCTION public.fn_game_creation_access(p_club_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('allowed',EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id AND m.user_id=auth.uid() AND m.role IN ('owner','co_owner','admin','super_agent')),'union_id',(SELECT union_id FROM public.clubs WHERE id=p_club_id)) $$;
CREATE FUNCTION public.fn_is_union_operator(p_union_id uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.unions WHERE id=p_union_id AND owner_id=p_actor) OR EXISTS(SELECT 1 FROM public.union_admins WHERE union_id=p_union_id AND user_id=p_actor) $$;
CREATE FUNCTION public.fn_tournament_management_readiness(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"state":"ready","contract_locked":false}'::jsonb $$;
CREATE TABLE public.game_management_events(event_type text,scope_kind text,scope_id uuid,club_id uuid,union_id uuid,recipient_id uuid,entity_type text,entity_id uuid,command_id uuid,actor_id uuid,payload jsonb);
CREATE FUNCTION public.fn_game_management_scope(p_club_id uuid) RETURNS TABLE(scope_kind text,scope_id uuid,union_id uuid) LANGUAGE sql STABLE AS $$ SELECT CASE WHEN c.union_id IS NULL THEN 'club' ELSE 'union' END,coalesce(c.union_id,c.id),c.union_id FROM public.clubs c WHERE c.id=p_club_id $$;
