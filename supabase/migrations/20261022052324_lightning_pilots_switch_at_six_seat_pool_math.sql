-- 20261022052324_lightning_pilots_switch_at_six_seat_pool_math.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Owner approval (Dan, 2026-10-22): keep the two private six-seat Lightning
-- pilots running off-peak by sizing their ON/OFF threshold to six-seat pool
-- math. Exactly two games change: Lightning Pilot NLH Action 6
-- (56d5d6f0-23e9-41b0-b407-852aa1026c2a) and Lightning Pilot NLH Madness 6
-- (681eb9e8-e9fd-4026-8ec6-64075b911d33), both in the private Lightning Internal
-- Pilot club e14bc9f7-736d-425f-8f2c-e78305ebac1d. Public Lightning stays off;
-- no other game, no default and no reader changes.
--
-- MEASURED (production, 2026-10-19 04:00 to 2026-10-22 04:00 UTC, distinct
-- players seated in the cluster or in a live pool, 15-minute samples):
--   Action  : 34-42 while the 72-horse assignment was active (Oct 19); exactly
--             18 for hours after each switch-on (Oct 20-21), decaying to 12 and
--             switching off (Oct 21 23:13); 6-9 overnight since.
--   Madness : 13-20 after each switch-on, off at 12 (Oct 20 22:37), then 0-7 and
--             no pool for 30+ hours.
-- Each daily switch-on happened within minutes of 05:00 UTC, when the Chicago
-- day rolls the horses' daily caps over, and each switch-off came as caps
-- filled; the default ON 18 / OFF 12 asks for three full tables to start and
-- gives up while two full tables are still playing.
--
-- SIX-SEAT POOL MATH (the floor this migration enforces):
--   ON  >= 12 : two concurrent six-handed hands, so the matcher has a second
--               table to rotate folders into and the pool is never one table.
--   OFF >= 8  : one full six-handed hand plus fast-fold turnover (two players
--               waiting for the next hand) before reverting to MUST-MOVE.
--   ON - OFF >= 4 : hysteresis wide enough that one table's churn cannot flap
--               the cluster (fn_cash_cluster_lightning_thresholds_probe already
--               refuses ON <= OFF).
-- The measured overnight minimum (Action 6-9, Madness 0) is below that floor,
-- so the lowest permitted pair is chosen: ON 12 / OFF 8. Going lower would turn
-- Lightning into a one-table pool; the rest of the off-peak gap is a routing
-- question answered by the pilot assignment, not by the threshold.
--
-- The matcher's pool-size bands derive from these thresholds (fn_lightning_config:
-- diversity_thin_min = OFF, medium = ON, large = 2*ON), so they become 8 / 12 / 24.
-- Thin and tiny pools weigh diversity at zero by rule: formation first.
--
-- @live-proof: (SELECT count(*) = 2 FROM public.cash_games g WHERE g.id IN ('56d5d6f0-23e9-41b0-b407-852aa1026c2a','681eb9e8-e9fd-4026-8ec6-64075b911d33') AND public.fn_cash_cluster_lightning_thresholds(g.id) @> '{"on":12,"off":8,"source":"ruleset"}'::jsonb)
-- @live-proof: (SELECT count(*) = 2 FROM public.cash_games g WHERE g.id IN ('56d5d6f0-23e9-41b0-b407-852aa1026c2a','681eb9e8-e9fd-4026-8ec6-64075b911d33') AND public.fn_lightning_config(g.id) @> '{"diversity_thin_min":8,"diversity_medium_min":12,"diversity_large_min":24,"invalid":[]}'::jsonb)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_games g WHERE g.lightning_enabled AND coalesce(g.ruleset_snapshot->'options'->>'is_private','false') <> 'true'))

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $thresholds$
DECLARE
  v_ids constant uuid[] := ARRAY['56d5d6f0-23e9-41b0-b407-852aa1026c2a',
                                 '681eb9e8-e9fd-4026-8ec6-64075b911d33']::uuid[];
  v_club constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  v_on constant integer := 12;
  v_off constant integer := 8;
  v_others_before text;
  v_others_after text;
  g record;
  r jsonb;
  v_before jsonb;
BEGIN
  -- The reader this value is written for is the one this file was qualified
  -- against. A changed reader means the meaning of the keys may have changed.
  IF md5(pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'::regprocedure))
       IS DISTINCT FROM '6f1aa6bdebb5f5b33c0b2c50969aec2d'
  OR md5(pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds(uuid)'::regprocedure))
       IS DISTINCT FROM '23bf6043e45ef4f357f22aeb3672ad3c' THEN
    RAISE EXCEPTION 'threshold reader changed since qualification; nothing changed';
  END IF;

  -- The six-seat floor, asserted on the constants themselves.
  IF v_on < 12 OR v_off < 8 OR v_on - v_off < 4 THEN
    RAISE EXCEPTION 'six-seat pool floor violated: on % off %', v_on, v_off;
  END IF;

  SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(ruleset_snapshot::text, ''), '|' ORDER BY id), ''))
    INTO v_others_before FROM public.cash_games WHERE id <> ALL (v_ids);

  FOR g IN SELECT * FROM public.cash_games WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE LOOP
    IF g.club_id IS DISTINCT FROM v_club OR g.union_id IS NOT NULL
       OR g.handedness IS DISTINCT FROM 6
       OR g.template_name NOT IN ('action', 'madness')
       OR g.ruleset_snapshot->'options'->>'is_private' IS DISTINCT FROM 'true'
       OR jsonb_typeof(g.ruleset_snapshot->'lightning') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'game % is not the exact private six-seat pilot; nothing changed', g.id;
    END IF;
    r := public.fn_cash_cluster_lightning_thresholds(g.id);
    IF NOT (r @> '{"on":18,"off":12,"source":"default","band":"six_max"}'::jsonb) THEN
      RAISE EXCEPTION 'game % thresholds are not the expected defaults (%); nothing changed', g.id, r;
    END IF;
    v_before := g.ruleset_snapshot;

    UPDATE public.cash_games
       SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}',
             (ruleset_snapshot->'lightning')
             || jsonb_build_object('on_threshold', v_on, 'off_threshold', v_off))
     WHERE id = g.id;

    SELECT * INTO g FROM public.cash_games WHERE id = g.id;
    -- Every key outside lightning, and every lightning key other than the two
    -- thresholds, is byte-identical (the template floor trigger rewrites four
    -- keys from the template; they already equal it, asserted here).
    IF (g.ruleset_snapshot - 'lightning') IS DISTINCT FROM (v_before - 'lightning')
       OR (g.ruleset_snapshot->'lightning') - 'on_threshold' - 'off_threshold'
          IS DISTINCT FROM (v_before->'lightning') - 'on_threshold' - 'off_threshold' THEN
      RAISE EXCEPTION 'game % snapshot changed beyond the two thresholds', g.id;
    END IF;
    r := public.fn_cash_cluster_lightning_thresholds(g.id);
    IF NOT (r @> jsonb_build_object('on', v_on, 'off', v_off, 'source', 'ruleset', 'rejected', '[]'::jsonb)) THEN
      RAISE EXCEPTION 'game % readback is not % / % from the ruleset: %', g.id, v_on, v_off, r;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.cash_games WHERE id = ANY (v_ids)) <> 2 THEN
    RAISE EXCEPTION 'expected exactly two pilot games';
  END IF;
  SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(ruleset_snapshot::text, ''), '|' ORDER BY id), ''))
    INTO v_others_after FROM public.cash_games WHERE id <> ALL (v_ids);
  IF v_others_after IS DISTINCT FROM v_others_before THEN
    RAISE EXCEPTION 'another game''s ruleset changed';
  END IF;
  -- Public Lightning stays off.
  IF EXISTS (SELECT 1 FROM public.cash_games
              WHERE lightning_enabled
                AND coalesce(ruleset_snapshot->'options'->>'is_private', 'false') <> 'true') THEN
    RAISE EXCEPTION 'a non-private game has Lightning enabled';
  END IF;
END $thresholds$;

COMMIT;
