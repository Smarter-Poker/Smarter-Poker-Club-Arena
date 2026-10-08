-- 20261008044146_the_rake_audit_reads_a_diamond_hand_s_accrual_as_its_banked_
--
-- Version reserved by scripts/new-migration.mjs on 2026-10-08 04:41:46 UTC.
--
-- THE RAKE AUDIT READS A DIAMOND HAND'S ACCRUAL AS ITS BANKED RAKE (2026-10-08)
--
-- fn_rake_bbj_audit raises a critical RAKE_BBJ_INVARIANT_VIOLATION every hour
-- (store classes fn_rake_bbj_audit and financial_alerts:fn_rake_bbj_audit),
-- always I7_raked_hand_never_banked = 20, which is the LIMIT of its sample,
-- not the count. Every flagged hand is a cash hand at a DIAMOND club. Measured
-- read-only on production 2026-10-08 over the last two hours: 9,953 raked
-- chip-club hands, 0 without a rake_records row; 277 raked diamond-club hands,
-- 277 without a rake_records row, and for each of the 256 past the five-minute
-- grace the ca_diamond_rake_accrual rows (kind 'rake') sum to exactly
-- hand_history.rake_amount (14,344 of 14,344).
--
-- That is by design: fn_ca_process_hand_post_commit_obligations refuses chip
-- obligations on a diamond hand (diamond_hand_has_chip_obligations), so a
-- diamond hand never gets a rake_records row; its rake is banked per payer in
-- ca_diamond_rake_accrual. I7 only knows rake_records, so it reads every
-- diamond hand as a genuine loss. No chips are missing.
--
-- The fix, in I7 only: a diamond-club hand whose rake accrual sums to exactly
-- its rake is banked. A diamond hand with no accrual, or a short one, still
-- counts, so the invariant keeps guarding the diamond path too. Chip clubs are
-- untouched. Detector-only: it moves no money and writes nothing.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (9360904177348173...), the one
-- anchor must occur exactly once (measured read-only on production
-- 2026-10-08: 1), and the result must hash to the derived postimage (computed
-- read-only on production the same way with replace()); owner, SECURITY
-- DEFINER, volatility, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-rake-audit-diamond-accrual.py (native
-- PostgreSQL), run by .github/workflows/rake-audit-diamond-accrual.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_rake_bbj_invariants(integer)'::regprocedure)) = 'f0cfc5a0b6a7a362e400ee01081804c0')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_audit_subst(
  'public.fn_rake_bbj_invariants(integer)',
  '9360904177348173aac4d07e3a4ed091', 'f0cfc5a0b6a7a362e400ee01081804c0',
  ARRAY[$ro1$                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
$ro1$],
  ARRAY[$rn1$                                AND rr2.metadata->>'hand_number' = hh.hand_number::text)
             -- A DIAMOND CLUB BANKS ITS RAKE IN ca_diamond_rake_accrual, NOT
             -- rake_records (2026-10-08). The post-commit consumer refuses chip
             -- obligations on a diamond hand (diamond_hand_has_chip_obligations),
             -- so such a hand never has a rake_records row. It is banked when its
             -- accrual rows sum to exactly the hand's rake; anything less stays I7.
             AND NOT EXISTS (SELECT 1 FROM clubs dc
                              WHERE dc.id = t.club_id
                                AND dc.asset = 'diamonds'
                                AND (SELECT COALESCE(sum(a.amount), 0)
                                       FROM ca_diamond_rake_accrual a
                                      WHERE a.table_id = hh.table_id
                                        AND a.hand_number = hh.hand_number
                                        AND a.kind = 'rake') = hh.rake_amount)
$rn1$]
);

COMMIT;
