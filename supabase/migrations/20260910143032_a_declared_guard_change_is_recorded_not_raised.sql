-- a_declared_guard_change_is_recorded_not_raised
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- At 13:28 today a_maintenance_kind_registered_as_info_is_recorded_not_raised
-- redefined fn_ca_journal_append_only. At 14:25 fn_ca_guard_defs_watch noticed
-- the definition had changed and opened 91032e79, an INFO notice that says in
-- its own text "Then resolve this notice - it does not close itself."
--
-- So a reviewed, applied, recorded migration puts an item on the board that a
-- human has to clear by hand. Every deliberate change to any of the 28 watched
-- guards does this. That is our own maintenance setting off an alarm, and it is
-- the third instance of the same shape today, after the append-only notice and
-- the hand-refusal detector.
--
-- WHAT THE DIFF ACTUALLY WAS, proved rather than asserted. History id 5294 is
-- the definition as of 2026-09-09 10:25; id 6078 is the live one. Applying the
-- two documented substitutions from that migration to 5294 reproduces 6078
-- EXACTLY - md5 ac9d66e60d077d886981c428c71e5c3c, the same hash the notice
-- carries as new_hash. 527 characters added, nothing else changed. That check
-- is repeated as an assertion below, so this migration refuses to close the
-- notice if the live guard is anything other than what that migration made.
--
-- THE RULE, and it is the registry pattern again: a DECLARED change is
-- recorded, an UNDECLARED one is raised. fn_ca_declare_guard_redefinition lets
-- a migration that deliberately redefines a watched guard move the baseline in
-- the SAME transaction, naming itself. The watcher then has nothing to report,
-- because by the time it runs the baseline already is the live definition.
--
-- NOTHING ABOUT THE WATCHER CHANGES, and that is the point. It is not muted, it
-- is not narrowed, and its severity is untouched. A guard redefined by anything
-- that did NOT declare itself - a hand edit on the box, an unreviewed CREATE OR
-- REPLACE, a rollback that silently restores old text - still moves the hash
-- away from the baseline and still raises exactly as loudly as it does today.
-- What stops is the board reporting work that was already reviewed.
--
-- ca_guard_defs gains declared_ref and declared_at so the baseline says WHO
-- moved it and WHY. A baseline moved by the watcher itself leaves them null,
-- which is how you tell a recorded change from an observed one.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ca_guard_defs
  ADD COLUMN IF NOT EXISTS declared_ref text,
  ADD COLUMN IF NOT EXISTS declared_at timestamptz;

COMMENT ON COLUMN public.ca_guard_defs.declared_ref IS
  'The migration that deliberately redefined this guard and moved the baseline in its own transaction. NULL means the baseline was moved by fn_ca_guard_defs_watch after observing a change nobody declared - which is the case the watcher exists for.';

CREATE OR REPLACE FUNCTION public.fn_ca_declare_guard_redefinition(
  p_proname text,
  p_ref text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_hash text;
  v_def text;
BEGIN
  /* A DECLARED GUARD CHANGE IS RECORDED, NOT RAISED (2026-09-10).
     Call this from a migration that deliberately redefines a watched guard,
     in the SAME transaction as the redefinition, passing the migration name.
     It moves the baseline to the definition this transaction just produced,
     so fn_ca_guard_defs_watch has nothing to report. A change nobody declares
     still moves the hash away from the baseline and still raises. */
  IF COALESCE(btrim(p_ref), '') = '' THEN
    RAISE EXCEPTION 'a guard redefinition must name the migration that made it';
  END IF;
  IF NOT (p_proname = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION 'fn_ca_declare_guard_redefinition called for %, which is not on the guard watchlist', p_proname;
  END IF;

  SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)),
         string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)
    INTO v_hash, v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_proname;

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'guard function % does not exist; a declaration cannot baseline an absent guard', p_proname;
  END IF;

  -- keep the text so any later notice still has something to diff against
  INSERT INTO public.ca_guard_def_history (proname, def_hash, def_text)
  VALUES (p_proname, v_hash, v_def)
  ON CONFLICT (proname, def_hash) DO NOTHING;

  INSERT INTO public.ca_guard_defs (proname, def_hash, declared_ref, declared_at)
  VALUES (p_proname, v_hash, p_ref, now())
  ON CONFLICT (proname) DO UPDATE
    SET def_hash = EXCLUDED.def_hash,
        declared_ref = EXCLUDED.declared_ref,
        declared_at = EXCLUDED.declared_at,
        updated_at = now();

  RETURN v_hash;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_declare_guard_redefinition(text, text) FROM PUBLIC;

DO $body$
DECLARE
  v_old text;
  v_new text;
  v_rebuilt text;
  v_rows integer;
  v_a1 text := E'      v_sev := COALESCE(v_sev, ''warning'');\n      PERFORM public.fn_ca_raise_drift_incident(';
  v_a1n text := E'      v_sev := COALESCE(v_sev, ''warning'');\n'
             || E'      /* A REGISTERED MAINTENANCE KIND MARKED `info` IS RECORDED, NOT RAISED\n'
             || E'         (2026-09-10). The row above is already written to\n'
             || E'         ca_ledger_mutation_log, whole, before this point. A kind the\n'
             || E'         registry declares `info` says so deliberately - "expected,\n'
             || E'         scheduled and reversible: recorded, not alarming" - so it does not\n'
             || E'         also open a board item once per run, for ever. An UNREGISTERED\n'
             || E'         kind still defaults to warning and still raises. */\n'
             || E'      IF v_sev <> ''info'' THEN\n'
             || E'      PERFORM public.fn_ca_raise_drift_incident(';
  v_a2 text := E'                           ''application'', current_setting(''application_name'', true)));\n    EXCEPTION WHEN OTHERS THEN NULL;';
  v_a2n text := E'                           ''application'', current_setting(''application_name'', true)));\n      END IF;\n    EXCEPTION WHEN OTHERS THEN NULL;';
BEGIN
  -- 1. PROVE the change the notice is reporting is exactly the one that was
  --    reviewed and applied at 13:28, and nothing else.
  SELECT def_text INTO v_old FROM public.ca_guard_def_history WHERE id = 5294;
  SELECT def_text INTO v_new FROM public.ca_guard_def_history WHERE id = 6078;
  IF v_old IS NULL OR v_new IS NULL THEN
    RAISE EXCEPTION 'the two definitions the notice names are not both in ca_guard_def_history';
  END IF;
  v_rebuilt := replace(replace(v_old, v_a1, v_a1n), v_a2, v_a2n);
  IF v_rebuilt <> v_new THEN
    RAISE EXCEPTION 'the live append-only guard is NOT the previous definition plus the two documented substitutions; something else changed it and this notice must be investigated by hand';
  END IF;
  IF md5(v_new) <> 'ac9d66e60d077d886981c428c71e5c3c' THEN
    RAISE EXCEPTION 'the definition the notice carries is not the one measured (md5 %)', md5(v_new);
  END IF;

  -- 2. Record it as declared, retroactively, by the migration that made it.
  PERFORM public.fn_ca_declare_guard_redefinition(
    'fn_ca_journal_append_only',
    'migration a_maintenance_kind_registered_as_info_is_recorded_not_raised');

  -- 3. And close the notice on that proof.
  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_ca_guard_defs_watch compares each watched guard against a stored baseline and raises an INFO notice when they differ. Migration a_maintenance_kind_registered_as_info_is_recorded_not_raised deliberately redefined fn_ca_journal_append_only at 13:28; the baseline was still the 2026-09-09 text, so the 14:25 run reported our own reviewed change as an unexplained redefinition, and said in its own words that it does not close itself.',
         correction_ref = 'migration a_declared_guard_change_is_recorded_not_raised',
         resolution = 'Diffed and proved, not assumed: applying that migration''s two documented substitutions to history id 5294 reproduces the live definition (id 6078) byte for byte, md5 ac9d66e60d077d886981c428c71e5c3c - 527 characters added, nothing else touched. The migration asserts that reconstruction and would have refused to close this notice if anything else had changed the guard. Going forward fn_ca_declare_guard_redefinition lets a migration move the baseline in the same transaction as the redefinition, naming itself, so a declared change is recorded and never reaches the board. The watcher is unchanged: an undeclared redefinition still raises exactly as loudly as before.'
   WHERE i.status <> 'resolved' AND i.source = 'fn_ca_guard_defs_watch'
     AND i.dedupe_key LIKE 'guard-def-drift:fn_ca_journal_append_only:%';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'expected to resolve the append-only guard-def notice, resolved %', v_rows;
  END IF;

  -- 4. And prove the board is not carrying any other guard whose live text has
  --    drifted away from its baseline - a change nobody has answered for.
  SELECT count(*) INTO v_rows
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(proname)
    LEFT JOIN public.ca_guard_defs g ON g.proname = w.proname
   WHERE g.def_hash IS DISTINCT FROM (
     SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = w.proname);
  IF v_rows <> 0 THEN
    RAISE EXCEPTION '% watched guard(s) differ from their baseline and would raise at the next run', v_rows;
  END IF;
END
$body$;

COMMIT;
