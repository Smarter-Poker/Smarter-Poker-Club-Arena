CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.profiles(id integer PRIMARY KEY, referral_code text, display_name text DEFAULT 'unchanged');
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING(true);
CREATE POLICY profiles_insert_self ON public.profiles FOR INSERT TO authenticated
 WITH CHECK(id=current_setting('test.profile_id')::integer);
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
 USING(id=current_setting('test.profile_id')::integer) WITH CHECK(id=current_setting('test.profile_id')::integer);
GRANT SELECT,INSERT,UPDATE ON public.profiles TO authenticated,service_role;
CREATE INDEX idx_profiles_referral_code ON public.profiles(referral_code) WHERE referral_code IS NOT NULL;
CREATE OR REPLACE FUNCTION public.generate_referral_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    new_code VARCHAR(20);
    is_unique BOOLEAN := false;
BEGIN
    IF NEW.referral_code IS NULL THEN
        WHILE NOT is_unique LOOP
            new_code := 'SP-' || SUBSTRING(MD5(RANDOM()::TEXT), 1, 6);
            PERFORM 1 FROM public.profiles WHERE referral_code = new_code;
            IF NOT FOUND THEN
                is_unique := true;
            END IF;
        END LOOP;
        NEW.referral_code := UPPER(new_code);
    END IF;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.generate_referral_code() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.generate_referral_code() TO service_role;
CREATE TRIGGER tr_generate_referral_code BEFORE INSERT ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.generate_referral_code();
