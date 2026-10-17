-- 20261015181551_a_diamond_cluster_tick_skips_an_operator_closed_table.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A DIAMOND CLUSTER TICK SKIPS AN OPERATOR CLOSED TABLE
-- ============================================================================
--
-- WHAT HAPPENED, read from production (kuklfnapbkmacvwxktbh) on 2026-10-15:
--
--   17:01:09Z  the owner's close_cash (fb484cc1) closed 115 cash tables,
--              among them the nine tables of the Diamond must-move game
--              f141626a. An operator close leaves a cluster table
--              status 'closed' with lifecycle 'live' until its resume.
--   17:01:16Z  from here every pass of that game failed with 23514
--              diamond_cluster_table_not_admitted: 633 controller_tick_error
--              rows by 18:09, about nine a minute, which is the
--              ClusterPassErrors page (124 to 181 errors per 15 minutes).
--   18:10:56Z  the floor was resumed. Every other cluster reopened its tables
--              (48 running, 9 waiting by 18:20). The Diamond game did not: its
--              nine tables are still 'closed'/'live', and the same error kept
--              firing (103 more rows by 18:19). The game cannot reopen a table
--              because fn_cash_cluster_open_table projects the cluster first,
--              and the projection refuses the whole cluster for the closed
--              siblings. The Diamond cash floor stays dark until this lands.
--
-- THE LINE: fn_poker_diamond_project_cluster's admission check counts every
-- table with lifecycle <> 'closed' and asks fn_poker_diamond_plain_cash_table
-- of it, and that function answers false for status 'closed'. A closed table
-- deals nothing, so it cannot break the plain-cash rule; the check now skips a
-- table whose status is 'closed'. It is judged again the moment it reopens,
-- because the projection runs on every open and every tick.
--
-- HOW: the pinned-preimage substitution of 20261007212545 (live md5, one
-- anchor occurring exactly once, postimage md5 derived read-only on production
-- with replace(), owner, SECURITY DEFINER, proconfig and grants unchanged).
--
-- Regression: scripts/ci/test-diamond-cluster-operator-close.py (native
-- PostgreSQL), run by .github/workflows/diamond-cluster-operator-close.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_poker_diamond_project_cluster(uuid,uuid)'::regprocedure)) = '49d1391b31e6bb2f12fcd803d4e317fd')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_floor_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_floor_subst(
  'public.fn_poker_diamond_project_cluster(uuid,uuid)',
  '06f2ed68958ddf35b5f61eb32b561c46', '49d1391b31e6bb2f12fcd803d4e317fd',
  ARRAY[$o1$   AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
   AND NOT public.fn_poker_diamond_plain_cash_table(t)) THEN$o1$],
  ARRAY[$n1$   AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
   -- A table whose status is closed deals nothing, so it cannot break the
   -- plain-cash rule. An operator close leaves a cluster table status
   -- 'closed' with lifecycle 'live' until its resume, and counting it made
   -- this raise on every pass of the game for the whole park (2026-10-15,
   -- migration 20261015181551). It is judged again the moment it reopens.
   AND t.status IS DISTINCT FROM 'closed'
   AND NOT public.fn_poker_diamond_plain_cash_table(t)) THEN$n1$]
);

COMMIT;
