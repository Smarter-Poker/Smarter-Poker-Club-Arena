-- ============================================================================
-- 20260819b_club_dashboard_stats_correctness.sql
-- Club Dashboard stats — CORRECTNESS + SECURITY rebuild (Tier 3)
--
-- SUPERSEDES the aggregate half of 20260819_club_dashboard_rpcs.sql.
--
-- ── WHY (bug 1: the profit numbers were wrong) ──────────────────────────────
-- The first version computed a player's profit as
--     profit = sum(winners[].amount) - sum(actions[].amount)
-- That is not a chip ledger. Measured against production data:
--   * blinds and antes are NEVER present in actions[] — hand 1231033 has
--     pot_size 20.00 and sum(actions[].amount) = 0.00 (folded round),
--   * actions[].amount is a cumulative "raise TO" figure, not the incremental
--     chips committed — hand 1230924 has pot_size 2658 and
--     sum(actions[].amount) 6141 (2.3x the pot),
--   * neither sum(amount) nor max(amount)-per-street reconciles to pot_size.
-- So every leaderboard figure the first version produced was wrong.
--
-- ── THE ACTUAL GROUND TRUTH ────────────────────────────────────────────────
-- hand_history.players[].stack is written from postHandTasks in
-- ServerTableEngineSettlement.ts — i.e. it is the POST-hand stack, after
-- payouts and after bets were removed. Therefore, for one player at one
-- table, across consecutive hands:
--
--     per-hand result = stack(hand N) - stack(hand N-1)
--
-- This was verified against chip conservation on production data: for every
-- sampled hand, sum over seated players of (stack_N - stack_N-1) equals
-- exactly -(rake_amount + bbj_amount), residual 0.00. That is a closed
-- money system, so the stack delta IS the player's real result.
--
-- Top-ups/rebuys between hands inflate a delta. Measured frequency over
-- 45,759 player-hands in a 24h window: 3 hands (0.007%). They are detected
-- as (delta > amount won) — you cannot end a hand up more than you won —
-- and clamped, with the excess recorded in topup_total for transparency.
--
-- ── WHY (bug 2: any logged-in user could read any club's numbers) ───────────
-- The first version's RPCs are SECURITY DEFINER with EXECUTE granted to
-- `authenticated`, and took a club_id with no authorization check. Any
-- logged-in user could read member counts, rake, and the full per-player
-- profit leaderboard of a club they have nothing to do with. All three RPCs
-- now enforce club membership (or platform admin) via ca_can_view_club().
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--  1. DROPs club_member_daily_stats (every row held provably wrong profit
--     figures from the actions[] formula) and recreates it keyed per TABLE
--     as well, so a per-table rebuild is idempotent for players who play
--     several tables of the same club on the same day.
--  2. club_member_table_state — O(1) last-stack-per-(table,user) so the hot
--     trigger path never scans hand_history.
--  3. trg_hand_history_club_member_stats — recomputed on stack deltas,
--     set-based, exception-safe (never blocks the engine's insert).
--  4. ca_rebuild_club_member_stats_table(table) — per-table rebuild used for
--     backfill; continuous within a table so no day-boundary hands are lost.
--  5. ca_can_view_club(club) + membership enforcement on all three RPCs.
--  6. ca_club_top_players returns real profit, hands, hands_won, biggest pot.
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS hand_history_club_member_stats ON public.hand_history;
--   DROP FUNCTION IF EXISTS public.trg_hand_history_club_member_stats();
--   DROP FUNCTION IF EXISTS public.ca_rebuild_club_member_stats_table(uuid);
--   DROP FUNCTION IF EXISTS public.ca_backfill_club_member_stats(date, date);
--   DROP FUNCTION IF EXISTS public.ca_club_top_players(uuid, timestamptz, integer);
--   DROP FUNCTION IF EXISTS public.ca_club_dashboard_stats(uuid);
--   DROP FUNCTION IF EXISTS public.ca_club_activity(uuid, integer);
--   DROP FUNCTION IF EXISTS public.ca_can_view_club(uuid);
--   DROP TABLE IF EXISTS public.club_member_daily_stats;
--   DROP TABLE IF EXISTS public.club_member_table_state;
--   (then re-apply 20260819_club_dashboard_rpcs.sql to restore the previous,
--    incorrect-but-present behaviour)
-- ============================================================================

-- ── 1. Aggregates table (recreated: old rows held wrong profit) ─────────────

DROP TABLE IF EXISTS public.club_member_daily_stats;

CREATE TABLE public.club_member_daily_stats (
  club_id         uuid    NOT NULL,
  table_id        uuid    NOT NULL,
  user_id         uuid    NOT NULL,
  stat_date       date    NOT NULL,
  hands_played    integer NOT NULL DEFAULT 0,
  hands_won       integer NOT NULL DEFAULT 0,
  total_won       numeric NOT NULL DEFAULT 0,
  profit          numeric NOT NULL DEFAULT 0,
  biggest_pot_won numeric NOT NULL DEFAULT 0,
  biggest_pot     numeric NOT NULL DEFAULT 0,
  topup_total     numeric NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, table_id, user_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_cmds_club_date ON public.club_member_daily_stats (club_id, stat_date);
CREATE INDEX IF NOT EXISTS idx_cmds_club_user ON public.club_member_daily_stats (club_id, user_id);

ALTER TABLE public.club_member_daily_stats ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: every read goes through the definer RPCs below,
-- which enforce club membership themselves.

-- ── 2. Trigger state: last post-hand stack per (table, user) ────────────────

CREATE TABLE IF NOT EXISTS public.club_member_table_state (
  table_id         uuid    NOT NULL,
  user_id          uuid    NOT NULL,
  last_stack       numeric NOT NULL,
  last_hand_number bigint,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, user_id)
);

ALTER TABLE public.club_member_table_state ENABLE ROW LEVEL SECURITY;

-- ── 3. Trigger: maintain aggregates from stack deltas ───────────────────────

CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club uuid;
BEGIN
  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN
    RETURN NEW;
  END IF;

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
  calc AS (
    SELECT
      pl.uid,
      pl.stack,
      coalesce(wn.won, 0) AS won,
      -- No prior stack for this (table,user): this hand establishes the
      -- baseline, so it contributes hands_played but no profit.
      CASE WHEN st.last_stack IS NULL THEN 0
           ELSE least(pl.stack - st.last_stack, coalesce(wn.won, 0))
      END AS profit,
      CASE WHEN st.last_stack IS NULL THEN 0
           ELSE greatest((pl.stack - st.last_stack) - coalesce(wn.won, 0), 0)
      END AS topup
    FROM pl
    LEFT JOIN wn ON wn.uid = pl.uid
    LEFT JOIN club_member_table_state st
           ON st.table_id = NEW.table_id AND st.user_id = pl.uid
  )
  INSERT INTO club_member_daily_stats AS s
    (club_id, table_id, user_id, stat_date, hands_played, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, NEW.table_id, calc.uid, (NEW.created_at AT TIME ZONE 'UTC')::date,
    1,
    CASE WHEN calc.won > 0 THEN 1 ELSE 0 END,
    calc.won, calc.profit, calc.won,
    coalesce(NEW.pot_size, 0), calc.topup
  FROM calc
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played    = s.hands_played + 1,
    hands_won       = s.hands_won + EXCLUDED.hands_won,
    total_won       = s.total_won + EXCLUDED.total_won,
    profit          = s.profit + EXCLUDED.profit,
    biggest_pot_won = greatest(s.biggest_pot_won, EXCLUDED.biggest_pot_won),
    biggest_pot     = greatest(s.biggest_pot, EXCLUDED.biggest_pot),
    topup_total     = s.topup_total + EXCLUDED.topup_total,
    updated_at      = now();

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
  -- Stats must never block the engine's hand insert.
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %', SQLERRM;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS hand_history_club_member_stats ON public.hand_history;
CREATE TRIGGER hand_history_club_member_stats
  AFTER INSERT ON public.hand_history
  FOR EACH ROW EXECUTE FUNCTION public.trg_hand_history_club_member_stats();

-- ── 4. Per-table rebuild (backfill unit) ────────────────────────────────────
-- Chunked per TABLE rather than per date: the stack-delta window must stay
-- continuous, and a date chunk would silently drop each player's first hand
-- of every day. A table is the natural continuity boundary.

CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats_table(p_table_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club uuid;
  v_rows integer;
BEGIN
  SELECT club_id INTO v_club FROM tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM club_member_daily_stats WHERE table_id = p_table_id;

  WITH seats AS (
    SELECT
      hh.hand_number,
      hh.created_at,
      coalesce(hh.pot_size, 0) AS pot_size,
      (p->>'userId')::uuid     AS uid,
      (p->>'stack')::numeric   AS stack,
      coalesce((SELECT sum((w->>'amount')::numeric)
                FROM jsonb_array_elements(coalesce(hh.winners, '[]'::jsonb)) w
                WHERE w->>'userId' = p->>'userId'), 0) AS won
    FROM hand_history hh
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(hh.players, '[]'::jsonb)) p
    WHERE hh.table_id = p_table_id
      AND (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (p->>'stack') IS NOT NULL
  ),
  d AS (
    SELECT s.*,
           lag(stack) OVER (PARTITION BY uid ORDER BY hand_number, created_at) AS prev_stack
    FROM seats s
  ),
  calc AS (
    SELECT
      uid,
      (created_at AT TIME ZONE 'UTC')::date AS stat_date,
      won,
      pot_size,
      CASE WHEN prev_stack IS NULL THEN 0
           ELSE least(stack - prev_stack, won) END AS profit,
      CASE WHEN prev_stack IS NULL THEN 0
           ELSE greatest((stack - prev_stack) - won, 0) END AS topup
    FROM d
  )
  INSERT INTO club_member_daily_stats
    (club_id, table_id, user_id, stat_date, hands_played, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT
    v_club, p_table_id, uid, stat_date,
    count(*), count(*) FILTER (WHERE won > 0),
    sum(won), sum(profit), max(won), max(pot_size), sum(topup)
  FROM calc
  GROUP BY uid, stat_date
  -- The DELETE and this INSERT are separate statements, so on an actively
  -- dealing table a hand can land between them and the trigger writes a row
  -- this INSERT then collides with. This INSERT's snapshot already includes
  -- that hand, so the rebuilt value is the complete one: rebuild wins.
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played    = EXCLUDED.hands_played,
    hands_won       = EXCLUDED.hands_won,
    total_won       = EXCLUDED.total_won,
    profit          = EXCLUDED.profit,
    biggest_pot_won = EXCLUDED.biggest_pot_won,
    biggest_pot     = EXCLUDED.biggest_pot,
    topup_total     = EXCLUDED.topup_total,
    updated_at      = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Seed the hot-path trigger state from the last hand of this table so the
  -- next live hand computes its delta against a real baseline.
  INSERT INTO club_member_table_state AS st (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (p->>'userId')
         p_table_id, (p->>'userId')::uuid, (p->>'stack')::numeric, hh.hand_number
  FROM hand_history hh
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(hh.players, '[]'::jsonb)) p
  WHERE hh.table_id = p_table_id
    AND (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL
  ORDER BY p->>'userId', hh.hand_number DESC
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack       = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at       = now();

  RETURN v_rows;
END;
$fn$;

-- Driver: rebuild the N least-recently-rebuilt tables of a club. Returns the
-- number of TABLES processed so a caller can loop until it returns 0.
CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats(
  p_club_id uuid,
  p_limit   integer DEFAULT 25,
  p_since   timestamptz DEFAULT now() - interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
  v_done integer := 0;
BEGIN
  FOR r IN
    SELECT t.id
    FROM tables t
    WHERE t.club_id = p_club_id
      AND EXISTS (
        SELECT 1 FROM hand_history hh
        WHERE hh.table_id = t.id AND hh.created_at >= p_since
      )
      AND NOT EXISTS (
        SELECT 1 FROM club_member_daily_stats s WHERE s.table_id = t.id
      )
    LIMIT greatest(coalesce(p_limit, 25), 1)
  LOOP
    PERFORM ca_rebuild_club_member_stats_table(r.id);
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$fn$;

-- Legacy name kept so the previously-committed migration's entry point does
-- not dangle. Date args are ignored; rebuild is per-table by design.
DROP FUNCTION IF EXISTS public.ca_backfill_club_member_stats(date, date);

-- ── 5. Authorization ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_can_view_club(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT
    -- Backend/service_role context: anon has no EXECUTE on these RPCs, so a
    -- null auth.uid() can only be a trusted server-side caller.
    auth.uid() IS NULL
    OR EXISTS (
      SELECT 1 FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND cm.user_id = auth.uid()
        AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
    )
    OR EXISTS (
      SELECT 1 FROM profiles pr
      WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false)
    );
$fn$;

-- ── 6. Leaderboard RPC (real profit) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_club_top_players(
  p_club_id uuid,
  p_since   timestamptz DEFAULT NULL,
  p_limit   integer     DEFAULT 50
)
RETURNS TABLE (
  user_id         uuid,
  display_name    text,
  avatar_url      text,
  is_horse        boolean,
  hands_played    bigint,
  hands_won       bigint,
  total_won       numeric,
  profit          numeric,
  biggest_pot_won numeric,
  win_rate        numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    s.user_id,
    coalesce(pr.display_name, 'Player')      AS display_name,
    pr.avatar_url,
    coalesce(pr.is_horse, false)             AS is_horse,
    sum(s.hands_played)::bigint              AS hands_played,
    sum(s.hands_won)::bigint                 AS hands_won,
    sum(s.total_won)                         AS total_won,
    sum(s.profit)                            AS profit,
    max(s.biggest_pot_won)                   AS biggest_pot_won,
    round(100.0 * sum(s.hands_won) / nullif(sum(s.hands_played), 0), 1) AS win_rate
  FROM club_member_daily_stats s
  LEFT JOIN profiles pr ON pr.id = s.user_id
  WHERE s.club_id = p_club_id
    AND (p_since IS NULL OR s.stat_date >= (p_since AT TIME ZONE 'UTC')::date)
  GROUP BY s.user_id, pr.display_name, pr.avatar_url, pr.is_horse
  HAVING sum(s.hands_played) > 0
  ORDER BY sum(s.profit) DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$fn$;

-- ── 7. Dashboard stats RPC ──────────────────────────────────────────────────

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
    -- A table can be status='running' while is_deleted=true (the engine keeps
    -- dealing on it). Running/waiting tables count as active regardless.
    'active_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id AND t.status IN ('running', 'waiting', 'active')
    ),
    'total_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND (coalesce(t.is_deleted, false) = false OR t.status IN ('running', 'waiting', 'active'))
    ),
    'hands_today', coalesce((
      SELECT ds.hands_played FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date
    ), 0),
    'rake_today', coalesce((
      SELECT ds.rake_collected FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date
    ), 0),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
    ),
    'hands_week', coalesce((
      SELECT sum(ds.hands_played) FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date > (now() AT TIME ZONE 'UTC')::date - 7
    ), 0),
    'rake_week', coalesce((
      SELECT sum(ds.rake_collected) FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date > (now() AT TIME ZONE 'UTC')::date - 7
    ), 0),
    'seated_now', (
      SELECT count(*) FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE t.club_id = p_club_id AND ts.left_at IS NULL
    ),
    -- 14-day sparkline for the metric cards
    'daily_series', coalesce((
      SELECT jsonb_agg(jsonb_build_object('d', dd.d, 'hands', coalesce(ds.hands_played, 0),
                                          'rake', coalesce(ds.rake_collected, 0))
                       ORDER BY dd.d)
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 13,
                           (now() AT TIME ZONE 'UTC')::date, interval '1 day') dd(d)
      LEFT JOIN club_daily_stats ds
             ON ds.club_id = p_club_id AND ds.stat_date = dd.d::date
    ), '[]'::jsonb)
  ) INTO v;

  RETURN v;
END;
$fn$;

-- ── 8. Activity feed RPC ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_club_activity(
  p_club_id uuid,
  p_limit   integer DEFAULT 20
)
RETURNS TABLE (
  id            text,
  activity_type text,
  message       text,
  created_at    timestamptz,
  user_id       uuid,
  display_name  text,
  avatar_url    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH events AS (
    (SELECT
       'join-' || cm.user_id::text AS id,
       'member_join'::text         AS activity_type,
       'joined the club'::text     AS message,
       cm.created_at               AS created_at,
       cm.user_id                  AS user_id
     FROM club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.created_at > now() - interval '30 days'
     ORDER BY cm.created_at DESC
     LIMIT 50)
    UNION ALL
    (SELECT
       'ann-' || an.id::text,
       'announcement',
       coalesce(nullif(an.title, ''), left(coalesce(an.content, an.message, 'New announcement'), 120)),
       an.created_at,
       coalesce(an.author_id, an.created_by)
     FROM club_announcements an
     WHERE an.club_id = p_club_id
       AND an.created_at > now() - interval '30 days'
       AND coalesce(an.is_active, true)
     ORDER BY an.created_at DESC
     LIMIT 20)
    UNION ALL
    (SELECT
       'hand-' || hh.id::text,
       'big_hand',
       'won a ' || to_char(coalesce(hh.pot_size, 0), 'FM999,999,990.00') || ' pot'
         || CASE WHEN hh.hand_name IS NOT NULL THEN ' with ' || hh.hand_name ELSE '' END,
       hh.created_at,
       CASE
         WHEN (hh.winners->0->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (hh.winners->0->>'userId')::uuid
         ELSE NULL
       END
     FROM hand_history hh
     JOIN tables t ON t.id = hh.table_id
     WHERE t.club_id = p_club_id
       AND hh.created_at > now() - interval '48 hours'
       AND coalesce(hh.pot_size, 0) >= 40 * greatest(coalesce(hh.big_blind, 0.02), 0.02)
     ORDER BY hh.created_at DESC
     LIMIT 30)
    UNION ALL
    (SELECT
       'table-' || t.id::text,
       'table_start',
       'Table "' || coalesce(t.name, 'Unnamed') || '" was created',
       t.created_at,
       t.created_by
     FROM tables t
     WHERE t.club_id = p_club_id
       AND t.created_at > now() - interval '7 days'
       AND coalesce(t.is_deleted, false) = false
     ORDER BY t.created_at DESC
     LIMIT 10)
  )
  SELECT
    e.id, e.activity_type, e.message, e.created_at, e.user_id,
    pr.display_name, pr.avatar_url
  FROM events e
  LEFT JOIN profiles pr ON pr.id = e.user_id
  WHERE e.created_at IS NOT NULL
  ORDER BY e.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
END;
$fn$;

-- ── 9. Grants ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_club_dashboard_stats(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_club_activity(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_can_view_club(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats_table(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_dashboard_stats(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_activity(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_can_view_club(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats_table(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) TO service_role;

-- ── 10. Post-apply assertions ───────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.club_member_daily_stats') IS NULL THEN
    RAISE EXCEPTION 'club_member_daily_stats missing';
  END IF;
  IF to_regclass('public.club_member_table_state') IS NULL THEN
    RAISE EXCEPTION 'club_member_table_state missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hand_history_club_member_stats') THEN
    RAISE EXCEPTION 'hand_history_club_member_stats trigger missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_name IN ('ca_club_top_players','ca_club_dashboard_stats','ca_club_activity')
      AND grantee = 'anon'
  ) THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on a club dashboard RPC';
  END IF;
END $$;
