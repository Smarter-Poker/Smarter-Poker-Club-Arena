-- 20260914194928_hand_index_writers_share_a_canonical_order
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-14 19:49:28 UTC.
--
-- Original alerts 76/79: the live hand projector and background index refresh
-- deadlocked on ca_hand_player_idx at 2026-09-13 03:45 and 04:15 UTC.
-- DISTINCT does not promise an insertion order. All four writers now order
-- the same (user_id, hand_id) keys. The two multi-hand background writers also
-- share one nonblocking transaction lock, since their forward/backfill windows
-- can overlap in different orders. Single-hand live projectors stay concurrent.
-- No financial arithmetic, cursor coverage, receipt, outbox or UUID predicate
-- changes. In particular, this does not claim to fix the separate stats-rollup
-- or player_stats/terminal-settlement deadlocks.
--
-- Native PostgreSQL tests reproduce the original conflict and cover both
-- execution orders. All preimages are checked before any function is changed.
-- Installation must use the native release owner's normal controls.

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  r record;
  v_oid oid;
  v_definition text;
  v_hash text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('ca_index_every_seat(integer)', '0cb93b8670db03efd2b582269fcd9e54', '390e93ae95d4cac85744a2ca48ef6772', '{postgres=X/postgres,service_role=X/postgres}'),
    ('ca_refresh_hand_player_index(integer)', 'c3b01131198fb9ead3e42e8f3626c583', '8a0a2d56f0bb0c89b0b71005d753671e', '{postgres=X/postgres,service_role=X/postgres}'),
    ('fn_project_hand_side_effects_after_post_commit_20260908(uuid)', '6200bfe8e0300c2fd075f1192bb901ce', '566d75ce225d5fadb204e7c2c260e185', '{postgres=X/postgres}'),
    ('trg_ca_stats_live_from_hand()', 'e320b0bc16226391afa58f9eaf9aaf77', '39c07c3bea49560c9710c31dccbe86df', '{postgres=X/postgres}')
  ) AS versions(signature, before_hash, after_hash, expected_acl)
  LOOP
    v_oid := to_regprocedure('public.' || r.signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'hand index writer missing: %', r.signature;
    END IF;
    v_hash := md5(pg_get_functiondef(v_oid));
    IF v_hash NOT IN (r.before_hash, r.after_hash) THEN
      RAISE EXCEPTION 'hand index writer changed: % (%)', r.signature, v_hash;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
        AND pg_get_userbyid(p.proowner) = 'postgres'
        AND p.prosecdef AND p.proacl::text = r.expected_acl
    ) THEN
      RAISE EXCEPTION 'hand index writer authority changed: %', r.signature;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
    ('ca_index_every_seat(integer)', '390e93ae95d4cac85744a2ca48ef6772'),
    ('ca_refresh_hand_player_index(integer)', '8a0a2d56f0bb0c89b0b71005d753671e'),
    ('fn_project_hand_side_effects_after_post_commit_20260908(uuid)', '566d75ce225d5fadb204e7c2c260e185'),
    ('trg_ca_stats_live_from_hand()', '39c07c3bea49560c9710c31dccbe86df')
  ) AS versions(signature, after_hash)
  LOOP
    v_oid := to_regprocedure('public.' || r.signature);
    v_definition := pg_get_functiondef(v_oid);
    IF md5(v_definition) = r.after_hash THEN CONTINUE; END IF;

    IF r.signature IN ('ca_index_every_seat(integer)', 'ca_refresh_hand_player_index(integer)') THEN
      v_definition := replace(v_definition,
        'SELECT user_id, created_at, hand_id FROM expanded',
        E'SELECT user_id, created_at, hand_id FROM expanded\n      ORDER BY user_id, hand_id, created_at');
      v_definition := replace(v_definition,
        'hashtext(''ca_index_every_seat'')', 'hashtext(''ca_hand_player_idx_background'')');
      v_definition := replace(v_definition,
        'hashtext(''ca_refresh_hand_player_index'')', 'hashtext(''ca_hand_player_idx_background'')');
    ELSE
      -- These pinned preimages have exactly one index ON CONFLICT DO NOTHING;
      -- their financial and per-hand-stat ON CONFLICT clauses are untouched.
      v_definition := replace(v_definition,
        '  ON CONFLICT DO NOTHING;', E'  ORDER BY 1, 3\n  ON CONFLICT DO NOTHING;');
    END IF;

    EXECUTE v_definition;
    IF md5(pg_get_functiondef(v_oid)) <> r.after_hash THEN
      RAISE EXCEPTION 'hand index writer postimage mismatch: %', r.signature;
    END IF;
  END LOOP;
END;
$migration$;

COMMIT;
