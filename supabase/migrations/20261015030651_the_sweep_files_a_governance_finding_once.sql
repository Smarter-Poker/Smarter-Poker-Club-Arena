-- 20261015030651_the_sweep_files_a_governance_finding_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SWEEP FILES A GOVERNANCE FINDING ONCE (2026-10-15)
--
-- fn_union_governance_check() ends with
--   UNION ALL SELECT * FROM fn_union_credit_risk_check()
-- so every credit-risk row is already a governance row. fn_ca_conservation_sweep
-- nevertheless ran both, and filed each credit-risk finding twice under two
-- sources. On 2026-10-15 the board held 74 + 12 governance rows and 34 + 10
-- credit-risk rows for one condition (union_eco_not_recorded, the Midway week
-- 2026-10-05..12 whose close had not yet written its union_eco_ledger row), and
-- every recurrence paged twice.
--
-- THE FIX: the sweep runs the governance check, which carries the credit-risk
-- rows with their own invariant names, and no longer runs the credit-risk check
-- a second time. fn_union_credit_risk_check itself is unchanged and is still
-- read by the governance check and by every other caller. The migration refuses
-- if the governance check no longer includes the credit-risk check, so a
-- credit-risk finding can never go unreported.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (69e18c18...), the one anchor
-- must occur exactly once, and the result must hash to the postimage derived
-- read-only on production with replace(); owner, SECURITY DEFINER, volatility,
-- proconfig and grants must not move. Nothing here writes a row.
--
-- Regression: scripts/ci/test-the-sweep-files-a-governance-finding-once.py
-- (native PostgreSQL), run by
-- .github/workflows/settler-lag-reads-what-the-settler-reads.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_conservation_sweep()'::regprocedure)) = '81995d0a3590cab15132df5b1ef609e8')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF position('SELECT * FROM fn_union_credit_risk_check()' IN
              pg_get_functiondef('public.fn_union_governance_check()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_union_governance_check no longer includes fn_union_credit_risk_check; the sweep must keep running it';
  END IF;
END $guard$;

CREATE FUNCTION pg_temp.ca_sweep_once_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_sweep_once_subst(
  'public.fn_ca_conservation_sweep()',
  '69e18c182275d84f3ed624e53fd8bcf9', '81995d0a3590cab15132df5b1ef609e8',
  ARRAY[$o1$      ('fn_union_credit_risk_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_credit_risk_check() limit 20) t',
       'warning'),
      ('fn_union_governance_check',$o1$],
  ARRAY[$n1$      /* ONE FINDING IS FILED ONCE (2026-10-15). fn_union_governance_check
         ends with UNION ALL SELECT * FROM fn_union_credit_risk_check(), so
         running both filed every credit-risk finding twice under two
         sources. The governance check carries those rows with their own
         invariant names. Migration 20261015030651. */
      ('fn_union_governance_check',$n1$]
);

COMMIT;
