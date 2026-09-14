-- A minimal, isolated copy of the production API identity/RLS/grant boundary.
-- Horse social effects use a marker instead of the unrelated content schema.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
$$;
CREATE OR REPLACE FUNCTION public.fn_is_service_context()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
    v_raw_claims text;
    v_jwt_role   text;
BEGIN
    v_raw_claims := current_setting('request.jwt.claims', true);

    IF v_raw_claims IS NOT NULL
       AND btrim(v_raw_claims) <> ''
       AND btrim(v_raw_claims) <> 'null'
    THEN
        BEGIN
            v_jwt_role := v_raw_claims::jsonb ->> 'role';
        EXCEPTION WHEN others THEN
            -- Unparseable claims: fail CLOSED. A malformed JWT must never be
            -- mistaken for "no JWT".
            RETURN false;
        END;

        RETURN v_jwt_role = 'service_role';
    END IF;

    -- No JWT context.
    IF current_user IN ('anon', 'authenticated') THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$function$
;
CREATE TABLE public.profiles (
 id uuid PRIMARY KEY, display_name text, avatar_url text,
 is_horse boolean DEFAULT false,
 horse_profile jsonb DEFAULT '{}'::jsonb,
 horse_status varchar DEFAULT 'available'
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT INSERT, DELETE, REFERENCES, TRIGGER, TRUNCATE ON public.profiles TO authenticated;
GRANT SELECT (id, display_name, avatar_url) ON public.profiles TO authenticated;
GRANT UPDATE (display_name, avatar_url, is_horse, horse_profile, horse_status) ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
CREATE POLICY owner_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY owner_update ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY read_profiles ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE TABLE public.horse_birth_markers (profile_id uuid PRIMARY KEY REFERENCES public.profiles);
CREATE FUNCTION public.fixture_horse_birth() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.is_horse THEN INSERT INTO public.horse_birth_markers VALUES (NEW.id) ON CONFLICT DO NOTHING; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER horse_birth AFTER INSERT OR UPDATE OF is_horse ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.fixture_horse_birth();
-- Deliberately overpowered old RPC: the new row guard must retain JWT authority.
CREATE FUNCTION public.fixture_legacy_profile_write(who uuid, field text, value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF field='is_horse' THEN UPDATE public.profiles SET is_horse=(value#>>'{}')::boolean WHERE id=who;
 ELSIF field='horse_profile' THEN UPDATE public.profiles SET horse_profile=value WHERE id=who;
 ELSE UPDATE public.profiles SET horse_status=value#>>'{}' WHERE id=who; END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.fixture_legacy_profile_write(uuid,text,jsonb) TO authenticated,service_role;
INSERT INTO public.profiles(id,display_name) VALUES ('00000000-0000-4000-8000-000000000001','Owner');
INSERT INTO public.profiles(id,display_name) VALUES ('00000000-0000-4000-8000-000000000002','Other');

