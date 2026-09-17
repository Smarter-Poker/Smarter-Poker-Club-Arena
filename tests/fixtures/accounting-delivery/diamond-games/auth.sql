-- Synthetic session identity only; not a production authentication/signup test.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT COALESCE(NULLIF(current_setting('test.user',true),''),
                 NULLIF(current_setting('request.jwt.claim.sub',true),''),
                 NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb,
                 jsonb_build_object('sub',auth.uid(),'role','authenticated'));
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role');
$$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;

