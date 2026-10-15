-- 20261015094418_every_hand_projection_takes_its_players_in_one_order.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- EVERY HAND PROJECTION TAKES ITS PLAYERS IN ONE ORDER (2026-10-15)
--
-- The deadlock, read from postgres_logs (2026-10-15 00:15:43 and 03:20:55
-- UTC; 40P01): two fn_project_hand_side_effects calls, one hand each at two
-- different tables of the same club with players in common, each "while
-- inserting index tuple ... in relation player_stats" at
-- fn_project_hand_side_effects_after_post_commit_20260908 line 159
-- (Projection 2, the legacy player_stats fold/winnings insert).
--
-- Projection 2 is already ordered (ORDER BY s.uid::uuid, live since #5542's
-- era), and the deadlocks continued, because one hand transaction touches a
-- player's player_stats row in THREE passes, each ordered on its own:
--   1. rake        atomic_distribute_rake -> apply_rakeback_player_stats
--   2. promo       promo_apply_playthrough, per promo player (user order)
--   3. projection  Projection 2, every seated player (uuid order)
-- Hand X can hold player B's row from pass 2 and want player A's in pass 3,
-- while hand Y holds A's from pass 2 and wants B's. Each pass is ordered; the
-- transaction is not.
--
-- The fix: one order for the whole transaction. fn_project_hand_side_effects
-- takes a transaction-scoped advisory lock per seated player, in uuid order,
-- BEFORE any pass runs (after the per-table post-commit lock, before the
-- obligations). Two hands that share a player now meet at the first shared
-- player's lock, before either has touched a player_stats row, and the
-- second simply waits for the first. Hands with no player in common do not
-- contend. Nothing about what is written or credited changes; the advisory
-- locks are released at commit.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545
-- (live md5 read on production 2026-10-15; postimage derived read-only on
-- production with replace(); owner, SECURITY DEFINER, proconfig and grants
-- must not move).
--
-- Regression: scripts/ci/test-deadlock-lock-orders-r5.py (native PostgreSQL,
-- two sessions), run by .github/workflows/deadlock-lock-orders-r5.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_project_hand_side_effects(uuid)'::regprocedure)) = '5dbf4d0b1717a7ad0497f26c99ab2767')

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
  'public.fn_project_hand_side_effects(uuid)',
  'fefbd3c58b8de6ba3c21c8acea1de884', '5dbf4d0b1717a7ad0497f26c99ab2767',
  ARRAY[$o1$  v_post_commit jsonb;
BEGIN
$o1$,
        $o2$  v_post_commit :=
    public.fn_ca_process_hand_post_commit_obligations(p_hand_id);
$o2$],
  ARRAY[$n1$  v_post_commit jsonb;
  v_seat_uid uuid;
BEGIN
$n1$,
        $n2$  /* LOCK ORDER 2b (20261015094418): one player order for the whole
     transaction. The rake, promo and projection passes below each touch a
     player's player_stats row, each in its own order; two hands sharing
     players deadlocked between passes. Every seated player is claimed here,
     in uuid order, before any pass runs. */
  FOR v_seat_uid IN
    SELECT DISTINCT (pl->>'userId')::uuid
      FROM public.hand_history h,
           jsonb_array_elements(CASE WHEN jsonb_typeof(h.players) = 'array'
                                     THEN h.players ELSE '[]'::jsonb END) pl
     WHERE h.id = p_hand_id
       AND (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('player-stats:' || v_seat_uid::text, 0));
  END LOOP;

  v_post_commit :=
    public.fn_ca_process_hand_post_commit_obligations(p_hand_id);
$n2$]
);

COMMIT;
