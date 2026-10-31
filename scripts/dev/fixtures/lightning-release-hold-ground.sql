-- Extend the existing native boundary only with the rows touched by pause/resume.
-- The operator body is the exact current production image, not a substitute.
-- Subordinate auth/state/config context is selected and inert; exercised games are
-- MUST-MOVE, with no pool entry, live Lightning hand or economic settlement.
-- This is not full live-hand qualification; the owning Phase13 driver still runs
-- its unchanged full native chain after this focused RPC boundary.
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
CREATE OR REPLACE FUNCTION fn_lightning_operator_may_control(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(auth.role(),'') IN ('authenticated','service_role') $$;
ALTER TABLE cash_games ADD COLUMN variant text DEFAULT 'nlh';
ALTER TABLE lightning_cluster_drain ADD COLUMN id uuid DEFAULT gen_random_uuid();
ALTER TABLE lightning_cluster_control ADD PRIMARY KEY(cluster_id), ADD COLUMN paused_at timestamptz, ADD COLUMN paused_by uuid, ADD COLUMN paused_reason text, ADD COLUMN paused_request_id uuid, ADD COLUMN updated_at timestamptz;
CREATE TABLE lightning_instance(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cluster_id uuid,state text);
CREATE TABLE cash_cluster_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid,kind text,payload jsonb,request_id uuid);
-- Actual production template/size/variant predicates from maintained migrations.
CREATE FUNCTION public.fn_lightning_template_allowed(p_template text,p_rules jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$ SELECT coalesce(p_template IN ('action','madness') AND p_rules->>'template'=p_template,false) $fn$;
CREATE FUNCTION public.fn_lightning_table_size_allowed(p_handedness integer) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'pg_catalog' AS $function$ SELECT coalesce(p_handedness = 6, false) $function$;
CREATE FUNCTION public.fn_lightning_variant_allowed(p_variant text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$ SELECT coalesce(lower(p_variant) NOT IN
  ('short_deck','shortdeck','flo8','plo8','omaha8','o8','pineapple','pineapple_holdem'), false) $fn$;
-- No lightning hands exist or pool entry occurs in the MUST-MOVE cases here.
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA auth TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO postgres;
