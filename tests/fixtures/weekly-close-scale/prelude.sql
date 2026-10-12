-- Native harness prelude: the platform objects the captured tables and
-- functions name that are not part of this change. Every stub is the same for
-- the original (preimage) and the changed functions, so a comparison between
-- them measures only the change.
SET client_min_messages=warning;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role',true),'') $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
CREATE FUNCTION public.fn_ca_current_epoch() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 3 $$;
CREATE FUNCTION public.fn_ca_house_board_allows_automation(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
