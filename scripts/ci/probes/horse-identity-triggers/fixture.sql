-- Exact reviewed production trigger functions, with isolated identity tables.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, is_horse boolean DEFAULT false, display_name text);
CREATE TABLE public.club_members(id integer PRIMARY KEY, user_id uuid REFERENCES profiles(id), is_bot boolean DEFAULT false);
CREATE TABLE public.table_seats(id integer PRIMARY KEY, user_id uuid REFERENCES profiles(id), horse_id uuid, stack numeric DEFAULT 0);
CREATE TABLE public.ca_declared_money_triggers(table_name text, trigger_name text, note text, PRIMARY KEY(table_name,trigger_name));
CREATE OR REPLACE FUNCTION public.fn_reject_horse_name_on_human()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.is_horse, false) = false
     AND NEW.display_name IS NOT NULL
     AND btrim(NEW.display_name) <> ''
     AND EXISTS (
       SELECT 1
         FROM public.profiles h
        WHERE COALESCE(h.is_horse, false)
          AND h.display_name IS NOT NULL
          AND h.id IS DISTINCT FROM NEW.id
          AND btrim(h.display_name) ILIKE btrim(NEW.display_name)
     )
  THEN
    -- Drop the borrowed name instead of failing the whole write: this fires on
    -- ordinary profile saves, and a hard error would block a player editing
    -- something unrelated. The name is the only thing rejected.
    NEW.display_name := NULL;
  END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_reject_horse_name_on_human() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reject_horse_name_on_human() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_club_members_bot_follows_horse()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.is_bot := coalesce(
    (SELECT p.is_horse FROM public.profiles p WHERE p.id = NEW.user_id),
    NEW.is_bot,
    false);
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_club_members_bot_follows_horse() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_members_bot_follows_horse() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_stamp_seat_horse_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.horse_id := NULL;
    RETURN NEW;
  END IF;

  SELECT CASE WHEN COALESCE(p.is_horse, false) THEN p.id ELSE NULL END
    INTO NEW.horse_id
    FROM public.profiles p
   WHERE p.id = NEW.user_id;

  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_stamp_seat_horse_id() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_stamp_seat_horse_id() TO service_role;

CREATE TRIGGER trg_reject_horse_name_on_human BEFORE INSERT OR UPDATE OF display_name,is_horse ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.fn_reject_horse_name_on_human();
CREATE TRIGGER trg_club_members_bot_follows_horse BEFORE INSERT OR UPDATE OF user_id,is_bot ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_club_members_bot_follows_horse();
CREATE TRIGGER trg_stamp_seat_horse_id BEFORE INSERT OR UPDATE OF user_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_seat_horse_id();
INSERT INTO profiles VALUES
('00000000-0000-4000-8000-000000000001',true,'Alpha Pro'),
('00000000-0000-4000-8000-000000000002',false,'Human'),
('00000000-0000-4000-8000-000000000003',null,'Legacy Human'),
('00000000-0000-4000-8000-000000000004',true,'Literal_Name%');
INSERT INTO table_seats(id,user_id,stack) VALUES(1,'00000000-0000-4000-8000-000000000001',100);
