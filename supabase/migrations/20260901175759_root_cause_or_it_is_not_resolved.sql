-- HARD LAW (Dan, 2026-09-01): resolving an incident means the cause is fixed.
--
-- "I want to ensure that when you find a chip drift or other issue, you aren't
--  just resolving the issue - you're fixing it at its core so it doesn't happen
--  anymore."
--
-- Until now nothing enforced that. fn_ca_incident_action demanded a root cause
-- only when classification = 'unknown', any non-empty string satisfied it, and
-- fn_ca_auto_reconcile_tick sets status='resolved' with a direct UPDATE that
-- never passes through the function at all. Of 119 incidents resolved on
-- 2026-09-01, 58 carry no correction reference of any kind. The assurance
-- rested entirely on whoever was holding the keyboard.
--
-- So the law goes on the TABLE, not in one function. A trigger catches every
-- path - the RPC, the dashboard, an automated repair, an agent with raw SQL -
-- because a rule only one door respects is not a rule.
--
-- TO MOVE AN INCIDENT INTO 'resolved' YOU MUST SUPPLY:
--
--   1. a root cause of at least 40 characters - an actual sentence about what
--      was wrong, not "fixed" or "n/a"; and
--   2. a correction reference naming what makes it not happen again, in one of
--      these forms, each deliberately greppable so the mix can be audited:
--
--        migration <name>        a database change
--        PR #<n>                 a code change
--        chip_ledger <id>        a posted compensating entry
--        correction:<key>        the same, by idempotency key
--        ruling: <text>          an explicit human decision (Dan's call)
--        verified: <evidence>    the cause is provably gone, e.g. a burn-in
--                                window with zero recurrences
--        no-change-needed: <why> investigation proved nothing was wrong - a
--                                false positive or ordinary play misread
--
--      or auto_repair_status = 'repaired', which is the automated reconciler
--      recording that an idempotent re-drive fixed it.
--
-- 'no-change-needed:' is a deliberate escape hatch and it is honest to have
-- one: some alarms are genuinely false, and forcing a fake migration reference
-- would be worse than admitting that. It is greppable precisely so its use can
-- be counted, and it needs its own justification after the colon.
--
-- Reopening is untouched. Nothing about this blocks, delays or locks any table,
-- club, player or game - it governs paperwork, not the floor.
--
-- Probed rolled back: no cause REFUSED, "fixed" REFUSED, a real cause with no
-- prevention REFUSED, cause plus a migration reference ALLOWED, and the
-- automated reconciler's auto_repair_status='repaired' ALLOWED.

CREATE OR REPLACE FUNCTION public.fn_ca_resolution_needs_a_cause()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cause text := btrim(coalesce(NEW.root_cause, ''));
  v_ref   text := btrim(coalesce(NEW.correction_ref, ''));
  v_ok    boolean;
BEGIN
  IF NEW.status <> 'resolved' OR OLD.status = 'resolved' THEN
    RETURN NEW;
  END IF;

  IF length(v_cause) < 40 THEN
    RAISE EXCEPTION
      'An incident is not resolved until the cause is written down. Supply root_cause: what was actually wrong, in a sentence (at least 40 characters). Got %.',
      CASE WHEN v_cause = '' THEN 'nothing' ELSE '"' || v_cause || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  v_ok := coalesce(NEW.auto_repair_status, '') = 'repaired'
       OR v_ref ~* '^(migration\s+\S|PR\s*#\d|chip_ledger\s+\S|correction:\S)'
       OR v_ref ~* '^(ruling:|verified:|no-change-needed:|auto-repair)\s*\S';

  IF NOT v_ok THEN
    RAISE EXCEPTION
      'An incident is not resolved until something stops it happening again. Supply correction_ref as one of: "migration <name>", "PR #<n>", "chip_ledger <id>", "correction:<key>", "ruling: <decision>", "verified: <evidence>", or "no-change-needed: <why>". Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ca_resolution_needs_a_cause ON public.ca_drift_incidents;
CREATE TRIGGER trg_ca_resolution_needs_a_cause
  BEFORE UPDATE ON public.ca_drift_incidents
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_resolution_needs_a_cause();

COMMENT ON FUNCTION public.fn_ca_resolution_needs_a_cause() IS
  'HARD LAW: an incident cannot enter resolved without a root cause of substance '
  'and a correction reference naming what prevents recurrence. On the table rather '
  'than in fn_ca_incident_action, because fn_ca_auto_reconcile_tick and raw SQL '
  'both bypass that function. Added 2026-09-01 at Dan''s instruction.';

REVOKE ALL ON FUNCTION public.fn_ca_resolution_needs_a_cause() FROM PUBLIC, anon, authenticated;

/* The burn-in gate resolves its tracker from evidence rather than a change -
   24 hours of silence at the guard - which is a legitimate resolution and now
   has to say so. One argument, previously NULL. */
DO $patch$
DECLARE
  v_def text;
  v_from text := '''engine exit path fix verified by 24h of silence at the guard'', NULL);';
  v_to   text := '''engine exit path fix verified by 24h of silence at the guard'',
      ''verified: 24h with zero blocked tournament-cashout attempts at the guard'');';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_burnin_gate_tick';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_burnin_gate_tick does not exist'; END IF;
  IF position(v_from in v_def) = 0 THEN
    RAISE EXCEPTION 'the burn-in gate resolve call is not the shape this migration expects - patch it by hand';
  END IF;
  EXECUTE replace(v_def, v_from, v_to);
END $patch$;

UPDATE public.ca_guard_defs d
   SET def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = d.proname),
       updated_at = now()
 WHERE d.proname IN ('fn_ca_burnin_gate_tick');

DO $$
DECLARE v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ca_resolution_needs_a_cause') THEN
    RAISE EXCEPTION 'the law was not attached to ca_drift_incidents';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_burnin_gate_tick';
  IF v_src NOT LIKE '%verified: 24h with zero blocked%' THEN
    RAISE EXCEPTION 'the burn-in gate still resolves without a correction reference';
  END IF;
END $$;
