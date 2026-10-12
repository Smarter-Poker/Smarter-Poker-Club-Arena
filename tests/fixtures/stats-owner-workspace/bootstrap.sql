CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.ca_hand_facts(hand_id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(hand_id,user_id));
CREATE TABLE public.ca_hand_notes(user_id uuid NOT NULL, hand_id uuid NOT NULL, note text NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}', PRIMARY KEY(user_id,hand_id));
