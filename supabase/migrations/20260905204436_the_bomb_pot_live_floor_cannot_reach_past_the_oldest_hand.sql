-- ═══════════════════════════════════════════════════════════════════════════
--  THE BOMB POT LIVE FLOOR CANNOT REACH PAST THE OLDEST HAND
--  Club Operations upgrade, the all-phase sweep. Correction to 20260905052000.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Measured through PostgREST as the club owner, 20:42 UTC:
--
--     p_days=1     200 in   608ms
--     p_days=7     200 in 1,204ms
--     p_days=30    500 after 8,730ms   (57014)
--
-- The cost scales with the REQUESTED WINDOW, which is exactly what the rollup
-- was built to stop. The reason is an interaction between two decisions that
-- are each correct on their own.
--
-- `fn_ca_bomb_pot_catchup` deliberately refuses to seal a day the hands can no
-- longer answer for. That is right: `sp_prune_hand_history` removes horse-only
-- hands after seven days, so sealing 2026-08-06 today would write ZEROES over
-- history that pruning removed, and the rollup exists to be believed.
--
-- But the READ then treats every unsealed day as live. Ask for thirty days and
-- the window reaches 2026-08-06; days 08-06 to 08-28 hold no bomb pots, were
-- never sealed, and so become the earliest unsealed day - `v_live_from` lands
-- on 08-06 and the live half scans a month of `hand_history` to find nothing.
-- The seven-day window is fast for the same reason in reverse: every day in it
-- either has a marker or is today.
--
-- THE FLOOR IS BOUNDED BY WHAT THE HANDS CAN ANSWER FOR. There is nothing to
-- read before the oldest surviving bomb pot hand, so reaching back past it can
-- only cost time. `v_live_from` is now the later of the earliest unsealed day
-- and that oldest hand, and where there are no bomb pot hands at all it is
-- today - a scan of nothing rather than a scan of a year.
--
-- The anti-join against the sealed days stays, unchanged. This narrows where
-- the scan STARTS; it does not change which days count.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

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

  v_from := (now() - make_interval(days => v_days))::date;

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

DO $$
DECLARE v_src text;
BEGIN
  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_club_bomb_pot_report'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%MIN(h.created_at)::date INTO v_oldest%' THEN
    RAISE EXCEPTION 'the live floor can still reach past the oldest surviving hand';
  END IF;
  IF v_src NOT LIKE '%NOT EXISTS (SELECT 1 FROM ok_days o2%' THEN
    RAISE EXCEPTION 'the live edge no longer excludes the sealed days';
  END IF;
  IF v_src NOT LIKE '%ca_club_bomb_pot_daily d%' THEN
    RAISE EXCEPTION 'the report stopped reading the rollup';
  END IF;
END $$;

COMMIT;
