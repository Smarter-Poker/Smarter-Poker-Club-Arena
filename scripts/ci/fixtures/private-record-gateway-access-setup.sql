CREATE SCHEMA auth;
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE TABLE public.ca_private_record_transport_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),supabase_enabled boolean NOT NULL DEFAULT true,source_fingerprints jsonb NOT NULL DEFAULT '{}');
CREATE FUNCTION public.gateway_source_one() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION public.gateway_source_two() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION public.gateway_source_three() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION public.gateway_source_four() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION public.gateway_source_five() RETURNS void LANGUAGE sql AS $$SELECT$$;
INSERT INTO public.ca_private_record_transport_state(singleton,source_fingerprints)
SELECT true,jsonb_object_agg(signature,md5(pg_get_functiondef(signature::regprocedure)))
FROM unnest(ARRAY['public.gateway_source_one()','public.gateway_source_two()','public.gateway_source_three()','public.gateway_source_four()','public.gateway_source_five()']) signature;
