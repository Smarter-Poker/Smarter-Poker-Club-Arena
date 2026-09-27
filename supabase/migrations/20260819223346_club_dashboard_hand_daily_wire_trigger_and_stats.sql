-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819223346 "club_dashboard_hand_daily_wire_trigger_and_stats"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 463584eca5fd92b2f84cd4761771ba97 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Maintain club_hand_daily from the existing per-hand trigger, and read it
-- from ca_club_dashboard_stats in preference to the lagging club_daily_stats.
--
-- The rollup upsert is placed FIRST and outside the player-stats CTE chain so
-- that a per-hand count is recorded even for a hand whose players[] payload is
-- malformed — the hand still happened and still paid rake.

CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club uuid;
  v_date date;
BEGIN
  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN
    RETURN NEW;
  END IF;
  v_date := (NEW.created_at AT TIME ZONE 'UTC')::date;

  -- Club-level per-day rollup (Hands Today / Rake Today / 14-day series).
  INSERT INTO club_hand_daily AS d (club_id, stat_date, hands, rake, bbj, pot_total)
  VALUES (v_club, v_date, 1,
          coalesce(NEW.rake_amount, 0), coalesce(NEW.bbj_amount, 0),
          coalesce(NEW.pot_size, 0))
  ON CONFLICT (club_id, stat_date) DO UPDATE SET
    hands     = d.hands + 1,
    rake      = d.rake + EXCLUDED.rake,
    bbj       = d.bbj + EXCLUDED.bbj,
    pot_total = d.pot_total + EXCLUDED.pot_total,
    updated_at = now();

  WITH pl AS (
    SELECT DISTINCT ON (p->>'userId')
           (p->>'userId')::uuid   AS uid,
           (p->>'stack')::numeric AS stack
    FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) p
    WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (p->>'stack') IS NOT NULL
  ),
  wn AS (
    SELECT (w->>'userId')::uuid AS uid, sum((w->>'amount')::numeric) AS won
    FROM jsonb_array_elements(coalesce(NEW.winners, '[]'::jsonb)) w
    WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    GROUP BY 1
  ),
  base AS (
    SELECT
      pl.uid, pl.stack, coalesce(wn.won, 0) AS won, st.last_stack,
      (st.last_stack IS NOT NULL
       AND st.last_hand_number IS NOT NULL
       AND NEW.hand_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM hand_history h2
         WHERE h2.table_id = NEW.table_id
           AND h2.hand_number > st.last_hand_number
           AND h2.hand_number < NEW.hand_number
       )) AS adjacent
    FROM pl
    LEFT JOIN wn ON wn.uid = pl.uid
    LEFT JOIN club_member_table_state st
           ON st.table_id = NEW.table_id AND st.user_id = pl.uid
  ),
  agg AS (
    SELECT count(*) AS seated,
           count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
           coalesce(sum(stack - last_stack) FILTER (WHERE last_stack IS NOT NULL), 0) AS dsum
    FROM base
  ),
  calc AS (
    SELECT
      b.uid, b.won,
      CASE WHEN b.last_stack IS NOT NULL THEN b.stack - b.last_stack ELSE 0 END AS delta,
      CASE
        WHEN a.seated = a.with_prior
          THEN abs(a.dsum + coalesce(NEW.rake_amount, 0) + coalesce(NEW.bbj_amount, 0)) < 0.005
        ELSE b.adjacent AND (b.stack - b.last_stack) <= b.won + 0.001
      END AS attributable
    FROM base b CROSS JOIN agg a
  )
  INSERT INTO club_member_daily_stats AS s
    (club_id, table_id, user_id, stat_date, hands_played, hands_attributed, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, NEW.table_id, calc.uid, v_date,
    1,
    CASE WHEN calc.attributable THEN 1 ELSE 0 END,
    CASE WHEN calc.won > 0 THEN 1 ELSE 0 END,
    calc.won,
    CASE WHEN calc.attributable THEN calc.delta ELSE 0 END,
    calc.won,
    coalesce(NEW.pot_size, 0),
    CASE WHEN NOT calc.attributable AND calc.delta > calc.won
         THEN calc.delta - calc.won ELSE 0 END
  FROM calc
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played     = s.hands_played + 1,
    hands_attributed = s.hands_attributed + EXCLUDED.hands_attributed,
    hands_won        = s.hands_won + EXCLUDED.hands_won,
    total_won        = s.total_won + EXCLUDED.total_won,
    profit           = s.profit + EXCLUDED.profit,
    biggest_pot_won  = greatest(s.biggest_pot_won, EXCLUDED.biggest_pot_won),
    biggest_pot      = greatest(s.biggest_pot, EXCLUDED.biggest_pot),
    topup_total      = s.topup_total + EXCLUDED.topup_total,
    updated_at       = now();

  INSERT INTO club_member_table_state AS st
    (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (p->>'userId')
         NEW.table_id, (p->>'userId')::uuid, (p->>'stack')::numeric, NEW.hand_number
  FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) p
  WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at       = now();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %', SQLERRM;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ca_club_dashboard_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'total_members', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
    ),
    'online_now', (
      SELECT count(*) FROM (
        SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
        WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
        WHERE cm.club_id = p_club_id
          AND cm.last_active > now() - interval '15 minutes'
      ) x
    ),
    'active_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id AND t.status IN ('running', 'waiting', 'active')
    ),
    'total_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND (coalesce(t.is_deleted, false) = false OR t.status IN ('running', 'waiting', 'active'))
    ),
    -- club_hand_daily is exact (maintained per hand). club_daily_stats is the
    -- fallback for dates predating the rollup only.
    'hands_today', coalesce(
      (SELECT d.hands FROM club_hand_daily d
        WHERE d.club_id = p_club_id AND d.stat_date = (now() AT TIME ZONE 'UTC')::date),
      (SELECT ds.hands_played FROM club_daily_stats ds
        WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date),
      0),
    'rake_today', coalesce(
      (SELECT d.rake FROM club_hand_daily d
        WHERE d.club_id = p_club_id AND d.stat_date = (now() AT TIME ZONE 'UTC')::date),
      (SELECT ds.rake_collected FROM club_daily_stats ds
        WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date),
      0),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
    ),
    'hands_week', coalesce((
      SELECT sum(coalesce(d.hands, ds.hands_played, 0))
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 6,
                           (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_daily_stats ds ON ds.club_id = p_club_id AND ds.stat_date = g.day::date
    ), 0),
    'rake_week', coalesce((
      SELECT sum(coalesce(d.rake, ds.rake_collected, 0))
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 6,
                           (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_daily_stats ds ON ds.club_id = p_club_id AND ds.stat_date = g.day::date
    ), 0),
    'seated_now', (
      SELECT count(*) FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE t.club_id = p_club_id AND ts.left_at IS NULL
    ),
    'daily_series', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'hands', coalesce(d.hands, ds.hands_played, 0),
               'rake',  coalesce(d.rake,  ds.rake_collected, 0))
             ORDER BY g.day)
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 13,
                           (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_daily_stats ds ON ds.club_id = p_club_id AND ds.stat_date = g.day::date
    ), '[]'::jsonb)
  ) INTO v;

  RETURN v;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_dashboard_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_dashboard_stats(uuid) TO authenticated, service_role;
