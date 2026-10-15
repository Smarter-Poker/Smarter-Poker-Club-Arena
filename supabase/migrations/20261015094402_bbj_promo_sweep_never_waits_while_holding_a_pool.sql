-- 20261015094402_bbj_promo_sweep_never_waits_while_holding_a_pool.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE BBJ PROMO SWEEP NEVER WAITS WHILE HOLDING A POOL (2026-10-15)
--
-- The deadlock, read from postgres_logs (2026-10-15 02:25:01, 03:40:01,
-- 09:30:01 UTC; 40P01): fn_project_hand_side_effects ->
-- fn_ca_process_hand_post_commit_obligations line 169,
--   "SELECT p.id FROM public.bbj_pools p WHERE p.union_id = v_union_id
--    AND p.status = 'active' ... FOR UPDATE"
-- waits on fn_sweep_bbj_promo_all (the five-minute driver the workers repo
-- calls), which waits on the hand transaction.
--
-- The two lock orders:
--   hand post-commit   atomic_distribute_rake writes union_wallets and clubs
--                      (the rake legs), THEN locks the union's active
--                      bbj_pools row for the BBJ contribution;
--   promo sweep        locks a bbj_pools row FOR UPDATE, THEN upserts
--                      union_wallets, updates unions (or clubs, for a club
--                      with no union).
-- Opposite orders on the same two rows: whichever loses is killed, and when
-- the loser is the hand, its whole post-commit obligation set (rake, BBJ,
-- promo, insurance) rolls back and is re-driven by the outbox.
--
-- The fix, in the sweep only (the hot path keeps its order): the sweep never
-- waits on any row while it holds a pool. Per pool, inside the existing
-- per-pool sub-transaction, it takes the wallet-side rows first (union_wallets
-- and unions, or the club row) and then the pool, every one with NOWAIT. A
-- row the hand path holds raises lock_not_available, the sub-transaction rolls
-- back (releasing what it took), the pool is counted as busy_retry_next_run,
-- and the promo slice stays in the pool for the next five-minute run. Nothing
-- about what is swept or where it is credited changes: the same amount moves
-- to the same wallet, one run later at worst. A sweep that never waits cannot
-- close a cycle.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545
-- (live md5 read on production 2026-10-15; postimage derived read-only on
-- production with replace(); owner, SECURITY DEFINER, proconfig and grants
-- must not move).
--
-- Regression: scripts/ci/test-deadlock-lock-orders-r5.py (native PostgreSQL,
-- two sessions), run by .github/workflows/deadlock-lock-orders-r5.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_sweep_bbj_promo_all()'::regprocedure)) = 'ff0157072680c056f3beddec28db5bb7')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_lock_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_lock_subst(
  'public.fn_sweep_bbj_promo_all()',
  '11c5feb40c252909a4281e8faf31c9ac', 'ff0157072680c056f3beddec28db5bb7',
  ARRAY[$o1$v_to_club int := 0; v_err int := 0;
$o1$,
        $o2$    BEGIN
      SELECT COALESCE(promo_balance,0) INTO v_promo FROM bbj_pools WHERE id=r.id FOR UPDATE;
      IF v_promo <= 0 THEN CONTINUE; END IF;

      v_union_id := r.union_id;
      IF v_union_id IS NULL AND r.club_id IS NOT NULL THEN
        SELECT union_id INTO v_union_id FROM clubs WHERE id = r.club_id;
      END IF;
$o2$,
        $o3$    EXCEPTION WHEN OTHERS THEN v_err := v_err + 1;
$o3$,
        $o4$'to_union', v_to_union, 'to_club', v_to_club, 'errors', v_err);
$o4$],
  ARRAY[$n1$v_to_club int := 0; v_err int := 0;
  v_busy int := 0;
$n1$,
        $n2$    BEGIN
      -- NEVER WAIT WHILE HOLDING A POOL (20261015094402). The hand path
      -- writes union_wallets / clubs (rake) before it locks the pool (BBJ);
      -- this sweep used the opposite order and deadlocked with it. Every row
      -- is taken here with NOWAIT, wallet side first and the pool last, so a
      -- busy row rolls this pool's sub-transaction back and the promo stays
      -- in the pool for the next run. The amount and its destination do not
      -- change.
      v_union_id := r.union_id;
      IF v_union_id IS NULL AND r.club_id IS NOT NULL THEN
        SELECT union_id INTO v_union_id FROM clubs WHERE id = r.club_id;
      END IF;
      IF v_union_id IS NOT NULL THEN
        PERFORM 1 FROM union_wallets WHERE union_id = v_union_id FOR NO KEY UPDATE NOWAIT;
        PERFORM 1 FROM unions WHERE id = v_union_id FOR NO KEY UPDATE NOWAIT;
        IF r.club_id IS NOT NULL THEN
          PERFORM 1 FROM clubs WHERE id = r.club_id FOR KEY SHARE NOWAIT;
        END IF;
      ELSIF r.club_id IS NOT NULL THEN
        PERFORM 1 FROM clubs WHERE id = r.club_id FOR NO KEY UPDATE NOWAIT;
      END IF;
      SELECT COALESCE(promo_balance,0) INTO v_promo FROM bbj_pools WHERE id=r.id FOR UPDATE NOWAIT;
      IF v_promo <= 0 THEN CONTINUE; END IF;
$n2$,
        $n3$    EXCEPTION
      WHEN lock_not_available THEN v_busy := v_busy + 1;
      WHEN OTHERS THEN v_err := v_err + 1;
$n3$,
        $n4$'to_union', v_to_union, 'to_club', v_to_club, 'errors', v_err,
                            'busy_retry_next_run', v_busy);
$n4$]
);

COMMIT;
