-- ===========================================================================
--  A STATS REFRESH STEPS AROUND A LIVE HAND
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-03. refresh-player-stats-hourly (job 76) was
-- read from cron.job_run_details on production: in the 7 runs to 03:17 UTC,
-- 4 were cancelled by the role's 120 s limit (fixed by migration
-- 20261003025058, which gave the job its 300 s budget) and 2 died as the
-- deadlock victim, the second of them at 03:17 AFTER that budget landed:
--   ERROR: deadlock detected ... while inserting index tuple in relation
--   "player_stats" ... fn_refresh_player_stats line 42.
--
-- WHY. The refresh upserts every (user, club) row of the last 90 minutes in
-- one INSERT ... ON CONFLICT, in no particular order, holding each row lock
-- until the cron transaction commits. The per-hand writers of player_stats
-- (fn_fold_hand_winnings on hand_history and the post-commit projection)
-- lock the rows of a hand's seats in their own order. Two writers taking the
-- same rows in different orders form a cycle, and Postgres kills one; when it
-- picks the refresh, the whole hour's refresh rolls back.
--
-- WHAT CHANGES (fn_refresh_player_stats only):
--   * existing rows are locked first, in key order, FOR UPDATE SKIP LOCKED -
--     a row a live hand is writing is left to that hand;
--   * the upsert writes only the rows it locked plus keys that do not exist
--     yet, in key order;
--   * a deadlock that still picks this run (a brand-new key raced by a hand)
--     rolls back only that block, releasing its locks, and is retried up to
--     three times before failing as before.
-- A skipped row keeps its previous figures until the next hourly run, which
-- reads the same 90-minute window again. Nothing about how a figure is
-- computed changes. The function is not money and not a watched guard.
--
-- HOW. Exact substitution through a pg_temp helper, as in 20261003025434:
-- pinned preimage, each anchor exactly once, derived postimage (computed
-- read-only on production), owner/security/settings/grants unmoved.
-- No schedule, grant, index or table changes.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_refresh_player_stats(timestamp with time zone)'::regprocedure)) = '7b24a8ea05c7fb76becf6a214dc8bf69')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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
  'public.fn_refresh_player_stats(timestamp with time zone)',
  'a823ee7a6d52db8a948af9d12033f73d', '7b24a8ea05c7fb76becf6a214dc8bf69',
  ARRAY[$o$DECLARE v_users integer := 0; v_hands integer := 0;
$o$, $o$  INSERT INTO player_stats (user_id, club_id, hands_played, vpip, pfr, updated_at)
  SELECT user_id, club_id, hands,
         round((vpip_hands::numeric / NULLIF(hands,0)) * 100, 2),
         round((pfr_hands::numeric  / NULLIF(hands,0)) * 100, 2),
         now()
    FROM _ps
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET hands_played = GREATEST(COALESCE(player_stats.hands_played,0), EXCLUDED.hands_played),
         vpip = EXCLUDED.vpip,
         pfr  = EXCLUDED.pfr,
         updated_at = now();
$o$],
  ARRAY[$n$DECLARE v_users integer := 0; v_hands integer := 0; v_try integer;
$n$, $n$  /* A REFRESH STEPS AROUND A LIVE HAND (2026-10-03). The hourly upsert
     wrote every (user, club) row of the last 90 minutes in one statement, in
     no particular order, while the per-hand writers (the hand_history
     fold-stats trigger and the post-commit projection) update the same
     player_stats rows for the seats of each hand they settle. Two writers
     taking the same rows in different orders deadlock: 2 of the 7 runs to
     03:17 UTC were chosen as the victim ("while inserting index tuple ... in
     relation player_stats"), and the whole hour's refresh rolled back.
     Now the refresh first locks, in key order, only the existing rows no live
     hand is holding (SKIP LOCKED), and writes those plus the rows that do not
     exist yet, in key order. A row a hand holds right now is left to that
     hand and refreshed by the next run, which reads the same 90-minute window
     again. If a deadlock still picks this run (a brand-new key raced by a
     hand), only this block rolls back - releasing what it locked - and it
     tries again, up to three times, before failing as before. */
  FOR v_try IN 1 .. 3 LOOP
    BEGIN
      CREATE TEMP TABLE _ps_locked ON COMMIT DROP AS
        SELECT ps.user_id, ps.club_id
          FROM player_stats ps
          JOIN _ps p ON p.user_id = ps.user_id AND p.club_id = ps.club_id
         ORDER BY ps.user_id, ps.club_id
           FOR UPDATE OF ps SKIP LOCKED;

      INSERT INTO player_stats (user_id, club_id, hands_played, vpip, pfr, updated_at)
      SELECT p.user_id, p.club_id, p.hands,
             round((p.vpip_hands::numeric / NULLIF(p.hands,0)) * 100, 2),
             round((p.pfr_hands::numeric  / NULLIF(p.hands,0)) * 100, 2),
             now()
        FROM _ps p
       WHERE EXISTS (SELECT 1 FROM _ps_locked l
                      WHERE l.user_id = p.user_id AND l.club_id = p.club_id)
          OR NOT EXISTS (SELECT 1 FROM player_stats ps
                          WHERE ps.user_id = p.user_id AND ps.club_id = p.club_id)
       ORDER BY p.user_id, p.club_id
      ON CONFLICT (user_id, club_id) DO UPDATE
         SET hands_played = GREATEST(COALESCE(player_stats.hands_played,0), EXCLUDED.hands_played),
             vpip = EXCLUDED.vpip,
             pfr  = EXCLUDED.pfr,
             updated_at = now();
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_try >= 3 THEN RAISE; END IF;
    END;
  END LOOP;
$n$]);

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
