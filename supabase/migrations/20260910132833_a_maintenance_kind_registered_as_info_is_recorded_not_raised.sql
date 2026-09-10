-- a_maintenance_kind_registered_as_info_is_recorded_not_raised
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ca_ledger_maintenance_kinds already says what should happen here, in its own
-- words, for the certification cleanup:
--
--   "Every row is preserved whole in ca_ledger_mutation_log and archived in
--    ca_diamond_journal_archive before it goes. Expected, scheduled and
--    reversible: RECORDED, NOT ALARMING."
--
-- It is registered `info`. And fn_ca_journal_append_only raises a drift
-- incident anyway - with severity `info`, but a board item all the same, once
-- per cleanup, for ever. Resolving one just lets the next cleanup open another:
-- 0ad5625e was closed at 13:23 with 954 occurrences and d03c35bf opened four
-- minutes later, same dedupe key, same declared reason.
--
-- An alarm that cannot be turned off by fixing anything is an alarm people
-- learn to scroll past, and it hides the ones that matter (CLAUDE.md 10.84:
-- an alarm that is always on gets muted).
--
-- THE RULE, which is the registry's own: a maintenance kind REGISTERED in
-- ca_ledger_maintenance_kinds with severity `info` is recorded in
-- ca_ledger_mutation_log - every row, whole, exactly as now - and does not
-- open a drift incident. Everything else is unchanged, and that is the part
-- that matters: an UNREGISTERED kind still defaults to `warning` and still
-- raises, so a bypass nobody declared is as loud as it ever was, and a
-- registered kind can be made loud again by changing one row.
--
-- Two asserted substitutions on the live trigger, each anchored on text that
-- must appear exactly once, and the incident that this closes.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text;
  v_n integer;
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
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_journal_append_only is missing'; END IF;
  IF position('IS RECORDED, NOT RAISED' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
    IF v_n <> 1 THEN RAISE EXCEPTION 'raise anchor appears % times, expected 1', v_n; END IF;
    v_n := (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2);
    IF v_n <> 1 THEN RAISE EXCEPTION 'close anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(replace(v_def, v_a1, v_a1n), v_a2, v_a2n);
  END IF;

  -- the registry still has to be able to make a kind loud again
  SELECT count(*) INTO v_n FROM public.ca_ledger_maintenance_kinds
   WHERE severity IS DISTINCT FROM 'info';
  RAISE NOTICE 'a_maintenance_kind: % registered kind(s) still raise', v_n;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_ca_journal_append_only opened a drift incident for every declared certification-cleanup bypass, although ca_ledger_maintenance_kinds registers that kind as `info` with the note "expected, scheduled and reversible: recorded, not alarming". Resolving one only let the next cleanup open another - 0ad5625e closed at 13:23 and this one opened four minutes later on the same dedupe key.',
         correction_ref = 'migration a_maintenance_kind_registered_as_info_is_recorded_not_raised',
         resolution = 'The registry''s own declaration is now honoured: a kind registered `info` is recorded in ca_ledger_mutation_log - every row, whole - and does not open a board item. An unregistered kind still defaults to warning and still raises, so an undeclared bypass is as loud as it ever was.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_journal_append_only';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN RAISE EXCEPTION 'expected to resolve the append-only notice, resolved %', v_rows; END IF;
END
$body$;

COMMIT;
