-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909235604; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909235604   (the stamp IS the apply time, UTC: 2026-09-09 23:56:04)
--   name        a_registrant_the_launch_cannot_seat_is_released_with_an_exac
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4476 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909235604 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     CONSTRAINT     tournament_unregistration_actual_start_check on public.tournament_unregistration_receipts

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

DO $gate$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)');
  v_def text;
  v_release_clause text := $clause$
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_launch_receipts r
          WHERE r.tournament_id=p_tournament_id
            AND r.completed_at IS NULL
            AND r.launch_id::text=NULLIF(
              current_setting('app.ca_launch_release_launch_id',true),''))$clause$;
  v_gate1_original text := $t$
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$t$;
  v_gate1_patched text;
  v_gate2_original text := $t$
    IF v_unregistered_at>=v_t.start_time THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE$t$;
  v_gate2_patched text;
  v_auth_old text := $t$
    v_start_authority:='heads_up_sng_actual_start';
  END IF;
$t$;
  v_auth_new text := $t$
    v_start_authority:='heads_up_sng_actual_start';
  END IF;
  /* A release performed by the launch that holds this event's INCOMPLETE
     launch receipt has its own start authority. The clock has passed
     start_time, but no hand has been dealt (checked below, fails closed)
     and the receipt has not been completed, so the seat-first proofs -
     started_at unset, launch not completed - are the right ones and the
     receipt records launch_release. The launch names its receipt through
     the transaction-local app.ca_launch_release_launch_id, set only by
     fn_ca_release_unseatable_registrant_at_launch. */
  IF v_start_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(
            current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_start_authority:='launch_release';
  END IF;
$t$;
  v_changed boolean := false;
  v_n integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid) is not installed';
  END IF;
  v_gate1_patched := $t$
    /* A release performed by the launch that holds this event's INCOMPLETE
       launch receipt is pre-start: the clock has passed start_time, but no
       hand has been dealt (checked above, fails closed) and the receipt has
       not been completed. The launch names its receipt through the
       transaction-local app.ca_launch_release_launch_id, set only by
       fn_ca_release_unseatable_registrant_at_launch. */
    IF clock_timestamp()>=v_t.start_time$t$ || v_release_clause || $t$ THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$t$;
  v_gate2_patched := $t$
    IF v_unregistered_at>=v_t.start_time$t$ || v_release_clause || $t$ THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE$t$;
  v_def := pg_get_functiondef(v_oid);
  IF position(v_gate1_patched IN v_def) > 0 THEN
    v_def := replace(v_def, v_gate1_patched, v_gate1_original); v_changed := true;
  END IF;
  IF position(v_gate2_patched IN v_def) > 0 THEN
    v_def := replace(v_def, v_gate2_patched, v_gate2_original); v_changed := true;
  END IF;
  IF position(v_gate1_original IN v_def) = 0 OR position(v_gate2_original IN v_def) = 0 THEN
    RAISE EXCEPTION 'the scheduled-clock gates of fn_ca_unregister_tournament_player_exact are not in a known shape';
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_auth_old, ''))) / length(v_auth_old);
  IF position(v_auth_new IN v_def) = 0 THEN
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the start-authority block of fn_ca_unregister_tournament_player_exact was expected exactly once, found %', v_n;
    END IF;
    v_def := replace(v_def, v_auth_old, v_auth_new); v_changed := true;
  END IF;
  IF v_changed THEN EXECUTE v_def; END IF;
END
$gate$;

ALTER TABLE public.tournament_unregistration_receipts
  DROP CONSTRAINT IF EXISTS tournament_unregistration_actual_start_check;
ALTER TABLE public.tournament_unregistration_receipts
  ADD CONSTRAINT tournament_unregistration_actual_start_check CHECK (
    (start_authority = 'scheduled_clock' AND settled_at < scheduled_start_at)
    OR start_authority IN ('spin_actual_start', 'heads_up_sng_actual_start', 'launch_release'));
