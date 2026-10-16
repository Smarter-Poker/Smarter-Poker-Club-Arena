-- 20261015223846_an_idle_floor_is_not_a_lagging_stats_index.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- AN IDLE FLOOR IS NOT A LAGGING STATS INDEX (2026-10-15)
--
-- WHAT HAPPENED, read from production (kuklfnapbkmacvwxktbh):
--
--   The owner parked the floor at 16:53:27 UTC. The last hand before the
--   resume was written at 17:33:14.738; the next at 18:11:31.961. In between
--   no hand_history row existed for the index to reach, and the index had
--   reached every hand there was: ca_refresh_hand_player_index sets idx_ceil
--   to the created_at of the newest hand it indexed, so the ceiling stood at
--   17:33:14 because nothing newer existed.
--
--   ca_stats_health() reports indexLagSeconds as now() minus that ceiling, so
--   an idle floor reads as lag that grows one second per second.
--   ClubArenaStatsIndexLag (StatsHealthMonitor, 30 minutes) fired at
--   18:03:30 and StatsHandIndexLagging (Prometheus, poker_stats_index_lag_seconds
--   > 1800 for 5m) at 18:12:11 ("38m 15s behind"); both resolved at 18:15
--   and 18:16 once hands flowed again and the roller moved. Nothing was
--   behind: the index was complete the whole time.
--
-- THE FIX, at the line that computes the number: the lag is the age of the
-- oldest hand the index has NOT reached, the first hand_history row newer
-- than the ceiling. When no hand is newer than the ceiling the index is
-- complete and the lag is 0. With hands flowing the oldest unindexed hand is
-- the one right after the ceiling, so a roller that really stops still reads
-- as lag that climbs one second per second, exactly as before, and both
-- alerts keep their 30-minute bar. A NULL ceiling (no index state yet) still
-- reads NULL. The read is one index probe on idx_hand_history_time_identity
-- (measured on production: 0.2 ms).
--
-- Nothing else in ca_stats_health() moves.
--
-- HOW: the pinned-preimage substitution of 20261007212545. The live text must
-- hash to the md5 measured read-only on production on 2026-10-15
-- (93f1d1746cc8e74bc27d368cc1c95b23, the postimage of 20261007212545), the
-- anchor must occur exactly once, and the result must hash to the postimage
-- derived read-only on production with replace(); owner, SECURITY DEFINER,
-- volatility, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-an-idle-floor-is-not-index-lag.py (native
-- PostgreSQL), run by .github/workflows/an-idle-floor-is-not-index-lag.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_stats_health()'::regprocedure)) = 'edbe14c1d8a1c82dd4d210402104e4d1')
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_idle_index_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_idle_index_subst(
  'public.ca_stats_health()',
  '93f1d1746cc8e74bc27d368cc1c95b23', 'edbe14c1d8a1c82dd4d210402104e4d1',
  ARRAY[$o1$    'indexLagSeconds',      (SELECT extract(epoch FROM (now() - idx_ceil))::numeric(12,1) FROM idx),
$o1$],
  ARRAY[$n1$    -- AN IDLE FLOOR IS NOT A LAGGING INDEX (2026-10-15, migration
    -- 20261015223846). idx_ceil is the newest hand the roller indexed, so
    -- with no newer hand it stands still while the index is complete. The
    -- lag is the age of the oldest hand the index has not reached: 0 when no
    -- hand_history row is newer than the ceiling, NULL with no ceiling.
    'indexLagSeconds',      (SELECT CASE WHEN idx.idx_ceil IS NULL THEN NULL
                                     ELSE COALESCE(extract(epoch FROM (now() - (
                                            SELECT min(h.created_at) FROM public.hand_history h
                                             WHERE h.created_at > idx.idx_ceil)))::numeric(12,1),
                                          0::numeric(12,1)) END
                             FROM idx),
$n1$]
);

COMMIT;
