-- 20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql
-- Version reserved by scripts/new-migration.mjs against main and remote branches.
--
-- Both JAQK and the Midway union host exceeded report budgets. Expanding all
-- historical table IDs selected the wrong indexes (17k keys for JAQK, 624k
-- for Midway). Read the bounded bomb-hand index first, then resolve the host.
-- Global-day admission measured 316ms; the actual full Midway result SELECT
-- completed in 11623ms where the original exceeded 20s. Bound only these four
-- aggregate report calls at 30s/64MB; role defaults and financial math stay.
-- After an exhaustive catchup (<40 days), only the midnight-grace live range
-- needs reading. At saturation retain the existing historical fallback.
-- The original rollup producer uses the same indexed source and UTC bounds;
-- no new projection, writer, cron, repair loop or money movement is added.
-- @live-proof: 'statement_timeout=30s'=ANY((SELECT proconfig FROM pg_proc WHERE oid='public.fn_club_bomb_pot_report_v2(uuid,integer)'::regprocedure))
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $patch$
DECLARE original text; d text;
BEGIN
 original:=pg_get_functiondef('public.fn_ca_bomb_pot_catchup(uuid,integer)'::regprocedure);
 IF md5(original)<>'26c4154db312866a94e2a14167199abd' THEN RAISE EXCEPTION 'Bomb catchup qualified preimage changed'; END IF;
 d:=replace(original,$old_catchup$
DECLARE
  v_day  date;
  v_done integer := 0;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Only days the hands can still answer for. Reaching further back would
  -- write ZEROES over history that pruning removed, which is worse than the
  -- gap it would be papering over: the rollup exists to be believed.
  -- hosted_bomb_days: source days only; never manufacture a zero archive.
  FOR v_day IN
    SELECT (h.created_at AT TIME ZONE 'UTC')::date AS hosted_bomb_days
      FROM public.hand_history h
     WHERE h.table_id=ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id=p_club_id))
       AND h.bomb_pot IS NOT NULL
       AND h.created_at >= (((now() AT TIME ZONE 'UTC')::date-(LEAST(GREATEST(COALESCE(p_days,30),1),365)-1))::timestamp AT TIME ZONE 'UTC')
       AND h.created_at < ((((now()-interval '15 minutes') AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC')
       AND NOT EXISTS (SELECT 1 FROM public.ca_club_bomb_pot_complete c
         WHERE c.club_id=p_club_id AND c.day=(h.created_at AT TIME ZONE 'UTC')::date)
     GROUP BY (h.created_at AT TIME ZONE 'UTC')::date
     ORDER BY 1 DESC LIMIT 40
  LOOP
    PERFORM public.fn_ca_bomb_pot_rollup_day(p_club_id, v_day);
    v_done := v_done + 1;
  END LOOP;

  RETURN v_done;
END;
$old_catchup$,$new_catchup$
DECLARE
  v_day  date;
  v_done integer := 0;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Only days the hands can still answer for. Reaching further back would
  -- write ZEROES over history that pruning removed, which is worse than the
  -- gap it would be papering over: the rollup exists to be believed.
  -- hosted_bomb_days: source days only; never manufacture a zero archive.
  FOR v_day IN
    WITH bomb_table_days AS MATERIALIZED (
      SELECT h.table_id,(h.created_at AT TIME ZONE 'UTC')::date AS day
        FROM public.hand_history h
       WHERE h.bomb_pot IS NOT NULL
         AND h.created_at >= (((now() AT TIME ZONE 'UTC')::date-(LEAST(GREATEST(COALESCE(p_days,30),1),365)-1))::timestamp AT TIME ZONE 'UTC')
         AND h.created_at < ((((now()-interval '15 minutes') AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC')
       GROUP BY h.table_id,(h.created_at AT TIME ZONE 'UTC')::date
    )
    SELECT d.day FROM bomb_table_days d
    CROSS JOIN LATERAL (
      SELECT t.id FROM public.tables t
       WHERE t.id=d.table_id AND t.club_id=p_club_id OFFSET 0
    ) hosted
    WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_bomb_pot_complete c
      WHERE c.club_id=p_club_id AND c.day=d.day)
    GROUP BY d.day ORDER BY d.day DESC LIMIT 40
  LOOP
    PERFORM public.fn_ca_bomb_pot_rollup_day(p_club_id, v_day);
    v_done := v_done + 1;
  END LOOP;

  RETURN v_done;
END;
$new_catchup$);
 IF d=original THEN RAISE EXCEPTION 'Bomb catchup source replacement missing'; END IF;
 EXECUTE d;
 original:=pg_get_functiondef('public.fn_club_bomb_pot_report(uuid,integer)'::regprocedure);
 IF md5(original)<>'e144edf49b1ac17266bcb94a658bdee4' THEN RAISE EXCEPTION 'Bomb report qualified preimage changed'; END IF;
 d:=replace(original,$old_report$
DECLARE
  v_uid        uuid    := auth.uid();
  v_authorized boolean := false;
  v_days       integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_from       date;
  v_live_from  date;
  v_oldest     date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
        AND lower(cm.role) IN ('owner', 'co_owner', 'admin')
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  PERFORM public.fn_ca_bomb_pot_catchup(p_club_id, v_days);

  v_from := (now() AT TIME ZONE 'UTC')::date - (v_days-1);

  SELECT MIN(g)::date INTO v_live_from
    FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_bomb_pot_complete c
                      WHERE c.club_id = p_club_id AND c.day = g::date);
  v_live_from := COALESCE(v_live_from, (now() AT TIME ZONE 'UTC')::date);

  -- THE FLOOR THIS MIGRATION ADDS. An unsealed day older than the oldest
  -- surviving bomb pot hand holds nothing to find, and the catchup will never
  -- seal it because sealing a pruned day would write zeroes over real history.
  -- Without this, a thirty-day window scanned a month of hand_history to
  -- discover that twenty-three of those days were empty.
  SELECT MIN(h.created_at)::date INTO v_oldest
    FROM public.hand_history h
   WHERE h.bomb_pot IS NOT NULL;
  IF v_oldest IS NULL THEN
    v_live_from := (now() AT TIME ZONE 'UTC')::date;
  ELSIF v_oldest > v_live_from THEN
    v_live_from := v_oldest;
  END IF;

  RETURN QUERY
  WITH ok_days AS MATERIALIZED (
    SELECT c.day FROM public.ca_club_bomb_pot_complete c
     WHERE c.club_id = p_club_id AND c.day >= v_from
  ), from_rollup AS (
    SELECT d.table_id, d.trigger_reason, d.board_count, d.variant,
           d.hands, d.seats_sum, d.pot_sum, d.rake_sum, d.ante_sum,
           d.scoops, d.splits, d.unrecorded
      FROM public.ca_club_bomb_pot_daily d
      JOIN ok_days o ON o.day = d.day
     WHERE d.club_id = p_club_id
  ), from_live AS (
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                          AS hands,
           SUM(b.seats)::numeric                                     AS seats_sum,
           SUM(b.pot_size)                                           AS pot_sum,
           SUM(b.rake_amount)                                        AS rake_sum,
           SUM(b.ante_amount * b.seats)                              AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint    AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint    AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint AS unrecorded
      FROM (
        SELECT h.id, h.table_id,
               h.bomb_pot ->> 'trigger_reason'                      AS trigger_reason,
               (h.bomb_pot ->> 'board_count')::int                  AS board_count,
               h.bomb_pot ->> 'variant'                             AS variant,
               COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0) AS ante_amount,
               COALESCE(h.pot_size, 0)                              AS pot_size,
               COALESCE(h.rake_amount, 0)                           AS rake_amount,
               COALESCE(jsonb_array_length(h.players), 0)           AS seats
          FROM public.hand_history h
          WHERE h.table_id = ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = p_club_id))
           AND h.bomb_pot IS NOT NULL
           AND h.created_at >= v_live_from::timestamptz
           AND NOT EXISTS (SELECT 1 FROM ok_days o2
                            WHERE o2.day = (h.created_at AT TIME ZONE 'UTC')::date)
      ) b
      LEFT JOIN (
        SELECT a.hand_history_id, count(DISTINCT a.user_id) AS distinct_winners
          FROM public.bomb_pot_award_units a
         WHERE a.created_at >= v_live_from::timestamptz
         GROUP BY a.hand_history_id
      ) u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  ), merged AS (
    SELECT * FROM from_rollup
    UNION ALL
    SELECT * FROM from_live
  ), totalled AS (
    SELECT m.table_id, m.trigger_reason, m.board_count, m.variant,
           SUM(m.hands)::bigint      AS hands,
           SUM(m.seats_sum)          AS seats_sum,
           SUM(m.pot_sum)            AS pot_sum,
           SUM(m.rake_sum)           AS rake_sum,
           SUM(m.ante_sum)           AS ante_sum,
           SUM(m.scoops)::bigint     AS scoops,
           SUM(m.splits)::bigint     AS splits,
           SUM(m.unrecorded)::bigint AS unrecorded
      FROM merged m
     GROUP BY m.table_id, m.trigger_reason, m.board_count, m.variant
  )
  SELECT tt.table_id,
         t.name,
         tt.trigger_reason,
         tt.board_count,
         tt.variant,
         tt.hands,
         round(tt.seats_sum / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum   / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum,  2),
         round(tt.rake_sum, 2),
         round(tt.ante_sum, 2),
         tt.scoops,
         tt.splits,
         tt.unrecorded
    FROM totalled tt
    LEFT JOIN public.tables t ON t.id = tt.table_id
   ORDER BY tt.hands DESC;
END;
$old_report$,$new_report$
DECLARE
  v_uid        uuid    := auth.uid();
  v_authorized boolean := false;
  v_days       integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_from       date;
  v_live_from  date;
  v_oldest     date;
  v_caught     integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
        AND lower(cm.role) IN ('owner', 'co_owner', 'admin')
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  v_caught := public.fn_ca_bomb_pot_catchup(p_club_id, v_days);

  v_from := (now() AT TIME ZONE 'UTC')::date - (v_days-1);

  SELECT MIN(g)::date INTO v_live_from
    FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_bomb_pot_complete c
                      WHERE c.club_id = p_club_id AND c.day = g::date);
  v_live_from := COALESCE(v_live_from, (now() AT TIME ZONE 'UTC')::date);

  -- THE FLOOR THIS MIGRATION ADDS. An unsealed day older than the oldest
  -- surviving bomb pot hand holds nothing to find, and the catchup will never
  -- seal it because sealing a pruned day would write zeroes over real history.
  -- Without this, a thirty-day window scanned a month of hand_history to
  -- discover that twenty-three of those days were empty.
  SELECT (MIN(h.created_at) AT TIME ZONE 'UTC')::date INTO v_oldest
    FROM public.hand_history h
   WHERE h.bomb_pot IS NOT NULL;
  IF v_oldest IS NULL THEN
    v_live_from := (now() AT TIME ZONE 'UTC')::date;
  ELSIF v_oldest > v_live_from THEN
    v_live_from := v_oldest;
  END IF;

  -- Fewer than forty source days means catchup exhausted the closed source.
  -- Keep the fifteen-minute midnight grace live; pruned gaps are not source.
  -- At the forty-day bound retain the original unsealed-history fallback.
  IF v_caught < 40 THEN
    v_live_from := GREATEST(v_from,((now()-interval '15 minutes') AT TIME ZONE 'UTC')::date);
  END IF;

  RETURN QUERY
  WITH bomb_candidates AS MATERIALIZED (
    SELECT h.id,h.table_id,h.bomb_pot,h.created_at,h.pot_size,h.rake_amount,h.players
      FROM public.hand_history h
     WHERE h.bomb_pot IS NOT NULL
       AND h.created_at >= (v_live_from::timestamp AT TIME ZONE 'UTC')
       AND h.created_at < (((now() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC')
  ), ok_days AS MATERIALIZED (
    SELECT c.day FROM public.ca_club_bomb_pot_complete c
     WHERE c.club_id = p_club_id AND c.day >= v_from
  ), from_rollup AS (
    SELECT d.table_id, d.trigger_reason, d.board_count, d.variant,
           d.hands, d.seats_sum, d.pot_sum, d.rake_sum, d.ante_sum,
           d.scoops, d.splits, d.unrecorded
      FROM public.ca_club_bomb_pot_daily d
      JOIN ok_days o ON o.day = d.day
     WHERE d.club_id = p_club_id
  ), from_live AS (
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                          AS hands,
           SUM(b.seats)::numeric                                     AS seats_sum,
           SUM(b.pot_size)                                           AS pot_sum,
           SUM(b.rake_amount)                                        AS rake_sum,
           SUM(b.ante_amount * b.seats)                              AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint    AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint    AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint AS unrecorded
      FROM (
        SELECT h.id, h.table_id,
               h.bomb_pot ->> 'trigger_reason'                      AS trigger_reason,
               (h.bomb_pot ->> 'board_count')::int                  AS board_count,
               h.bomb_pot ->> 'variant'                             AS variant,
               COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0) AS ante_amount,
               COALESCE(h.pot_size, 0)                              AS pot_size,
               COALESCE(h.rake_amount, 0)                           AS rake_amount,
               COALESCE(jsonb_array_length(h.players), 0)           AS seats
          FROM bomb_candidates h
          CROSS JOIN LATERAL (
            SELECT hosted.id FROM public.tables hosted
             WHERE hosted.id=h.table_id AND hosted.club_id=p_club_id OFFSET 0
          ) hosted
          WHERE true
           AND NOT EXISTS (SELECT 1 FROM ok_days o2
                            WHERE o2.day = (h.created_at AT TIME ZONE 'UTC')::date)
      ) b
      LEFT JOIN (
        SELECT a.hand_history_id, count(DISTINCT a.user_id) AS distinct_winners
          FROM public.bomb_pot_award_units a
         WHERE a.created_at >= (v_live_from::timestamp AT TIME ZONE 'UTC')
           AND a.created_at < (((now() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC')
         GROUP BY a.hand_history_id
      ) u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  ), merged AS (
    SELECT * FROM from_rollup
    UNION ALL
    SELECT * FROM from_live
  ), totalled AS (
    SELECT m.table_id, m.trigger_reason, m.board_count, m.variant,
           SUM(m.hands)::bigint      AS hands,
           SUM(m.seats_sum)          AS seats_sum,
           SUM(m.pot_sum)            AS pot_sum,
           SUM(m.rake_sum)           AS rake_sum,
           SUM(m.ante_sum)           AS ante_sum,
           SUM(m.scoops)::bigint     AS scoops,
           SUM(m.splits)::bigint     AS splits,
           SUM(m.unrecorded)::bigint AS unrecorded
      FROM merged m
     GROUP BY m.table_id, m.trigger_reason, m.board_count, m.variant
  )
  SELECT tt.table_id,
         t.name,
         tt.trigger_reason,
         tt.board_count,
         tt.variant,
         tt.hands,
         round(tt.seats_sum / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum   / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum,  2),
         round(tt.rake_sum, 2),
         round(tt.ante_sum, 2),
         tt.scoops,
         tt.splits,
         tt.unrecorded
    FROM totalled tt
    LEFT JOIN public.tables t ON t.id = tt.table_id
   ORDER BY tt.hands DESC;
END;
$new_report$);
 IF d=original THEN RAISE EXCEPTION 'Bomb report source replacement missing'; END IF;
 EXECUTE d;
 original:=pg_get_functiondef('public.fn_ca_bomb_pot_rollup_day(uuid,date)'::regprocedure);
 IF md5(original)<>'5ebbae90fcd1bf4b46f234f2be66bfe4' THEN RAISE EXCEPTION 'Bomb rollup qualified preimage changed'; END IF;
 d:=replace(original,$old_rollup$
DECLARE
  v_rows  integer := 0;
  v_hands bigint  := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  -- A day is finished fifteen minutes after it ends, never before. See the
  -- header: bomb_pot_award_units can land a moment late and a sealed day is
  -- not recomputed.
  IF (p_day + 1)::timestamptz > now() - interval '15 minutes' THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  WITH bomb_hands AS (
    SELECT h.id,
           h.table_id,
           h.bomb_pot ->> 'trigger_reason'                       AS trigger_reason,
           (h.bomb_pot ->> 'board_count')::int                   AS board_count,
           h.bomb_pot ->> 'variant'                              AS variant,
           COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0)  AS ante_amount,
           COALESCE(h.pot_size, 0)                               AS pot_size,
           COALESCE(h.rake_amount, 0)                            AS rake_amount,
           COALESCE(jsonb_array_length(h.players), 0)            AS seats
      FROM public.hand_history h
      WHERE h.table_id = ANY(ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = p_club_id))
       AND h.bomb_pot IS NOT NULL
       AND h.created_at >= p_day::timestamptz
       AND h.created_at <  (p_day + 1)::timestamptz
  ), per_hand_units AS (
    SELECT a.hand_history_id,
           count(DISTINCT a.user_id) AS distinct_winners
      FROM public.bomb_pot_award_units a
      JOIN bomb_hands b ON b.id = a.hand_history_id
     GROUP BY a.hand_history_id
  ), grouped AS (
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                              AS hands,
           SUM(b.seats)::numeric                                         AS seats_sum,
           SUM(b.pot_size)                                               AS pot_sum,
           SUM(b.rake_amount)                                            AS rake_sum,
           SUM(b.ante_amount * b.seats)                                  AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint        AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint        AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint     AS unrecorded
      FROM bomb_hands b
      LEFT JOIN per_hand_units u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  )
  INSERT INTO public.ca_club_bomb_pot_daily
    (club_id, day, table_id, trigger_reason, board_count, variant,
     hands, seats_sum, pot_sum, rake_sum, ante_sum, scoops, splits, unrecorded)
  SELECT p_club_id, p_day, g.table_id, g.trigger_reason, g.board_count, g.variant,
         g.hands, g.seats_sum, g.pot_sum, g.rake_sum, g.ante_sum,
         g.scoops, g.splits, g.unrecorded
    FROM grouped g;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT COALESCE(SUM(d.hands), 0) INTO v_hands
    FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  -- The marker is written even when the day held no bomb pots. A day with
  -- none is a FACT, and without the marker it would be re-scanned live for
  -- ever and read as "not yet known" rather than "none".
  INSERT INTO public.ca_club_bomb_pot_complete (club_id, day, rows_written, hands_read, computed_at)
  VALUES (p_club_id, p_day, v_rows, v_hands, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written,
        hands_read   = EXCLUDED.hands_read,
        computed_at  = EXCLUDED.computed_at;

  RETURN v_rows;
END;
$old_rollup$,$new_rollup$
DECLARE
  v_rows  integer := 0;
  v_hands bigint  := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  -- A day is finished fifteen minutes after it ends, never before. See the
  -- header: bomb_pot_award_units can land a moment late and a sealed day is
  -- not recomputed.
  IF ((p_day+1)::timestamp AT TIME ZONE 'UTC') > now() - interval '15 minutes' THEN
    RETURN 0;
  END IF;

  -- Closed-day publication is a single, immutable state transition.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca-bomb-day:'||p_club_id::text||':'||(p_day-DATE '2000-01-01')::text,0));
  SELECT c.rows_written INTO v_rows FROM public.ca_club_bomb_pot_complete c
   WHERE c.club_id=p_club_id AND c.day=p_day;
  IF FOUND THEN RETURN COALESCE(v_rows,0); END IF;

  DELETE FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  WITH bomb_candidates AS MATERIALIZED (
    SELECT h.id,h.table_id,h.bomb_pot,h.created_at,h.pot_size,h.rake_amount,h.players
      FROM public.hand_history h
     WHERE h.bomb_pot IS NOT NULL
       AND h.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
       AND h.created_at < ((p_day+1)::timestamp AT TIME ZONE 'UTC')
  ), bomb_hands AS (
    SELECT h.id,
           h.table_id,
           h.bomb_pot ->> 'trigger_reason'                       AS trigger_reason,
           (h.bomb_pot ->> 'board_count')::int                   AS board_count,
           h.bomb_pot ->> 'variant'                              AS variant,
           COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0)  AS ante_amount,
           COALESCE(h.pot_size, 0)                               AS pot_size,
           COALESCE(h.rake_amount, 0)                            AS rake_amount,
           COALESCE(jsonb_array_length(h.players), 0)            AS seats
      FROM bomb_candidates h
      CROSS JOIN LATERAL (
        SELECT t.id FROM public.tables t
         WHERE t.id=h.table_id AND t.club_id=p_club_id OFFSET 0
      ) hosted
  ), per_hand_units AS (
    SELECT a.hand_history_id,
           count(DISTINCT a.user_id) AS distinct_winners
      FROM public.bomb_pot_award_units a
      JOIN bomb_hands b ON b.id = a.hand_history_id
     GROUP BY a.hand_history_id
  ), grouped AS (
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                              AS hands,
           SUM(b.seats)::numeric                                         AS seats_sum,
           SUM(b.pot_size)                                               AS pot_sum,
           SUM(b.rake_amount)                                            AS rake_sum,
           SUM(b.ante_amount * b.seats)                                  AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint        AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint        AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint     AS unrecorded
      FROM bomb_hands b
      LEFT JOIN per_hand_units u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  )
  INSERT INTO public.ca_club_bomb_pot_daily
    (club_id, day, table_id, trigger_reason, board_count, variant,
     hands, seats_sum, pot_sum, rake_sum, ante_sum, scoops, splits, unrecorded)
  SELECT p_club_id, p_day, g.table_id, g.trigger_reason, g.board_count, g.variant,
         g.hands, g.seats_sum, g.pot_sum, g.rake_sum, g.ante_sum,
         g.scoops, g.splits, g.unrecorded
    FROM grouped g;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT COALESCE(SUM(d.hands), 0) INTO v_hands
    FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  -- The marker is written even when the day held no bomb pots. A day with
  -- none is a FACT, and without the marker it would be re-scanned live for
  -- ever and read as "not yet known" rather than "none".
  INSERT INTO public.ca_club_bomb_pot_complete (club_id, day, rows_written, hands_read, computed_at)
  VALUES (p_club_id, p_day, v_rows, v_hands, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written,
        hands_read   = EXCLUDED.hands_read,
        computed_at  = EXCLUDED.computed_at;

  RETURN v_rows;
END;
$new_rollup$);
 IF d=original THEN RAISE EXCEPTION 'Bomb rollup source replacement missing'; END IF;
 EXECUTE d;
 IF md5(pg_get_functiondef('public.fn_club_bomb_pot_report_v2(uuid,integer)'::regprocedure))<>'c669d148cbeb8e21d4a648c65d2d4c78'
 THEN RAISE EXCEPTION 'Bomb wrapper qualified preimage changed'; END IF;
END $patch$;
ALTER FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) SET statement_timeout='30s';
ALTER FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) SET work_mem='64MB';
ALTER FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) SET enable_indexscan=off;
ALTER FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) SET plan_cache_mode=force_generic_plan;
REVOKE ALL ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid,integer) TO service_role;
ALTER FUNCTION public.fn_club_bomb_pot_report(uuid,integer) SET statement_timeout='30s';
ALTER FUNCTION public.fn_club_bomb_pot_report(uuid,integer) SET work_mem='64MB';
ALTER FUNCTION public.fn_club_bomb_pot_report(uuid,integer) SET enable_indexscan=off;
ALTER FUNCTION public.fn_club_bomb_pot_report(uuid,integer) SET plan_cache_mode=force_generic_plan;
REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid,integer) TO authenticated,service_role;
ALTER FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid,date) SET statement_timeout='30s';
ALTER FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid,date) SET work_mem='64MB';
ALTER FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid,date) SET enable_indexscan=off;
ALTER FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid,date) SET plan_cache_mode=force_generic_plan;
REVOKE ALL ON FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid,date) TO service_role;
ALTER FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer) SET statement_timeout='30s';
ALTER FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer) SET work_mem='64MB';
ALTER FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer) SET enable_indexscan=off;
ALTER FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer) SET plan_cache_mode=force_generic_plan;
REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report_v2(uuid,integer) TO authenticated,service_role;
COMMIT;
