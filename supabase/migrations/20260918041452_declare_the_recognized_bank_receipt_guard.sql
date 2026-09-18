-- 20260918041452_declare_the_recognized_bank_receipt_guard.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- DECLARE THE RECOGNIZED BANK RECEIPT GUARD.
--
-- WHAT WAS WRONG (measured on production 2026-09-18, 04:05 UTC)
--
-- UndeclaredTriggerOnAMoneyTable has been firing critical, page: sms, since
-- the accounting release went in:
--
--   fn_undeclared_money_triggers() ->
--     chip_ledger | accounting_tournament_recognized_bank_immutable
--                 | fn_accounting_tournament_recognized_evidence_immutable
--
-- ca_declared_money_triggers holds 216 rows and its convention, written into
-- the 2026-09-12 baseline note, is that "anything created after this date
-- declares itself in its own migration". This one did not. A critical alert
-- that means "an unreviewed trigger may be live on chip_ledger" is worth
-- exactly as much as the accuracy of that table, and an undeclared but
-- legitimate guard spends the alert's credibility for nothing.
--
-- WHAT IT ACTUALLY IS
--
-- On chip_ledger the guard fires BEFORE DELETE OR UPDATE and does one thing:
-- if the row is the bank_journal_id of a recorded accounting recognition, it
-- raises recognized_tournament_fee_bank_receipt_is_immutable. Otherwise it
-- returns OLD or NEW unchanged. It writes nothing, moves no chips, and exists
-- to stop a recognized tournament fee's bank receipt from being rewritten
-- after the fact. It is the chip_ledger half of the pair whose rake_records
-- half protects the fee evidence itself.
--
-- The preconditions below pin that reading rather than taking it on trust: the
-- trigger's exact definition, and that its function contains no INSERT INTO,
-- no UPDATE ... SET and no DELETE FROM. A declaration asserts a review, so the
-- migration proves the thing it is asserting before it writes the row.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The trigger is the one this migration reviewed, it cannot
--    write, and it is not already declared.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_def text;
  v_src text;
BEGIN
  SELECT pg_get_triggerdef(t.oid), p.prosrc
    INTO v_def, v_src
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND c.relname = 'chip_ledger'
     AND t.tgname = 'accounting_tournament_recognized_bank_immutable';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'precondition: chip_ledger has no accounting_tournament_recognized_bank_immutable trigger to declare';
  END IF;

  IF v_def IS DISTINCT FROM
     'CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable()'
  THEN
    RAISE EXCEPTION 'precondition: the trigger is not the definition this migration reviewed: %', v_def;
  END IF;

  -- A guard that can write is not a guard, and this declaration says it is one.
  IF v_src ~* '(^|[^a-z_])(insert[[:space:]]+into|update[[:space:]]+[a-z_."]+[[:space:]]+set|delete[[:space:]]+from)' THEN
    RAISE EXCEPTION 'precondition: fn_accounting_tournament_recognized_evidence_immutable contains a write statement; it is not a refusal-only guard';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ca_declared_money_triggers d
     WHERE d.table_name = 'chip_ledger'
       AND d.trigger_name = 'accounting_tournament_recognized_bank_immutable'
  ) THEN
    RAISE EXCEPTION 'precondition: already declared; nothing to do';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE DECLARATION.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_declared_money_triggers(table_name, trigger_name, note) VALUES
  ('chip_ledger', 'accounting_tournament_recognized_bank_immutable',
   'Refusal-only guard: BEFORE DELETE OR UPDATE, raises recognized_tournament_fee_bank_receipt_is_immutable when the row is the bank_journal_id of a recorded accounting_tournament_fee_recognitions row, and returns OLD/NEW unchanged otherwise. No monetary mutation. Shipped by the accounting release without its declaration; reviewed and declared 2026-09-18 against its exact trigger definition and a proof that its function contains no write statement.');

-- ---------------------------------------------------------------------------
-- 2. POSTCONDITION. The observer that raises the critical alert is satisfied.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_rows integer;
  v_first text;
BEGIN
  SELECT count(*), min(table_name || '.' || trigger_name)
    INTO v_rows, v_first
    FROM public.fn_undeclared_money_triggers();
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'postcondition: % money trigger(s) still undeclared, first is %', v_rows, v_first;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.ca_declared_money_triggers d
     WHERE d.table_name = 'chip_ledger'
       AND d.trigger_name = 'accounting_tournament_recognized_bank_immutable'
  ) THEN
    RAISE EXCEPTION 'postcondition: the declaration row is not present';
  END IF;
END
$post$;

COMMIT;
