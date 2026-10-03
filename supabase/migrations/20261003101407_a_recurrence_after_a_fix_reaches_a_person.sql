-- 20261003101407_a_recurrence_after_a_fix_reaches_a_person.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A RECURRENCE AFTER A FIX REACHES A PERSON (phase 5 of 9: alerts reach a
-- person). Full account: docs/changelog/2026-10-03-a-recurrence-after-a-fix-reaches-a-person.md.
--
-- fn_ca_incident_notify records every page against the FINDING in
-- ca_incident_notify_ledger, and sends again only when the finding's state
-- hash changes (tests/one-page-per-finding.law.test.ts). That law's own
-- proof reads "resolved, then recurs -> 1 (a resolved finding re-arms)": a
-- resolution used to write the ledger with kind 'resolved', so the next raise
-- carried a different state and paged.
--
-- On 2026-09-06 "a fix is not a page" moved the resolved case in front of the
-- ledger write, correctly withholding the push, and silently took the re-arm
-- with it. Since then a finding that came back after its fix carried exactly
-- the state it was last paged with and was filed as already reported. Read
-- from production 2026-10-03 (ca_incident_events, 14 days): 29 critical
-- recurrences that passed every one of Dan's gates were muted that way, 28 of
-- them after their earlier episode had been resolved, the oldest against a
-- page sent on 2026-09-05. Among them: the kill switch (-2,624.78) on 09-21
-- and 10-02, the unexplained chip supply (-100,005.30) on 10-02, the ledger
-- replay, the nightly reconcile, and the liveness findings for tables that
-- cannot deal and orphaned running tournaments.
--
-- The ledger update now also fires when the incident is a different one from
-- the incident last paged and that earlier incident is resolved (or gone). A
-- second OPEN incident for the same finding still does not page, a repeat for
-- the same incident still does not page, and a fix, a warning and a 0.00 are
-- still never pages. Rehearsed on production in one rolled-back call with the
-- successor as a pg_temp function: the installed sender returned
-- first=1 same_again=0 second_open=0 the_fix=0 recurs_after_fix=0, the
-- successor first=1 same_again=0 second_open=0 the_fix=0 recurs_after_fix=1,
-- and both 0 for the repeat, a warning and a zero.
--
-- fn_ca_incident_notify is a watched guard, so the redefinition is declared.
-- No chips move, nothing is backfilled, no job is added.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_incident_notify(uuid,text,text,boolean)'::regprocedure)) = '0abfd723b4d2e129d5038e6b849c6288')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  v_oid oid := 'public.fn_ca_incident_notify(uuid,text,text,boolean)'::regprocedure;
  v_def text;
  v_new text;
  c_old CONSTANT text := $o$        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash
      RETURNING true INTO v_fresh;$o$;
  c_new CONSTANT text := $n$        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash
           /* A RECURRENCE AFTER A FIX IS NEWS (2026-10-03). 'A fix is not a
              page' returns before this ledger is written, so a resolution
              never re-armed it: a finding that came back after its fix
              matched the state it was last paged with and was filed as
              already reported. 28 critical recurrences in 14 days reached
              nobody, among them the kill switch (-2,624.78), the supply
              snapshot (-100,005.30) and tables that cannot deal. A new
              incident for a finding whose last paged incident is resolved,
              or gone, is a new episode and pages once. A second open
              incident for the same finding still does not. */
           OR (l.last_incident_id IS DISTINCT FROM EXCLUDED.last_incident_id
               AND NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents p
                                WHERE p.id = l.last_incident_id
                                  AND p.status IS DISTINCT FROM 'resolved'))
      RETURNING true INTO v_fresh;$n$;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) IS DISTINCT FROM '12db60ac332870e31d1c713c3fe4c099' THEN
    RAISE EXCEPTION 'RECURRENCE_PAGE_PREIMAGE_CHANGED';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'RECURRENCE_PAGE_AUTHORITY_CHANGED';
  END IF;
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'RECURRENCE_PAGE_LEDGER_CHANGED';
  END IF;
  v_new := replace(v_def, c_old, c_new);
  IF md5(v_new) IS DISTINCT FROM '0abfd723b4d2e129d5038e6b849c6288' THEN
    RAISE EXCEPTION 'RECURRENCE_PAGE_LEDGER_CHANGED';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_oid)) IS DISTINCT FROM '0abfd723b4d2e129d5038e6b849c6288'
     OR md5(replace(pg_get_functiondef(v_oid), c_new, c_old)) IS DISTINCT FROM '12db60ac332870e31d1c713c3fe4c099' THEN
    RAISE EXCEPTION 'RECURRENCE_PAGE_RESULT_CHANGED';
  END IF;
END
$m$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_incident_notify', 'migration a_recurrence_after_a_fix_reaches_a_person');

COMMIT;
