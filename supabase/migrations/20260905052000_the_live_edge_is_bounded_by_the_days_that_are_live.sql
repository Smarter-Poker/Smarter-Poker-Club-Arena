-- ═══════════════════════════════════════════════════════════════════════════
--  THE LIVE EDGE IS BOUNDED BY THE DAYS THAT ARE ACTUALLY LIVE
--  Club Operations upgrade, phase 7 of 8. Correction to 20260905051000.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260905051000 built the rollup, proved it row-for-row against the old
-- report, and measured 200 in 1.2-1.9s through PostgREST where the page had
-- been getting 500 after 8.2s. Then the same call from a real browser session,
-- fifteen minutes later, took **8,718ms and 8,425ms and 500'd again**.
--
-- The 1.2s readings were taken while everything the backfill had just touched
-- was still resident. The rollup had not stopped the expensive read; it had
-- only been measured when that read was warm - which is the exact mistake the
-- migration it corrects was written to expose. Measuring a cold path warm is
-- how this defect survived a whole phase.
--
-- WHAT WAS ACTUALLY WRONG. The live half of the report was bounded by the
-- REQUESTED window and made disjoint from the sealed days by an anti-join:
--
--     WHERE t.club_id = p_club_id
--       AND h.bomb_pot IS NOT NULL
--       AND h.created_at >= v_from::timestamptz          <-- thirty days
--       AND NOT EXISTS (SELECT 1 FROM ok_days o2 ...)    <-- keeps only today
--
-- The anti-join removes the sealed days from the RESULT. It cannot stop them
-- being READ. The club filter lives on `tables`, so `h.table_id` is needed for
-- every candidate row, and `table_id` is not in
-- `idx_hand_history_bomb_pot_created` - so the planner fetched every one of
-- the ~20,200 wide `hand_history` rows in the window, TOASTed `players` and
-- all, and discarded 96% of them after the join. Exactly the read the rollup
-- exists to avoid, still happening, on every call.
--
-- THE FIX is one more bound: the earliest day in the window that has no
-- completeness marker. When yesterday and everything before it are sealed,
-- that is today, and the live scan reads ~740 rows instead of 20,200. The
-- anti-join STAYS - a day the rollup skipped and later filled would otherwise
-- be counted twice - it just no longer has to carry the whole window on its
-- own.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

-- The default stays: dropping it would need a DROP FUNCTION, and the client
-- calls this with p_days omitted.
CREATE OR REPLACE FUNCTION public.fn_club_bomb_pot_report(p_club_id uuid, p_days integer DEFAULT 30)
RETURNS TABLE(
  table_id uuid, table_name text, trigger_reason text, board_count integer,
  variant text, hands bigint, avg_players numeric, avg_pot numeric,
  total_pot numeric, total_rake numeric, total_antes numeric,
  scoops bigint, splits bigint, unrecorded_hands bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid        uuid    := auth.uid();
  v_authorized boolean := false;
  v_days       integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_from       date;
  v_live_from  date;
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

  -- Seal whatever is finished and unsealed. After midnight this is one day.
  PERFORM public.fn_ca_bomb_pot_catchup(p_club_id, v_days);

  v_from := (now() - make_interval(days => v_days))::date;

  -- THE FLOOR OF THE LIVE SCAN, and the whole point of this correction.
  -- The anti-join against ok_days removes the sealed days from the RESULT,
  -- but it cannot stop the planner reading them: the club filter lives on
  -- `tables`, so `h.table_id` is needed for every candidate row, and
  -- table_id is not in idx_hand_history_bomb_pot_created - so the planner
  -- fetched ~20,200 wide heap rows across the whole window and threw almost
  -- all of them away. Bounding the scan by the earliest day that is actually
  -- unsealed makes it read one day instead of a year. The anti-join stays,
  -- because sealed days inside that floor (a gap the rollup skipped, then
  -- filled) must still be excluded from the result.
  SELECT MIN(g)::date INTO v_live_from
    FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_bomb_pot_complete c
                      WHERE c.club_id = p_club_id AND c.day = g::date);
  v_live_from := COALESCE(v_live_from, (now() AT TIME ZONE 'UTC')::date);

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
    -- Only the days no marker claims - today, and any day the rollup has not
    -- reached. This is the part that still touches hand_history, and it is
    -- one day of it rather than a year.
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
          JOIN public.tables t ON t.id = h.table_id
         WHERE t.club_id = p_club_id
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
         -- The averages are re-derived from the sums, so a range of days
         -- averages over the range rather than over the daily averages.
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
$function$;

REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) IS
  'Bomb pot summary for a club. Finished days come from ca_club_bomb_pot_daily, which outlives hand_history pruning; the hands are read only from the earliest unsealed day forward, which is normally today.';

REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) TO authenticated, service_role;

DO $$
DECLARE v_src text;
BEGIN
  -- Comment lines stripped first. The body explains this bound in prose that
  -- names the very things the check looks for, and an assertion that cannot
  -- tell code from its own explanation fails on the explanation. That has now
  -- happened once for real in this programme (20260905042100) and is designed
  -- out of every assertion written since.
  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_club_bomb_pot_report'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%h.created_at >= v_live_from::timestamptz%' THEN
    RAISE EXCEPTION 'the live scan is still bounded by the requested window, not by the unsealed days';
  END IF;
  IF v_src NOT LIKE '%NOT EXISTS (SELECT 1 FROM ok_days o2%' THEN
    RAISE EXCEPTION 'the live edge no longer excludes the sealed days, so a refilled gap would count twice';
  END IF;
END $$;

COMMIT;
