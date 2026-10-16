-- Isolated PostgreSQL ground for the actual cash_games_read policy.
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE public.club_members(club_id uuid,user_id uuid,status text);
CREATE TABLE public.cash_games(id uuid PRIMARY KEY,club_id uuid,ruleset_snapshot jsonb);
ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_membership ON public.club_members TO authenticated USING(user_id=auth.uid());
ALTER TABLE public.cash_games ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
GRANT SELECT ON public.clubs,public.club_members,public.cash_games TO authenticated,service_role;
INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
INSERT INTO cash_games VALUES
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','{"options":{"is_private":true}}'),
 ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','{"options":{"is_private":false}}'),
 ('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','{}');
INSERT INTO club_members
 SELECT '10000000-0000-0000-0000-000000000001',('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,status
 FROM (VALUES(2,'active'),(3,'approved'),(4,'pending'),(5,'removed'),(6,'banned'),(7,'suspended'),(8,NULL)) x(n,status);
-- Load the original maintained policy, not a hand-written approximation.
\set baseline :baseline
\i :baseline
CREATE SCHEMA witness;
GRANT USAGE ON SCHEMA witness TO authenticated;
CREATE FUNCTION witness.assert_private_hidden() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.cash_games WHERE id='30000000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'private game exposed to pending membership'; END IF;
END $$;
CREATE FUNCTION witness.assert_all() RETURNS void LANGUAGE plpgsql AS $$
DECLARE n integer; got integer; expected integer;
BEGIN
 FOR n IN 1..9 LOOP
  PERFORM set_config('request.jwt.claim.sub','20000000-0000-0000-0000-'||lpad(n::text,12,'0'),true);
  SELECT count(*) INTO got FROM public.cash_games WHERE id='30000000-0000-0000-0000-000000000001';
  expected:=CASE WHEN n IN(1,2,3) THEN 1 ELSE 0 END;
  IF got<>expected THEN RAISE EXCEPTION 'private actor %: got %, expected %',n,got,expected; END IF;
  SELECT count(*) INTO got FROM public.cash_games WHERE id<>'30000000-0000-0000-0000-000000000001';
  IF got<>2 THEN RAISE EXCEPTION 'public behavior changed for actor %',n; END IF;
 END LOOP;
 PERFORM set_config('request.jwt.claim.sub','',true);
 IF (SELECT count(*) FROM public.cash_games)<>2 THEN RAISE EXCEPTION 'null identity private visibility'; END IF;
END $$;
