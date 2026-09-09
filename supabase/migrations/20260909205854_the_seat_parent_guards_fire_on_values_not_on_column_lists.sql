BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL search_path TO public, pg_temp;

/* Two defects in my own replacement triggers, both found by rolled-back
   probes before any live write could meet them:

   1. `AFTER UPDATE OF seat_game_scope` fires on the STATEMENT'S column list,
      not on the value. tables.seat_game_scope and tables.seat_admission_key
      are DERIVED - zzzz_stamp_table_game_scope sets the scope from
      cluster_id and zzzz_stamp_table_seat_admission sets the admission key
      from status, both in BEFORE triggers - so the writes that actually
      change them say `SET cluster_id = ...` and `SET status = 'closed'`.
      Under "UPDATE OF <column>" neither guard fired: the scope did not
      cascade, and a table could have closed over a live seat. A foreign key
      checks values; so must these. Both now fire on every UPDATE and decide
      on OLD IS DISTINCT FROM NEW.

   2. The seat-side check ran BEFORE the seat's own stamp
      (zz_ sorts before zzzz_), so it judged the pre-stamp value. A foreign
      key is checked at the end of the statement, on the final row. It now
      sorts after the stamp (zzzzz_) and checks only when the referencing
      columns actually changed, which is exactly when an FK re-checks. */

CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public, pg_temp AS $$
DECLARE v_scope text; v_key text; v_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
     AND OLD.active_game_scope IS NOT DISTINCT FROM NEW.active_game_scope
     AND OLD.active_parent_key IS NOT DISTINCT FROM NEW.active_parent_key THEN
    RETURN NEW; -- an FK re-checks only when a referencing column changes
  END IF;
  IF NEW.table_id IS NULL OR (NEW.active_game_scope IS NULL AND NEW.active_parent_key IS NULL) THEN
    RETURN NEW; -- MATCH SIMPLE
  END IF;
  SELECT t.seat_game_scope, t.seat_admission_key, true INTO v_scope, v_key, v_found
    FROM public.tables t WHERE t.id = NEW.table_id FOR KEY SHARE;
  IF NEW.active_game_scope IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_scope IS DISTINCT FROM NEW.active_game_scope) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "active_seat_game_scope_parent"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'active_seat_game_scope_parent',
            DETAIL = format('Key (table_id, active_game_scope)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_game_scope);
  END IF;
  IF NEW.active_parent_key IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_key IS DISTINCT FROM NEW.active_parent_key) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "live_seat_parent_cannot_close"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
            DETAIL = format('Key (table_id, active_parent_key)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_parent_key);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zz_seat_parent_keys_match ON public.table_seats;
DROP TRIGGER IF EXISTS zzzzz_seat_parent_keys_match ON public.table_seats;
CREATE TRIGGER zzzzz_seat_parent_keys_match
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_seat_parent_keys_match();

DROP TRIGGER IF EXISTS zz_table_parent_keys_guard ON public.tables;
DROP TRIGGER IF EXISTS zzzzz_table_parent_keys_guard ON public.tables;
CREATE TRIGGER zzzzz_table_parent_keys_guard
  BEFORE UPDATE ON public.tables
  FOR EACH ROW
  WHEN (OLD.seat_admission_key IS DISTINCT FROM NEW.seat_admission_key)
  EXECUTE FUNCTION public.trg_table_parent_keys_guard();

DROP TRIGGER IF EXISTS zz_table_scope_cascade ON public.tables;
DROP TRIGGER IF EXISTS zzzzz_table_scope_cascade ON public.tables;
CREATE TRIGGER zzzzz_table_scope_cascade
  AFTER UPDATE ON public.tables
  FOR EACH ROW
  WHEN (OLD.seat_game_scope IS DISTINCT FROM NEW.seat_game_scope)
  EXECUTE FUNCTION public.trg_table_scope_cascade();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname LIKE '%seat_parent_keys_match') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one seat-side guard'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND tgname LIKE '%table_parent_keys_guard') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one table-side guard'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND tgname LIKE '%table_scope_cascade') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one cascade'; END IF;
  -- the seat guard must sort AFTER the stamp so it judges the final row
  IF 'zzzzz_seat_parent_keys_match' <= 'zzzz_stamp_active_seat_game_scope' THEN
    RAISE EXCEPTION 'seat guard would run before the stamp'; END IF;
END $$;

COMMIT;
