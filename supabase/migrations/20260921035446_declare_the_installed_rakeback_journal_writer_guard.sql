-- Record the omitted declaration for immutable, already-installed 20260921030445.
--
-- WHAT WENT WRONG. 20260921030445_rakeback_payouts_carry_their_document_and_run_identity
-- deliberately edited public.fn_club_members_ledger_writer, a function on
-- fn_ca_guard_watchlist(), and did not call fn_ca_declare_guard_redefinition in
-- its own transaction, which
-- 20260910143032_a_declared_guard_change_is_recorded_not_raised.sql requires of
-- every migration after it. So fn_ca_guard_defs_watch did exactly what it
-- exists to do: it observed a hash it had not been told about, moved the
-- baseline itself, and opened an INFO notice for a person to close by hand:
--
--   718898db-ce90-40bc-bb05-401bf397af75  2026-09-21 03:25:00Z
--     fn_club_members_ledger_writer  e7cae5f2 -> d9b0429e  (history 14204 -> 18625)
--
-- THE BASELINE CARRIES A STALE REF, which is the harder half. It is not NULL:
-- it still names 20260917230925, declared for it on 2026-09-18 by
-- 20260918014359. fn_ca_guard_defs_watch moves def_hash and updated_at but
-- never clears declared_ref, so a ref survives a redefinition it does not own
-- and reads exactly like a current one. Only its declared_at (2026-09-18
-- 01:49:22Z, three days older than the baseline it appears to vouch for) gives
-- it away. Same shape as the fn_poker_diamond_tournament_unregister case in
-- 20260921022420.
--
-- HOW IT WAS TIED TO ITS MIGRATION. ca-guard-defs-hourly runs at '25 * * * *',
-- so a notice at 03:25Z is a change made in the 02:25-03:25 window, and
-- 20260921030445 (03:04:45Z) sits inside it. That migration carries NO
-- 'CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer' - it is
-- source surgery. It reads pg_get_functiondef, splices a rakeback refusal
-- block in after a named needle, and EXECUTEs the result:
--
--   source      := pg_get_functiondef('public.fn_club_members_ledger_writer()')
--   needle      := '  cat := COALESCE(NULLIF(current_setting(...
--   replacement := needle || <the $r$ ... $r$ fragment>
--   EXECUTE replace(source, needle, replacement)
--
-- That is why the live prosrc appears verbatim nowhere in the migration text,
-- and why the evidence here is ARITHMETIC rather than textual: applying that
-- migration's own documented edit to the PREVIOUS captured baseline reproduces
-- the live definition exactly, md5 d9b0429e6c88b7a2dc4e732edab6ed10. Measured
-- on production before this file was written. That is stronger than a
-- substring match - it proves 20260921030445 is not merely a plausible author
-- but the SOLE and COMPLETE one, because nothing is left over once its own
-- edit is applied. It is also the only migration in the entire installed
-- history carrying either needle this file asserts.
--
-- The needle and the fragment are read OUT OF THE INSTALLED MIGRATION at run
-- time rather than copied into this file, so this declaration cannot drift
-- from the text it is vouching for.
--
-- WHY THE OMISSION IS NOT FIXED IN THE MIGRATION ITSELF. It is installed.
-- Adding the call now would put a statement in this repository that production
-- never ran, and it would still not move declared_ref, because an applied
-- migration is not applied again. The file would claim the declaration
-- happened, the database would disagree, and a rebuild from these files would
-- diverge from production silently. So the installed text is left exactly as
-- it ran and the omission is recorded forward, which is the same shape as
-- 20260921003008, 20260921022420 and 20260918014359.
--
-- WHAT THIS DOES. It records one declaration and nothing else. It does not
-- touch a function body, a grant, an owner, a trigger, a row of money, the
-- watcher, or the notice itself. A different installed history, a different
-- live definition, a different owner, ACL or trigger binding, or a baseline
-- somebody else has already re-declared must make it refuse rather than bless
-- a drift nobody reviewed, so every one of those facts is asserted first -
-- including the PRE-STATE of declared_ref, which is what proves no second
-- declaration raced this one.
--
-- IT CARRIES NO DDL, so the break-window event triggers do not apply to it and
-- it reloads no schema cache. It is still one transaction.
--
-- STILL OWED AFTER THIS, and it is a person's job, not this file's: notice
-- 718898db is open on the board and does not close itself.
--
-- @live-proof: (SELECT count(*) FROM public.ca_guard_defs WHERE proname = 'fn_club_members_ledger_writer' AND declared_ref LIKE '%20260921035446%') = 1
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $declare_installed_ledger_writer$
DECLARE
  v_expected constant text := 'd9b0429e6c88b7a2dc4e732edab6ed10';
  v_prior    constant text := 'e7cae5f2fc19ef0d2c47e528764abd5a';
  v_stale    constant text := 'migration 20260917230925_cash_funding_retains_original_participant_custody; omitted declaration recorded by migration 20260918014359_declare_the_installed_original_club_funding_guard';
  v_needle   constant text := $needle$  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');$needle$;
  v_body     text;
  v_frag     text;
  v_old      text;
  v_declared text;
  v_was      text;
BEGIN
  SELECT array_to_string(statements, E'\n') INTO v_body
    FROM supabase_migrations.schema_migrations
   WHERE version = '20260921030445'
     AND name = 'rakeback_payouts_carry_their_document_and_run_identity'
     AND cardinality(statements) = 1
     AND encode(extensions.digest(convert_to(array_to_string(statements, E'\n'), 'UTF8'), 'sha256'), 'hex')
       = 'cdd7d740a8e6a681b9e5824a5a14223a6661a54ca1f590c9a0841c7c7170f483';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'ledger writer declaration refuses unmatched installed migration history';
  END IF;

  -- That migration carries no CREATE OR REPLACE for this function. It names the
  -- needle it splices after and the fragment it splices in; read both out of
  -- the installed text so this file cannot drift from what actually ran.
  IF position(v_needle IN v_body) = 0
     OR position($marker$source:=pg_get_functiondef('public.fn_club_members_ledger_writer()'::regprocedure);$marker$ IN v_body) = 0
     OR position($marker$EXECUTE replace(source,needle,replacement);$marker$ IN v_body) = 0 THEN
    RAISE EXCEPTION 'ledger writer declaration refuses: 20260921030445 does not splice this function by this needle';
  END IF;
  v_frag := substring(v_body FROM position('$r$' IN v_body) + 3
                      FOR position('$r$;' IN v_body) - position('$r$' IN v_body) - 3);
  IF v_frag IS NULL OR length(v_frag) <> 1313
     OR position('RAKEBACK IS NOT JOURNALLED FROM HERE (2026-09-21)' IN v_frag) = 0
     OR position('rakeback_requires_accounting_authority' IN v_frag) = 0 THEN
    RAISE EXCEPTION 'ledger writer declaration refuses: the spliced fragment is not the one measured (% chars)',
      COALESCE(length(v_frag), -1);
  END IF;

  SELECT def_text INTO v_old FROM public.ca_guard_def_history
   WHERE proname = 'fn_club_members_ledger_writer' AND def_hash = v_prior;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'ledger writer declaration refuses: predecessor baseline % is not in captured history', v_prior;
  END IF;
  IF position('RAKEBACK IS NOT JOURNALLED FROM HERE' IN v_old) > 0 THEN
    RAISE EXCEPTION 'ledger writer declaration refuses: the predecessor baseline already carries the fragment';
  END IF;

  -- THE PROOF. That migration's own edit, applied to the previous baseline,
  -- must reproduce the live definition byte for byte and leave nothing over.
  IF md5(replace(v_old, v_needle, v_needle || v_frag)) IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'ledger writer declaration refuses: 20260921030445 edit does not reproduce the live definition';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_club_members_ledger_writer') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.fn_club_members_ledger_writer()')
        AND md5(pg_get_functiondef(p.oid)) = v_expected
        AND pg_get_userbyid(p.proowner) = 'postgres'
        AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
        AND (SELECT count(*) FROM pg_trigger t
              WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) = 1
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'club_members'
        AND t.tgname = 'trg_club_members_audit_chip_movement'
        AND NOT t.tgisinternal
        AND t.tgenabled <> 'D'
        AND t.tgfoid = to_regproc('public.fn_club_members_ledger_writer')
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.fn_ca_declare_guard_redefinition(text,text)')
        AND md5(pg_get_functiondef(p.oid)) = '3a3746dc6e0a5b7a1db97805588c0eb8'
        AND pg_get_userbyid(p.proowner) = 'postgres'
        AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
    ) THEN
    RAISE EXCEPTION 'ledger writer declaration refuses changed definition, owner, grants, or trigger binding';
  END IF;

  SELECT declared_ref INTO v_was FROM public.ca_guard_defs
   WHERE proname = 'fn_club_members_ledger_writer';
  IF v_was IS DISTINCT FROM v_stale THEN
    RAISE EXCEPTION 'ledger writer baseline no longer carries the stale ref this file was written to replace; it carries %',
      COALESCE(v_was, 'NULL');
  END IF;
  RAISE NOTICE 'fn_club_members_ledger_writer baseline was owned by a STALE ref: % (declared for the earlier hash %)', v_was, v_prior;

  v_declared := public.fn_ca_declare_guard_redefinition(
    'fn_club_members_ledger_writer',
    'migration 20260921030445_rakeback_payouts_carry_their_document_and_run_identity; omitted declaration recorded by migration 20260921035446_declare_the_installed_rakeback_journal_writer_guard (replaces a stale ref left by 20260918014359_declare_the_installed_original_club_funding_guard)'
  );
  IF v_declared IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'ledger writer declaration changed during recording';
  END IF;
END;
$declare_installed_ledger_writer$;
COMMIT;
