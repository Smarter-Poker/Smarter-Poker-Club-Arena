-- Horse identity is derived from canonical profiles, including direct stamp writes.
-- Native PG17 proves all three baseline failures. No player/seat/balance backfill.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '45s';
DO $preflight$
BEGIN
  IF md5(pg_get_functiondef('public.fn_reject_horse_name_on_human()'::regprocedure)) <> 'e502e13cb89cd19503ba67be8d56f614'
     OR md5(pg_get_functiondef('public.fn_club_members_bot_follows_horse()'::regprocedure)) <> 'f90077b45a854a4f130d06c28c25d4a5'
     OR md5(pg_get_functiondef('public.fn_stamp_seat_horse_id()'::regprocedure)) <> '3c659ba826e3a3296cdfd74911164185'
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
       AND tgname='trg_stamp_seat_horse_id' AND tgenabled='O'
       AND pg_get_triggerdef(oid)='CREATE TRIGGER trg_stamp_seat_horse_id BEFORE INSERT OR UPDATE OF user_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_horse_id()') THEN
    RAISE EXCEPTION 'Horse identity trigger definitions drifted; review before installation';
  END IF;
END;
$preflight$;

-- ILIKE interprets player names as patterns. This comparison is literal,
-- retaining the established trim/case-insensitive borrowed-name rule.
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
          AND lower(btrim(h.display_name)) = lower(btrim(NEW.display_name))
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
-- A NULL/absent horse flag never grants horse identity from a supplied is_bot.
CREATE OR REPLACE FUNCTION public.fn_club_members_bot_follows_horse()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.is_bot := coalesce(
    (SELECT p.is_horse FROM public.profiles p WHERE p.id = NEW.user_id),
    false);
  RETURN NEW;
END;
$function$
;
-- Keep stack and sit-out writes free of profile reads. Stamp-only writes must
-- obey the same identity rule as inserts and occupant changes.
DROP TRIGGER trg_stamp_seat_horse_id ON public.table_seats;
CREATE TRIGGER trg_stamp_seat_horse_id
  BEFORE INSERT OR UPDATE OF user_id, horse_id ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_seat_horse_id();
COMMENT ON FUNCTION public.fn_stamp_seat_horse_id() IS
  'Stamps table_seats.horse_id from the canonical occupant profile on insert or writes to user_id/horse_id. Ordinary stack or sit-out updates do not query profiles.';
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('table_seats','trg_stamp_seat_horse_id','Derive horse_id from the canonical occupant on inserts, occupant changes and direct stamp writes; stack-only updates remain untouched.')
ON CONFLICT (table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
COMMIT;
