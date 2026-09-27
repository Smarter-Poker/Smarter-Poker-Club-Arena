-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820063712 "add_cancelled_to_entry_status_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 feebb2bd1fb91256c244be13a105d73c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Add 'cancelled' to the allowed statuses for commander_tournament_entries.
-- register.js and entries.js soft-cancel entries by writing status='cancelled';
-- the existing CHECK did not include it, so those writes would violate the
-- constraint at runtime.

-- Pre-flight: assert no rows carry a status outside the union of the old
-- allowed set plus 'cancelled'. If any exist, abort so a human can look.
DO $$
DECLARE
  bad_count integer;
  bad_list text;
BEGIN
  SELECT count(*), string_agg(DISTINCT status, ', ')
    INTO bad_count, bad_list
    FROM commander_tournament_entries
   WHERE status NOT IN ('registered', 'seated', 'active', 'eliminated',
                        'winner', 'bagged', 'alternate', 'cashed', 'cancelled');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Unexpected entry statuses present (% rows): %', bad_count, bad_list;
  END IF;
END $$;

ALTER TABLE commander_tournament_entries
  DROP CONSTRAINT commander_tournament_entries_status_check;

ALTER TABLE commander_tournament_entries
  ADD CONSTRAINT commander_tournament_entries_status_check
  CHECK (status = ANY (ARRAY['registered'::text, 'seated'::text, 'active'::text,
                             'eliminated'::text, 'winner'::text, 'bagged'::text,
                             'alternate'::text, 'cashed'::text, 'cancelled'::text]));

