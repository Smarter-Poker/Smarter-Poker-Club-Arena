-- 4,317 rows left the financial journal today and nothing said a word.
--
-- At 14:34:39 a maintenance operation deleted 4,317 rows from chip_ledger and
-- 1,002 from chip_transactions - 97,085,751.26 chips of recorded movement,
-- all for one club - under the reason
-- 'dan-2026-09-01-deep-stack-clean-funding-redo'.
--
-- The append-only guard did its job: it refused to allow the delete without
-- app.ledger_maintenance being set, and it copied every deleted row whole into
-- ca_ledger_mutation_log, so nothing is actually lost and the evidence is
-- recoverable. That part worked exactly as designed.
--
-- What it did not do is TELL ANYONE. No incident was raised, nothing reached
-- the dashboard, and no push went out. Meanwhile the same board was carrying a
-- critical for a 370.60 chip supply wobble. A platform that pages on a
-- three-hundred-chip rounding artifact and stays silent while ninety-seven
-- million chips of history are deleted has its alarms the wrong way round.
--
-- The bypass stays - blocking it would strand legitimate maintenance mid-way,
-- and the directive is explicit that a drift response must never lock the
-- platform. What changes is that using it is now an event with a name.
--
-- One incident per maintenance action, not per row: the dedupe key is the
-- table, the operation and a hash of the stated reason, so a 4,317-row delete
-- collapses to a single incident whose occurrence count IS the row count. The
-- raise is wrapped so that it can never, under any circumstance, break the
-- maintenance write it is reporting on - an alarm that can abort the operation
-- it watches is worse than no alarm.

CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    /* SAY SO (2026-09-01). Logging without alerting is how 4,317 rows and
       97,085,751.26 chips of journal history left this table in silence. One
       incident per maintenance action - the dedupe key is table, operation and
       reason, so a bulk delete collapses into a single incident whose
       occurrence count is the row count. Wrapped so it can never abort the
       write it is reporting on. */
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || md5(v_reason),
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;

-- Re-baseline in the same migration that changed it.
UPDATE public.ca_guard_defs d
   SET def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only'),
       updated_at = now()
 WHERE d.proname = 'fn_ca_journal_append_only';

DO $$
DECLARE v_src text; v_base int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only';
  IF v_src NOT LIKE '%journal-bypass:%' THEN
    RAISE EXCEPTION 'the bypass alarm did not land in fn_ca_journal_append_only';
  END IF;
  IF v_src NOT LIKE '%ca_ledger_mutation_log%' THEN
    RAISE EXCEPTION 'the patch dropped the mutation log write - evidence would be lost';
  END IF;
  IF v_src NOT LIKE '%P0403%' THEN
    RAISE EXCEPTION 'the patch dropped the refusal - the journal would no longer be append-only';
  END IF;

  SELECT count(*) INTO v_base FROM public.ca_guard_defs d
   WHERE d.proname = 'fn_ca_journal_append_only'
     AND d.def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only');
  IF v_base <> 1 THEN
    RAISE EXCEPTION 'fn_ca_journal_append_only was not re-baselined';
  END IF;
END $$;
