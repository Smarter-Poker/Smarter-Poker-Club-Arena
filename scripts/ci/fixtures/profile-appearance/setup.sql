CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA realtime;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic',true) $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, avatar_url text, arena_avatar_url text, use_avatar_as_profile_pic boolean, is_vip boolean, vip_expires_at timestamptz, equipped_frame text, equipped_aura text, diamonds numeric DEFAULT 0, private_email text);
CREATE TABLE public.tables(id uuid PRIMARY KEY, readable boolean NOT NULL);
ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_table_access ON public.tables FOR SELECT TO authenticated USING(readable);
CREATE TABLE public.table_seats(table_id uuid, user_id uuid, left_at timestamptz);
CREATE INDEX seat_user_live ON public.table_seats(user_id,table_id) WHERE left_at IS NULL;
CREATE TABLE realtime.messages(extension text);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
INSERT INTO realtime.messages VALUES('broadcast'),('presence');
CREATE TABLE public.deliveries(payload jsonb,event text,topic text,private boolean);
CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('appearance.fail_send',true) = 'yes' THEN RAISE EXCEPTION 'simulated provider outage'; END IF;
 INSERT INTO public.deliveries VALUES(payload,event,topic,private);
END $$;
GRANT USAGE ON SCHEMA public,auth,realtime TO authenticated,anon;
GRANT SELECT ON public.tables TO authenticated;
GRANT SELECT,INSERT ON realtime.messages TO authenticated,anon;
INSERT INTO public.profiles(id,arena_avatar_url) VALUES('aaaaaaaa-1111-2222-3333-444444444444','/before.webp'),('bbbbbbbb-1111-2222-3333-444444444444','/other.webp');
INSERT INTO public.tables VALUES('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',false);
INSERT INTO public.table_seats VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-1111-2222-3333-444444444444',NULL),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','aaaaaaaa-1111-2222-3333-444444444444',now());
