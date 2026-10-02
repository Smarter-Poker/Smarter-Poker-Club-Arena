-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906141230; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906141230   (the stamp IS the apply time, UTC: 2026-09-06 14:12:30)
--   name        a_player_export_forgets_horses_when_entitlement_does
--   created_by  (not recorded)
--   statements  7 statement(s), 4765 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906141230 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.ca_club_data_export_page
--     INDEX          idx_ca_club_data_export_rows_true_horse
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
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

-- 20260906141230_a_player_export_forgets_horses_when_entitlement_does
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-06 14:12:30 UTC.
--
-- WHAT WAS WRONG
--
-- Player CSV jobs intentionally materialize an immutable result so paging a
-- large ledger cannot drift. That also materialized is_horse at prepare time.
-- ca_club_data_export_page rechecked club-finance access on every page, but it
-- did not recheck the narrower fn_can_see_horse_flag entitlement. An owner or
-- admin downgraded to super_agent while an export was open retains finance
-- access and could therefore keep paging the previously unmasked horse flags.
--
-- WHAT THIS CHANGES
--
-- Every player-export page now rechecks the horse-flag entitlement before it
-- releases rows. If the prepared job contains a true flag and the viewer no
-- longer has permission, the page fails with 55000 and tells the client to
-- prepare a new export. Denying the page rather than masking only that page is
-- deliberate: otherwise rows fetched before the downgrade could be combined
-- with later masked rows into one partially sensitive file. A newly prepared
-- super-agent export remains valid because its rows were uniformly masked at
-- source and contain no true flag. The existing 42501 finance check remains.
--
-- The browser already treats 55000 as an ordinary complete-export failure:
-- no partial CSV is downloaded, cleanup still runs, and the page does not
-- falsely revoke the viewer's still-valid club-finance access.
--
-- The partial export-id index contains only rows whose flag is true. It makes
-- the entitlement recheck a single narrow lookup and, critically, keeps a
-- legitimately masked super-agent export from rescanning every false payload
-- once per CSV page. The live table held zero rows at inspection time (jobs
-- expire after fifteen minutes), so this non-concurrent build has no data-copy
-- exposure and can remain inside the required single DDL transaction.
--
-- One replacement and its grants are wrapped in one transaction so Supabase
-- performs one schema-cache reload.

BEGIN
CREATE INDEX IF NOT EXISTS idx_ca_club_data_export_rows_true_horse
  ON public.ca_club_data_export_rows(export_id)
  WHERE payload @> '{"is_horse": true}'::jsonb
CREATE OR REPLACE FUNCTION public.ca_club_data_export_page(
  p_export_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_job public.ca_club_data_exports%ROWTYPE;
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_limit integer := GREATEST(LEAST(COALESCE(p_limit, 1000), 2000), 1);
  v_rows jsonb;
BEGIN
  SELECT *
    INTO v_job
    FROM public.ca_club_data_exports
   WHERE id = p_export_id
     AND user_id = v_user
     AND expires_at >= now();

  IF v_job.id IS NULL OR NOT public.ca_can_view_club_finances(v_job.club_id) THEN
    RAISE EXCEPTION 'export not found or no longer authorized' USING ERRCODE = '42501';
  END IF;

  -- A player job prepared while this viewer was entitled can contain facts a
  -- super agent may not know. Recheck before EVERY page; if a later page sees
  -- the downgrade, fetchClubDataExport discards every earlier page and never
  -- hands a mixed result to the downloader.
  IF v_job.kind = 'players'
     AND NOT COALESCE(public.fn_can_see_horse_flag(v_job.club_id), false)
     AND EXISTS (
       SELECT 1
         FROM public.ca_club_data_export_rows sensitive
        WHERE sensitive.export_id = p_export_id
          AND sensitive.payload @> '{"is_horse": true}'::jsonb
     ) THEN
    RAISE EXCEPTION 'player export permissions changed; prepare a new export'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(r.payload ORDER BY r.ordinal), '[]'::jsonb)
    INTO v_rows
    FROM public.ca_club_data_export_rows r
   WHERE r.export_id = p_export_id
     AND r.ordinal > v_offset
     AND r.ordinal <= v_offset + v_limit;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total_rows', v_job.total_rows,
    'next_offset', LEAST(v_offset + jsonb_array_length(v_rows), v_job.total_rows),
    'has_more', v_offset + jsonb_array_length(v_rows) < v_job.total_rows,
    'expires_at', v_job.expires_at
  );
END;
$function$
REVOKE ALL ON FUNCTION public.ca_club_data_export_page(uuid, integer, integer)
  FROM PUBLIC, anon
GRANT EXECUTE ON FUNCTION public.ca_club_data_export_page(uuid, integer, integer)
  TO authenticated, service_role
COMMENT ON FUNCTION public.ca_club_data_export_page(uuid, integer, integer) IS
  'Pages an immutable Club Data export after rechecking finance access and, for sensitive prepared player jobs, the current horse-flag entitlement.'
COMMIT
