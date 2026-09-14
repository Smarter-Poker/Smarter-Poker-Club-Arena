CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE TABLE public.table_seats(id int PRIMARY KEY,user_id uuid,table_id uuid,seat_number int,left_at timestamptz,is_sitting_out boolean,sit_out_at timestamptz,occupancy_id uuid,stack bigint);
CREATE TABLE public.ca_declared_money_triggers(table_name text,trigger_name text,note text,PRIMARY KEY(table_name,trigger_name));
CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$ SELECT COALESCE(current_setting('app.freeze_bypass', TRUE), '') = 'on'; $function$;
CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.is_sitting_out := false;
  NEW.sit_out_at := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_sit_out_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.sit_out_at := CASE WHEN COALESCE(NEW.is_sitting_out, false)
                           THEN COALESCE(NEW.sit_out_at, now())
                           ELSE NULL END;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_sitting_out, false) AND NOT COALESCE(OLD.is_sitting_out, false) THEN
    -- Entering sit-out: start the clock.
    NEW.sit_out_at := now();
  ELSIF NOT COALESCE(NEW.is_sitting_out, false) THEN
    -- Not sitting out, by any route (sat back in, seat turned over, evicted).
    NEW.sit_out_at := NULL;
  ELSIF public.fn_freeze_bypass_active()
        AND NEW.sit_out_at IS NOT NULL
        AND NEW.sit_out_at IS DISTINCT FROM OLD.sit_out_at THEN
    -- Still sitting out, and the writer is the THAW (the only transaction
    -- that runs under app.freeze_bypass). It is giving this clock back the
    -- minutes the freeze took; honour the value it supplied.
    NULL;
  ELSE
    -- Still sitting out. HOLD THE ORIGINAL STAMP. An unrelated UPDATE to the
    -- row (a stack change, a time-bank decrement, a status write) must NOT
    -- restart the five minutes.
    NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
  END IF;

  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_clear_sitout_on_turnover BEFORE UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_clear_sitout_on_turnover();
CREATE TRIGGER trg_new_seat_clear_sitout BEFORE INSERT ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_new_seat_clear_sitout();
CREATE TRIGGER trg_stamp_sit_out_at BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_sit_out_at();
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();
REVOKE ALL ON FUNCTION public.fn_clear_sitout_on_turnover() FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_clear_sitout_on_turnover() TO service_role;
INSERT INTO public.table_seats(id,user_id,table_id,seat_number,left_at,is_sitting_out,stack) VALUES(1,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',1,NULL,false,100);
