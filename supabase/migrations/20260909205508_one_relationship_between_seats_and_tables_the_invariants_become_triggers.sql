BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL search_path TO public, pg_temp;

/* A SECOND FOREIGN KEY BETWEEN TWO TABLES IS A SECOND RELATIONSHIP, AND
   POSTGREST REFUSES TO GUESS (2026-09-09, applied inside the 20:55 break).
   ---------------------------------------------------------------------------
   At 17:24:47 and 17:25:29 today, 20260909172447 and 20260909172529 installed
   two COMPOSITE foreign keys from table_seats to tables:

     active_seat_game_scope_parent   (table_id, active_game_scope)
                                     -> tables(id, seat_game_scope)  ON UPDATE CASCADE
     live_seat_parent_cannot_close   (table_id, active_parent_key)
                                     -> tables(id, seat_admission_key)

   Both enforce real invariants and both stay enforced below. But alongside
   the original table_seats_table_id_fkey they gave PostgREST THREE
   relationships between the two tables, and from that minute every hint-less
   embed - `tables!inner(...)` from table_seats, `table_seats(...)` from tables
   - has failed with PGRST201:

     "Could not embed because more than one relationship was found for
      'table_seats' and 'tables'"

   Read from the engine's own log at 20:5x. Eleven such embeds exist on main
   in the engine and the client alone: the tournament launch's live-seat
   inventory read (createTablesAndSeatPlayers), creditSeatStacks, the horse
   seat-load, seatClaim, the elimination sweep, the anti-cheat and blacklist
   pages, TablePage's tournament count. Since 17:25 every tournament launch
   has claimed its receipt, thrown on that read before building a single
   table, and left the event in REGISTERING: 21 launches claimed and none
   completed, 379 events past their start time, buy-ins sitting in escrow.

   THE FIX keeps both invariants and removes the ambiguity. PostgREST discovers
   relationships from pg_constraint foreign keys and nothing else, so the two
   composite keys become triggers that enforce exactly the same rules with the
   same error class (23503 foreign_key_violation) and the same constraint
   names in the message - the other programme's tests match on those names -
   and PostgREST is back to the one relationship it had at 17:23. No engine or
   client deploy is needed: the embeds work the moment the schema cache
   reloads.

   Semantics reproduced, deliberately, one for one:
   - MATCH SIMPLE: a NULL in the seat's scope/key column means no check.
   - active_seat_game_scope_parent: the seat's active_game_scope must equal
     its table's seat_game_scope; a change to tables.seat_game_scope cascades
     into the seats that carried the old value.
   - live_seat_parent_cannot_close: the seat's active_parent_key must equal
     its table's seat_admission_key, and the table may not change or clear
     its seat_admission_key while a seat still references it - which is how
     "terminal tables cannot commit live occupancies" was enforced.
   - The parent row is locked FOR KEY SHARE on the seat side, as an FK does,
     so a close and an admission still serialise against each other. */

ALTER TABLE public.table_seats DROP CONSTRAINT IF EXISTS active_seat_game_scope_parent;
ALTER TABLE public.table_seats DROP CONSTRAINT IF EXISTS live_seat_parent_cannot_close;

CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public, pg_temp AS $$
DECLARE v_scope text; v_key text; v_found boolean;
BEGIN
  IF NEW.table_id IS NULL OR (NEW.active_game_scope IS NULL AND NEW.active_parent_key IS NULL) THEN
    RETURN NEW;
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

CREATE OR REPLACE FUNCTION public.trg_table_parent_keys_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public, pg_temp AS $$
BEGIN
  -- live_seat_parent_cannot_close: NO ACTION on the parent side.
  IF OLD.seat_admission_key IS NOT NULL AND NEW.seat_admission_key IS DISTINCT FROM OLD.seat_admission_key THEN
    IF EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.table_id = OLD.id AND s.active_parent_key = OLD.seat_admission_key) THEN
      RAISE EXCEPTION 'update or delete on table "tables" violates foreign key constraint "live_seat_parent_cannot_close" on table "table_seats"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
              DETAIL = format('Key (id, seat_admission_key)=(%s, %s) is still referenced from table "table_seats".', OLD.id, OLD.seat_admission_key);
    END IF;
  END IF;
  -- active_seat_game_scope_parent: ON UPDATE CASCADE on the parent side.
  IF OLD.seat_game_scope IS NOT NULL AND NEW.seat_game_scope IS DISTINCT FROM OLD.seat_game_scope THEN
    UPDATE public.table_seats s SET active_game_scope = NEW.seat_game_scope
     WHERE s.table_id = OLD.id AND s.active_game_scope = OLD.seat_game_scope;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zz_seat_parent_keys_match ON public.table_seats;
CREATE TRIGGER zz_seat_parent_keys_match
  BEFORE INSERT OR UPDATE OF table_id, active_game_scope, active_parent_key ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_seat_parent_keys_match();

DROP TRIGGER IF EXISTS zz_table_parent_keys_guard ON public.tables;
CREATE TRIGGER zz_table_parent_keys_guard
  BEFORE UPDATE OF seat_game_scope, seat_admission_key ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.trg_table_parent_keys_guard();

DO $$
DECLARE v_fk int;
BEGIN
  SELECT count(*) INTO v_fk FROM pg_constraint
   WHERE conrelid='public.table_seats'::regclass AND contype='f' AND confrelid='public.tables'::regclass;
  IF v_fk <> 1 THEN RAISE EXCEPTION 'expected exactly ONE foreign key table_seats -> tables, found %', v_fk; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='zz_seat_parent_keys_match') THEN
    RAISE EXCEPTION 'seat-side guard missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.tables'::regclass AND tgname='zz_table_parent_keys_guard') THEN
    RAISE EXCEPTION 'table-side guard missing'; END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
              WHERE s.active_game_scope IS NOT NULL AND s.active_game_scope IS DISTINCT FROM t.seat_game_scope) THEN
    RAISE EXCEPTION 'a seat disagrees with its table game scope'; END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
              WHERE s.active_parent_key IS NOT NULL AND s.active_parent_key IS DISTINCT FROM t.seat_admission_key) THEN
    RAISE EXCEPTION 'a seat references an admission key its table no longer holds'; END IF;
END $$;

COMMIT;
