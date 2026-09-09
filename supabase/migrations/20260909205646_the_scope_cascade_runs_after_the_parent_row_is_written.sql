BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL search_path TO public, pg_temp;

/* Caught by the rolled-back probe of the previous migration, before it could
   bite: the ON UPDATE CASCADE replacement ran inside a BEFORE UPDATE trigger
   on tables, so when it pushed the new seat_game_scope into the seats, the
   seat-side check read the parent row - which still held the OLD scope,
   because a BEFORE trigger fires before the row is written - and refused the
   cascade as a mismatch. A real FK cascades after the parent write. So does
   this now: the refusal ("terminal tables cannot commit live occupancies")
   stays BEFORE, where it can reject the parent write; the cascade moves to
   AFTER, where the seat-side check sees the new scope and agrees. */

CREATE OR REPLACE FUNCTION public.trg_table_parent_keys_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public, pg_temp AS $$
BEGIN
  IF OLD.seat_admission_key IS NOT NULL AND NEW.seat_admission_key IS DISTINCT FROM OLD.seat_admission_key THEN
    IF EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.table_id = OLD.id AND s.active_parent_key = OLD.seat_admission_key) THEN
      RAISE EXCEPTION 'update or delete on table "tables" violates foreign key constraint "live_seat_parent_cannot_close" on table "table_seats"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
              DETAIL = format('Key (id, seat_admission_key)=(%s, %s) is still referenced from table "table_seats".', OLD.id, OLD.seat_admission_key);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.trg_table_scope_cascade()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public, pg_temp AS $$
BEGIN
  IF OLD.seat_game_scope IS NOT NULL AND NEW.seat_game_scope IS DISTINCT FROM OLD.seat_game_scope THEN
    UPDATE public.table_seats s SET active_game_scope = NEW.seat_game_scope
     WHERE s.table_id = NEW.id AND s.active_game_scope = OLD.seat_game_scope;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS zz_table_parent_keys_guard ON public.tables;
CREATE TRIGGER zz_table_parent_keys_guard
  BEFORE UPDATE OF seat_admission_key ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_table_parent_keys_guard();

DROP TRIGGER IF EXISTS zz_table_scope_cascade ON public.tables;
CREATE TRIGGER zz_table_scope_cascade
  AFTER UPDATE OF seat_game_scope ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_table_scope_cascade();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND tgname='zz_table_scope_cascade' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'cascade trigger missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND tgname='zz_table_parent_keys_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'guard trigger missing'; END IF;
END $$;

COMMIT;
