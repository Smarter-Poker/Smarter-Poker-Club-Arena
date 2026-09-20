-- 20260914212802_hand_stat_writers_share_a_canonical_order
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-14 21:28:02 UTC.
--
-- Original stats alerts76/79: at2026-09-13 04:15:09.807 the live
-- projector11744 and forward rollup24227 deadlocked on ca_hand_player_stat.
-- All four insert writers now visit the same (user_id, hand_id) keys.
-- Forward and backward bulk writers share a nonblocking transaction lock
-- before reading cursors or touching rows. Live single-hand writers remain
-- concurrent. Retention limits, arithmetic, cursor windows, atomic hand
-- exclusion, outbox completion, and permissions are unchanged.
-- Requires the preceding qualified hand-index ordering migration20260914194928.
-- An unrecognized predecessor or authority change aborts before any DDL.
-- Source qualification is not native release or production installation.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $migration$
DECLARE r record; v_oid oid; v_definition text; v_hash text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('ca_roll_hand_stats_forward()','bc898054eaaed3f8ecbbfb28fb7415cf','b43b23aa54713ea1a4bd8df8d20b64bc','{postgres=X/postgres,service_role=X/postgres}'),
    ('ca_roll_hand_stats(integer)','544e8cc1b1a9bed90ecfcd0d28409f81','e0a452bce8be42ea84366ab01cabd5bf','{postgres=X/postgres,service_role=X/postgres}'),
    ('fn_project_hand_side_effects_after_post_commit_20260908(uuid)','566d75ce225d5fadb204e7c2c260e185','c13af0167961f3071d18342e00200844','{postgres=X/postgres}'),
    ('trg_ca_stats_live_from_hand()','39c07c3bea49560c9710c31dccbe86df','3a8af7a54df499afea2049c0392c9a50','{postgres=X/postgres}')
  ) AS versions(signature,before_hash,after_hash,expected_acl)
  LOOP
    v_oid:=to_regprocedure('public.'||r.signature);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'hand stat writer missing: %',r.signature; END IF;
    v_hash:=md5(pg_get_functiondef(v_oid));
    IF v_hash NOT IN(r.before_hash,r.after_hash) THEN
      RAISE EXCEPTION 'hand stat writer changed: % (%)',r.signature,v_hash;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
      AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
      AND p.proacl::text=r.expected_acl) THEN
      RAISE EXCEPTION 'hand stat writer authority changed: %',r.signature;
    END IF;
  END LOOP;

  v_oid:=to_regprocedure('public.ca_roll_hand_stats_forward()');
  v_definition:=pg_get_functiondef(v_oid);
  IF md5(v_definition)<>'b43b23aa54713ea1a4bd8df8d20b64bc' THEN
    v_definition:=replace(v_definition,'hashtext(''ca_roll_hand_stats_forward'')','hashtext(''ca_hand_player_stat_background'')');
    v_definition:=replace(v_definition,'    FROM public.ca_hand_player_facts(v_ceil, v_end) f','    FROM public.ca_hand_player_facts(v_ceil, v_end) f
    ORDER BY f.user_id, f.hand_id');
    EXECUTE v_definition;
    IF md5(pg_get_functiondef(v_oid))<>'b43b23aa54713ea1a4bd8df8d20b64bc' THEN
      RAISE EXCEPTION 'hand stat writer postimage mismatch: ca_roll_hand_stats_forward()';
    END IF;
  END IF;

  v_oid:=to_regprocedure('public.ca_roll_hand_stats(integer)');
  v_definition:=pg_get_functiondef(v_oid);
  IF md5(v_definition)<>'e0a452bce8be42ea84366ab01cabd5bf' THEN
    v_definition:=replace(v_definition,'BEGIN
','BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext(''ca_hand_player_stat_background'')) THEN
    RETURN 0;
  END IF;

');
    v_definition:=replace(v_definition,'  FROM ca_hand_player_facts(v_next, v_floor) f','  FROM ca_hand_player_facts(v_next, v_floor) f
  ORDER BY f.user_id, f.hand_id');
    EXECUTE v_definition;
    IF md5(pg_get_functiondef(v_oid))<>'e0a452bce8be42ea84366ab01cabd5bf' THEN
      RAISE EXCEPTION 'hand stat writer postimage mismatch: ca_roll_hand_stats(integer)';
    END IF;
  END IF;

  v_oid:=to_regprocedure('public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)');
  v_definition:=pg_get_functiondef(v_oid);
  IF md5(v_definition)<>'c13af0167961f3071d18342e00200844' THEN
    v_definition:=replace(v_definition,'    FROM public.ca_hand_player_facts_one(v_h.id,NULL) f','    FROM public.ca_hand_player_facts_one(v_h.id,NULL) f
  ORDER BY f.user_id, f.hand_id');
    EXECUTE v_definition;
    IF md5(pg_get_functiondef(v_oid))<>'c13af0167961f3071d18342e00200844' THEN
      RAISE EXCEPTION 'hand stat writer postimage mismatch: fn_project_hand_side_effects_after_post_commit_20260908(uuid)';
    END IF;
  END IF;

  v_oid:=to_regprocedure('public.trg_ca_stats_live_from_hand()');
  v_definition:=pg_get_functiondef(v_oid);
  IF md5(v_definition)<>'3a8af7a54df499afea2049c0392c9a50' THEN
    v_definition:=replace(v_definition,'    FROM public.ca_hand_player_facts_one(NEW.id,NULL) f','    FROM public.ca_hand_player_facts_one(NEW.id,NULL) f
  ORDER BY f.user_id, f.hand_id');
    EXECUTE v_definition;
    IF md5(pg_get_functiondef(v_oid))<>'3a8af7a54df499afea2049c0392c9a50' THEN
      RAISE EXCEPTION 'hand stat writer postimage mismatch: trg_ca_stats_live_from_hand()';
    END IF;
  END IF;
END;
$migration$;
COMMIT;
