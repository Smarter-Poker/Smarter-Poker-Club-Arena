-- 20261008044926_the_spin_reserve_gauge_counts_only_pools_that_funded_a_spin
--
-- Version reserved by scripts/new-migration.mjs on 2026-10-08 04:49:26 UTC.
--
-- THE SPIN RESERVE GAUGE COUNTS ONLY POOLS THAT FUNDED A SPIN (2026-10-08)
--
-- SpinReservePoolThin (poker_spin_reserve_thin_clubs > 0 for 30m) has fired
-- continuously since 2026-10-02 with "641 club(s) cannot cover Spin's top
-- tier". Measured read-only on production 2026-10-08: v_spin_reserve_health
-- has 645 pools; 641 are thin, and every one of those 641 has balance 0,
-- spin_count 0 and no Spin tournament in the last 7 days. They are empty
-- pools of clubs that have never run a Spin, so no draw anywhere is
-- constrained by them. The 4 pools that do fund Spins (281,203 spins between
-- them) are all above the thin line. The gauge therefore pages for ever on
-- nothing, which is exactly the alarm that gets muted (CLAUDE.md 10.84).
--
-- The fix, in fn_spin_metrics only: a pool counts toward
-- reserve_thin_clubs once it has funded a Spin (spin_count > 0). A pool that
-- runs Spins and drops below the line still pages. The view, the draw and
-- every other gauge are untouched. Detector-only: it moves no money.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (9a85c178...), the one anchor
-- must occur exactly once (measured read-only on production 2026-10-08: 1),
-- and the result must hash to the derived postimage (computed read-only on
-- production the same way with replace()); owner, SECURITY DEFINER,
-- volatility, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-spin-reserve-thin.py (native PostgreSQL), run
-- by .github/workflows/spin-reserve-thin.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_spin_metrics(integer)'::regprocedure)) = 'd216239e859c33741cdd09f54f74f13f')

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
  'public.fn_spin_metrics(integer)',
  '9a85c17823966c26901422a473dcb911', 'd216239e859c33741cdd09f54f74f13f',
  ARRAY[$so1$      count(*) filter (where is_thin)::bigint as thin_clubs,
$so1$],
  ARRAY[$sn1$      -- A POOL THAT HAS NEVER FUNDED A SPIN LOCKS NOTHING OUT (2026-10-08).
      -- 641 of 645 pools are empty pools of clubs that have never run a Spin
      -- (spin_count 0, balance 0); counting them paged SpinReservePoolThin for
      -- ever on clubs where no draw is constrained. A pool counts once it has
      -- funded a Spin.
      count(*) filter (where is_thin and coalesce(spin_count, 0) > 0)::bigint as thin_clubs,
$sn1$]
);

COMMIT;
