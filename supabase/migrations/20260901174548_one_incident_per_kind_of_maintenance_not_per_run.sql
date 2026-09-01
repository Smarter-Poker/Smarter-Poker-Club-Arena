-- My own alarm, fixed forty minutes after I shipped it.
--
-- deleting_the_journal_must_announce_itself deduped on a hash of the FULL
-- app.ledger_maintenance reason, on the assumption that one maintenance action
-- carries one reason. That holds for a named operation like
-- 'dan-2026-09-01-deep-stack-clean-funding-redo'. It does not hold for the
-- certification cleanup, which stamps a fresh uuid per run
-- ('certification-cleanup:<uuid>') and runs continuously - so it raised a new
-- incident every run, six in eight minutes, and would have kept going forever.
--
-- An alarm that floods the board is not a stricter alarm, it is a broken one:
-- it buries the deletion that actually matters under the routine one, which is
-- the exact failure this whole change set has been undoing all day.
--
-- So the key now uses the reason PREFIX before the first colon, plus the day.
-- 'certification-cleanup:<uuid>' collapses to one incident a day whose
-- occurrence count is the number of rows it removed, while a distinct named
-- action still gets an incident of its own. Nothing is hidden; the same events
-- are reported, grouped the way a person would group them.

CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
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

    /* One incident per KIND of maintenance per day, not per run. A reason of
       the form 'thing:<uuid>' groups under 'thing'; occurrences count the rows.
       See one_incident_per_kind_of_maintenance_not_per_run. */
    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind
          || ':' || to_char(now(), 'YYYY-MM-DD'),
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
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
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

UPDATE public.ca_guard_defs d
   SET def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only'),
       updated_at = now()
 WHERE d.proname = 'fn_ca_journal_append_only';

REVOKE ALL ON FUNCTION public.fn_ca_journal_append_only() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_journal_append_only';
  IF v_src NOT LIKE '%reason_kind%' THEN
    RAISE EXCEPTION 'the per-kind dedupe did not land';
  END IF;
  IF v_src NOT LIKE '%P0403%' OR v_src NOT LIKE '%ca_ledger_mutation_log%' THEN
    RAISE EXCEPTION 'the patch dropped the refusal or the evidence write';
  END IF;
END $$;