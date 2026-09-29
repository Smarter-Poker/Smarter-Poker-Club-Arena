-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905103820; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905103820   (the stamp IS the apply time, UTC: 2026-09-05 10:38:20)
--   name        a_horse_is_stamped_on_its_seat_functions
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1936 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905103820 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.trg_auto_cashout_on_table_close, public.fn_stamp_seat_horse_id
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN
    RETURN NEW; -- tournament tables settle via prizes, not seat cashout
  END IF;

  FOR r IN
    SELECT ts.user_id, ts.seat_number
    FROM table_seats ts
    WHERE ts.table_id = NEW.id
      AND ts.left_at IS NULL
      /* `AND ts.horse_id IS NULL` was here until 2026-09-05. It read as "do
         not cash out horses", it never fired (the column was never written),
         and the moment the column WAS written it would have stranded every
         horse's chips on every closing table. CLAUDE.md 10.5: a horse is paid
         everything a human is paid. Every seat holding chips is cashed out. */
      AND COALESCE(ts.stack,0) > 0
  LOOP
    BEGIN
      PERFORM public.atomic_table_cashout(r.user_id, NEW.id, r.seat_number);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'auto-cashout failed for user % on table %: %', r.user_id, NEW.id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

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
$function$;

COMMENT ON FUNCTION public.fn_stamp_seat_horse_id() IS
  'Stamps table_seats.horse_id with the occupant profile id when that profile is a horse, NULL otherwise. The client cannot read profiles.is_horse (a horse is named only to those entitled), so the seat row is how the felt knows. Fires only when user_id is written, so an ordinary stack update costs nothing.';

COMMIT;
