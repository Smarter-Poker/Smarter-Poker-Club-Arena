-- 20261015024752_a_finding_with_no_amount_is_not_a_chip_drift.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A FINDING WITH NO AMOUNT IS NOT A CHIP DRIFT (2026-10-15)
--
-- The owner's board carried nine open "financial_incident:0.00 chip drift:
-- ledger_imbalance" rows on 2026-10-15, two of them in the last day
-- (2026-10-13 22:52, 2026-10-14 08:52 and 14:52 UTC). Every one was a
-- liveness finding: fn_ca_conservation_sweep:fn_ca_knockout_door_stalled,
-- "1 finding(s) on the ledger layer". No chip was unaccounted for. Read from
-- rows: fn_ca_raise_drift_incident builds the push headline as
--   to_char(COALESCE(p_discrepancy,0), ...) || ' chip drift: ' || v_class
-- for every chip-currency finding, and the sweep files every finding as
-- ledger_imbalance with discrepancy 0. fn_ca_incident_notify already lets
-- the named liveness detectors through at 0.00 and already rewrites their
-- BODY to say what was found ("drift 0.00 chips reads as a rounding error,
-- and an alert that reads like a rounding error gets ignored"), but the
-- HEADLINE, which becomes the notification title and the alert name, still
-- said "0.00 chip drift". A page that names a drift of nothing is itself the
-- defect: it reads as noise and it hides which check fired.
--
-- THE FIX: a chip finding with no amount is headlined by the detector that
-- found it and its severity ("<source> is critical"), the same form the
-- Diamond rule headline already uses for a finding without an amount. A
-- finding with an amount keeps "<amount> chip drift: <classification>" word
-- for word, and Diamond findings are untouched. The notify gates, the
-- incident row, the financial_alerts row and the dedupe are unchanged.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (e6dac566...), the one anchor
-- must occur exactly once, and the result must hash to the postimage derived
-- read-only on production with replace(); owner, SECURITY DEFINER, volatility,
-- proconfig and grants must not move. Nothing here writes a row.
--
-- Regression: scripts/ci/test-a-finding-with-no-amount-is-not-a-chip-drift.py
-- (native PostgreSQL), run by
-- .github/workflows/settler-lag-reads-what-the-settler-reads.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure)) = 'b5025fd1a0f856767f3a91166722ed7f')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_zero_headline_subst(p_sig text, p_before text, p_after text,
                                               p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[]; v_vol "char";
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

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.provolatile
    INTO v_acl, v_owner, v_secdef, v_cfg, v_vol
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
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg
                    AND p.provolatile = v_vol) THEN
    RAISE EXCEPTION '%: owner, security, volatility, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_zero_headline_subst(
  'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)',
  'e6dac566804430737ee80da0a1801b40', 'b5025fd1a0f856767f3a91166722ed7f',
  ARRAY[$o1$      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           ELSE to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class END,$o1$],
  ARRAY[$n1$      CASE WHEN v_currency = 'diamonds' THEN v_diamond_headline
           /* A FINDING WITH NO AMOUNT IS NOT A CHIP DRIFT (2026-10-15). A
              liveness check (the knockout door, tables that cannot deal)
              files at 0.00 and is let through by fn_ca_incident_notify; its
              title named "0.00 chip drift" and hid which check fired. It is
              headlined by its detector, as a Diamond rule already is. */
           WHEN COALESCE(p_discrepancy, 0) = 0 THEN p_source || ' is ' || v_sev
           ELSE to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class END,$n1$]
);

COMMIT;
