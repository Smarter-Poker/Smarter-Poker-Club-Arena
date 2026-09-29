CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA realtime;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic',true) $$;
CREATE TABLE public.profiles (
 id uuid PRIMARY KEY, username text, display_name text, alias text, first_name text,
 last_name text, full_name text, display_name_preference text, use_real_name boolean,
 bio text, player_tags text[], login_streak integer, vip_tier text, settings jsonb,
 diamonds integer NOT NULL DEFAULT 0, total_hands_played integer DEFAULT 0,
 last_seen timestamptz, horse_status text, private_email text
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_own_profile_read ON public.profiles FOR SELECT TO authenticated USING(id=auth.uid());
CREATE POLICY fixture_own_profile_edit ON public.profiles FOR UPDATE TO authenticated USING(id=auth.uid()) WITH CHECK(id=auth.uid());
GRANT SELECT(id,username,display_name,alias,first_name,last_name,full_name,display_name_preference,use_real_name,bio,player_tags,login_streak,vip_tier,settings,diamonds) ON public.profiles TO authenticated;
GRANT UPDATE(bio,settings) ON public.profiles TO authenticated;
CREATE TABLE realtime.messages(extension text);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
INSERT INTO realtime.messages VALUES('broadcast'),('presence');
CREATE TABLE public.deliveries(payload jsonb,event text,topic text,private boolean);
CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('account.fail_send',true) = 'yes' THEN RAISE EXCEPTION 'simulated provider outage'; END IF;
 INSERT INTO public.deliveries VALUES(payload,event,topic,private);
END $$;
GRANT USAGE ON SCHEMA public,auth,realtime TO authenticated,anon;
GRANT SELECT,INSERT ON realtime.messages TO authenticated,anon;
INSERT INTO public.profiles(id,username,settings) VALUES
('aaaaaaaa-1111-2222-3333-444444444444','first','{"theme":"dark"}'),
('bbbbbbbb-1111-2222-3333-444444444444','second','{"theme":"dark"}');
