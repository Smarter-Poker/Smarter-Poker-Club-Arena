-- Small native catalog boundary; the three repaired functions below are
-- byte-exact installed preimages, not stand-in implementations.
CREATE ROLE postgres; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '11111111-1111-4111-a111-111111111111'::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
CREATE TABLE cash_games(id uuid PRIMARY KEY,club_id uuid,template_name text,ruleset_snapshot jsonb,lightning_enabled boolean DEFAULT false,cluster_mode text DEFAULT 'must_move',cluster_epoch integer DEFAULT 1,handedness integer DEFAULT 6,enabled boolean DEFAULT true,must_move boolean DEFAULT true,updated_at timestamptz);
CREATE TABLE lightning_hand(hand_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cluster_id uuid,cluster_epoch integer,lightning_instance_id uuid,player_count integer,request_id uuid);
CREATE TABLE lightning_operator_request(request_id uuid PRIMARY KEY,cluster_id uuid,action text,actor uuid,actor_kind text,reason text,args jsonb,answer jsonb);
CREATE TABLE lightning_cluster_drain(cluster_id uuid,completed_at timestamptz);
CREATE TABLE lightning_cluster_control(cluster_id uuid,paused_from text);
CREATE TABLE lightning_pool_session(cluster_id uuid,cluster_epoch integer,exited_at timestamptz);
CREATE TABLE cash_cluster_epoch(cluster_id uuid,epoch integer,ended_at timestamptz);
-- Only surrounding authorization/state/config surfaces are fixture boundaries;
-- no economic or gameplay body is substituted or invoked.
CREATE FUNCTION fn_lightning_operator_may_control(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_user<>'anon' $$;
CREATE FUNCTION fn_is_platform_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION fn_lightning_operator_state(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION fn_lightning_config(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"matcher_versions_disabled":[]}'::jsonb $$;
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
GRANT USAGE ON SCHEMA auth TO authenticated,service_role,anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated,service_role,anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
INSERT INTO cash_games(id,club_id,template_name,ruleset_snapshot) SELECT ('00000000-0000-4000-a000-'||lpad(n::text,12,'0'))::uuid,'11111111-1111-4111-a111-111111111111',t,jsonb_build_object('template',t) FROM (VALUES(1,'classic'),(2,'action'),(3,'madness'),(4,'unknown'),(5,NULL))x(n,t);


INSERT INTO cash_games(id,club_id,template_name,ruleset_snapshot) VALUES('00000000-0000-4000-a000-000000000006','11111111-1111-4111-a111-111111111111','classic','{"template":"action"}');
-- Readiness surroundings deliberately have NO A/A or latency evidence. These
-- helpers are only read surfaces; this fixture must never claim readiness GO.
CREATE TABLE clubs(id uuid PRIMARY KEY,is_public boolean);
INSERT INTO clubs VALUES('11111111-1111-4111-a111-111111111111',false);
CREATE FUNCTION fn_lightning_operator_may(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_user<>'anon' $$;
CREATE FUNCTION fn_lightning_operator_cluster_row(uuid,timestamptz) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION fn_lightning_shadow_report(uuid,timestamptz,timestamptz) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"version_pairs":[]}'::jsonb $$;
CREATE FUNCTION fn_lightning_operator_redact(jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT $1 $$;
-- Catalog-only structural census dependencies. They are never called here;
-- unrelated readiness structural evidence deliberately remains not passing.
CREATE FUNCTION fn_lightning_player_legality(uuid,timestamptz,uuid[],jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION fn_lightning_match(uuid,timestamptz,uuid[],text,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION fn_lightning_match_and_form(uuid,timestamptz,uuid[],integer,uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION fn_cash_clusters_tick_all(jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
GRANT SELECT ON clubs TO authenticated,service_role;

INSERT INTO cash_games(id,club_id,template_name,ruleset_snapshot) VALUES
('00000000-0000-4000-a000-000000000007','11111111-1111-4111-a111-111111111111','action','{"template":"classic"}'),
('00000000-0000-4000-a000-000000000008','11111111-1111-4111-a111-111111111111','madness','{}'),
('00000000-0000-4000-a000-000000000009','11111111-1111-4111-a111-111111111111',NULL,'{"template":"action"}');
