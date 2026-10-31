-- Phase 3 alert noise, item 2: informational rows of two exact kinds arrive closed.
--
-- 1. ca_diamond_incidents 'DR5:journal_row_deleted_under_maintenance' (info).
--    fn_ca_journal_append_only files one per diamond journal row the hourly
--    maintenance deletes, after archiving that row in ca_diamond_journal_archive
--    (the incident is only filed when the archive insert succeeded). It is a
--    record, never a task: ~1,670 a day sat open until the 7-day info
--    retention in fn_ca_diamond_trial_balance_watch closed them (11,686 open
--    at the time of this change). Only severity 'info' of that exact rule is
--    touched; any other rule or severity arrives exactly as before.
--
-- 2. financial_alerts source 'ca_manual_adjustments', severity 'info', dedupe
--    key 'adj-approved:<id>': the notice that an adjustment was approved.
--    It arrives closed, and it closes the still-open info 'adj:<id>' proposal
--    notice of the same adjustment (fn_ca_reject_manual_adjustment already
--    closes it on rejection; approval never did, so 40 proposal + 40 approval
--    notices of settled adjustments sat open). A proposal that is still
--    pending stays open; the 'adj-self-approval' warning is untouched.
--
-- Both are classification only: no money, wallet, ledger or Diamond Arena
-- state is read or written. Each trigger swallows its own failure so it can
-- never refuse the insert it classifies.

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_notice_arrives_closed()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.rule = 'DR5:journal_row_deleted_under_maintenance' AND NEW.severity = 'info'
     AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
    NEW.resolution := 'auto: informational record (2026-10-31 alert-quality rule). The journal row deleted under '
                      || 'maintenance is preserved in ca_diamond_journal_archive; nothing to triage.';
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER ca_diamond_journal_notice_arrives_closed
  BEFORE INSERT ON public.ca_diamond_incidents
  FOR EACH ROW
  WHEN (NEW.rule = 'DR5:journal_row_deleted_under_maintenance' AND NEW.severity = 'info' AND NEW.resolved_at IS NULL)
  EXECUTE FUNCTION public.fn_ca_diamond_journal_notice_arrives_closed();

CREATE OR REPLACE FUNCTION public.fn_ca_manual_adjustment_approval_notice_is_informational()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
  v_adj text := NEW.context ->> 'adjustment_id';
BEGIN
  IF NEW.resolved IS TRUE OR NEW.source IS DISTINCT FROM 'ca_manual_adjustments'
     OR NEW.severity IS DISTINCT FROM 'info'
     OR coalesce(NEW.context ->> 'dedupe_key', '') NOT LIKE 'adj-approved:%' THEN
    RETURN NEW;
  END IF;
  NEW.resolved := true;
  NEW.resolved_at := now();
  NEW.resolution := format('Informational (2026-10-31 alert-quality rule): manual adjustment %s was approved; '
                           || 'ca_manual_adjustments holds the record. Nothing to triage.', v_adj);
  IF v_adj IS NOT NULL THEN
    BEGIN
      UPDATE public.financial_alerts fa
         SET resolved = true, resolved_at = now(),
             resolution = format('Closed by the approval notice of adjustment %s (2026-10-31 alert-quality rule): '
                                 || 'the proposal is no longer pending.', v_adj)
       WHERE fa.source = 'ca_manual_adjustments' AND NOT fa.resolved AND fa.severity = 'info'
         AND fa.context ->> 'dedupe_key' = 'adj:' || v_adj;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'manual adjustment proposal notice % could not be closed: %', v_adj, SQLERRM;
    END;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER a1_manual_adjustment_approval_notice_is_informational
  BEFORE INSERT ON public.financial_alerts
  FOR EACH ROW
  WHEN (NEW.source = 'ca_manual_adjustments' AND NEW.severity = 'info')
  EXECUTE FUNCTION public.fn_ca_manual_adjustment_approval_notice_is_informational();