-- 20261007215112_the_satellite_audit_finds_a_seat_by_its_payout.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Replaces the 2026-10-01 draft of PR #5708 (20261001151646). That draft also
-- restated fn_tournament_conservation_delta and patched the money-touching
-- payer fn_pay_backed_payout_shortfalls; both have since moved on main
-- (delta 46647067 -> bfbb3e61, payer 90784034 -> 10c5a2d3), and the
-- 2026-10-03 ticket fallback and house_correction term in both already give
-- the payout-keyed answer: read-only on production 2026-10-07, switching
-- either function's two award joins to payout_id moves the delta of none of
-- the 615 events whose joins differ (0.00 net). Those two halves are dropped.
-- Only the audit is still wrong, and it is a detector, not a payer.
--
-- THE SATELLITE AUDIT FINDS A SEAT BY ITS PAYOUT, NEVER BY ITS PLACE (2026-10-07)
--
-- fn_satellite_conservation_audit (run hourly by fn_ca_conservation_sweep and
-- by FeeReconciler.satellite_conservation) counts a funded seat from three
-- sources. Its payout arm joins the award to the payout
-- ON (tournament_id, place = position). A receipt_version 3 satellite keeps
-- the survivor's real finishing position on the payout row, which for an
-- unranked co-qualifier is NULL, while the award keeps its financial slot in
-- place. So the join finds nothing, the seat is not counted, and a satellite
-- that paid every seat reads as undisbursed.
--
-- Live case: "Sunday Deep Stack Satellite $25" (e2ea5f2a, ended 2026-10-07
-- 17:30 UTC). Pool 600.00, three 200.00 seats, three satellite_seat payouts
-- with NULL position, three awards (place 1, 2, 3, delivery seat) each naming
-- its payout by payout_id, escrow closed "atomic satellite terminal receipt:
-- exact zero". The audit reads seats_funded 0, undisbursed 600.00, and pages
-- every hour (fn_satellite_conservation_audit and FeeReconciler intake rows
-- since 17:52 UTC).
--
-- THE FIX: the award's own unique key. tournament_satellite_awards.payout_id is
-- NOT NULL, UNIQUE and a FOREIGN KEY to tournament_payouts, so
-- ON a.payout_id = p.id finds exactly the award the writer recorded for that
-- payout. Measured read-only over every satellite completed in the last 30
-- days (2,738): one changes its seat count (e2ea5f2a, 0 -> 3), it balances,
-- and no satellite becomes flagged that was not.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261003082051. The
-- live text must hash to 462b1c631010e4bab0361967d2da2a75, the anchor must
-- occur exactly once (measured 1), and the result must hash to the postimage
-- derived read-only on production with replace(), 5d847143055fab40063ee1d968f2bb36.
-- Owner, SECURITY DEFINER, proconfig and grants must not move. The grant is
-- then restated explicitly (production already holds exactly this ACL, so it
-- is a no-op live). Not money-touching: no chips, tickets, payouts, ledger
-- legs or alerts are written.
--
-- Regression: scripts/ci/test-satellite-audit-seat-by-payout.py (native
-- PostgreSQL), run by .github/workflows/satellite-audit-seat-by-payout.yml.
--
-- @live-proof: SELECT md5(pg_get_functiondef('public.fn_satellite_conservation_audit(integer)'::regprocedure)) = '5d847143055fab40063ee1d968f2bb36'
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_audit_subst(
  'public.fn_satellite_conservation_audit(integer)',
  '462b1c631010e4bab0361967d2da2a75', '5d847143055fab40063ee1d968f2bb36',
  ARRAY['ON a.tournament_id = p.tournament_id AND a.place = p.position'],
  ARRAY['ON a.payout_id = p.id']
);

REVOKE ALL ON FUNCTION public.fn_satellite_conservation_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_satellite_conservation_audit(integer) TO service_role;

COMMIT;
