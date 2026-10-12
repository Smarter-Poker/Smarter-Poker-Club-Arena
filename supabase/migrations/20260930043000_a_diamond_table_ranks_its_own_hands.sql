-- 20260930043000_a_diamond_table_ranks_its_own_hands
--
-- Diamond Arena Phase 10, line 1 ("Scope histories/replays, earnings, stats,
-- leaderboards and wallet records to Diamond"): the last open piece.
-- Applied once to kuklfnapbkmacvwxktbh.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ WHAT IS WRONG ════════════════════════════════════════════════════════
--
-- The Leaderboard a player opens at a table asks fn_club_leaderboard_period_v2
-- for the table's club: net profit (total_winnings - total_losses) over a UTC
-- calendar window, measured from player_stats against its daily snapshots.
-- The post-commit projection keeps every Diamond hand out of player_stats on
-- purpose (Projection 2 is gated on NOT v_diamond: that table has no asset
-- dimension), so at a Diamond table the board is empty for ever.
--
-- Since 20260920065728 a Diamond hand keeps its own asset-stamped stat rows
-- (ca_hand_player_stat, asset = 'diamonds'), and they hold the same figures
-- the chip board ranks: won_amt is the hand's winners amount for the seat
-- (what Projection 2 adds to total_winnings) and invested_actions + my_blind
-- is everything the seat put in, net of a returned bet (what the engine's
-- totalInvested adds to total_losses through promo_apply_playthrough, cash
-- only). So the metric is the same. What the stat rows cannot do is hold a
-- window: the forward roll keeps each player's newest 1,000 rows per asset
-- (ca_roll_hand_stats_forward), and on 2026-09-30 the busiest players, all
-- horses, held 1,135 to 1,163 rows covering two to eight hours. A week, a
-- month or all time cannot be read back from them, and a horse's day often
-- cannot. The chip board survives the same retention because player_stats
-- keeps the running totals and a daily snapshot marks each window's start.
--
-- ═══ WHAT THIS DOES ═══════════════════════════════════════════════════════
--
-- 1. ca_diamond_player_day, new: the Diamond twin of those running totals,
--    one row per player per UTC day (hands_dealt, total_winnings,
--    total_losses, sum_big_blind, the player_stats names). A day is the
--    snapshot grain the chip board measures windows in, so every window is
--    a sum of whole days. Private: RLS on, no browser grant; only the reader
--    below and the service role read it.
-- 2. The post-commit projection folds each Diamond cash hand into it, by
--    asserted substitution (live md5 pinned, reverse proved), right after
--    the hand's stat rows are written: it reads THIS hand's Diamond stat
--    rows, whichever writer wrote them (the projection, or the forward roll
--    that can reach a hand first), so a hand is folded once, when it is
--    projected, and the retention can never take it back. It keeps chip
--    Projection 2's population: cash hands (no tournament) and seats with a
--    profile, horses included. Rows are folded in player order, the order
--    every stat writer takes (20260914212802). A chip hand never enters it.
-- 3. fn_diamond_arena_leaderboard_period(p_period, p_limit, p_offset), new:
--    fn_club_leaderboard_period_v2's profit board over the fold, clause for
--    clause. The same window (fn_leaderboard_period_window), measured from
--    the window's first day as the chip board measures from the snapshot
--    taken at 00:05 UTC that day; the same score (winnings - losses); the
--    same order (score descending, ties by user id), rank() with ties, total
--    ranked and rank change against the standings before yesterday (the
--    chip board's snapshot dated yesterday); the same activity rule (hands,
--    a tournament won, winnings or losses in the window), with a tournament
--    won counted from the arena's own events by the rule of
--    trg_tournament_completed_stats (position 1 or status 'winner' when the
--    event completes); the same columns, except total_rake, which a stat row
--    does not carry. Fixture accounts are left out, horses are not: "Fixture
--    accounts are not players; horses are" (docs/DIAMOND-RULINGS.md), by
--    fn_ca_is_fixture_account, which never matches a horse. It is a definer
--    because the fold is private; signed-in players and the service role
--    may call it, a visitor may not.
--
-- A chip table's board does not change: fn_club_leaderboard_period_v2 is not
-- touched (its md5 is asserted below) and a chip hand never reaches the
-- fold. Nothing is priced, no switch is touched, no Diamond moves, and
-- neither function is on fn_ca_guard_watchlist(). The preflight proves no
-- Diamond hand has been dealt, so the fold starts complete with no backfill.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-30:
--   fn_project_hand_side_effects_after_post_commit_20260908   daf6adcc7fb0784004f60a28a70b97cb
--   fn_club_leaderboard_period_v2 (asserted unchanged)        b44ad44876dbf9bb20b85193ae794013
--
-- The substitution runs through EXECUTE, which the liveness check cannot see,
-- so it states its own proof:
-- @live-proof: (SELECT position('INSERT INTO public.ca_diamond_player_day AS dd' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_project_hand_side_effects_after_post_commit_20260908')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. PREFLIGHT: NO DIAMOND HAND EXISTS, SO THE FOLD STARTS COMPLETE
-- ---------------------------------------------------------------------------
DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is open; this migration expects both closed';
  END IF;
  IF EXISTS (SELECT 1
               FROM public.clubs c
               JOIN public.tables t ON t.club_id = c.id
               JOIN public.hand_history h ON h.table_id = t.id
              WHERE c.asset = 'diamonds')
     OR EXISTS (SELECT 1
                  FROM public.clubs c
                  JOIN public.tournaments tr ON tr.club_id = c.id
                  JOIN public.hand_history h ON h.tournament_id = tr.id
                 WHERE c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'a Diamond hand already exists; the fold would start without it';
  END IF;
  IF to_regclass('public.ca_diamond_player_day') IS NOT NULL
     OR to_regprocedure('public.fn_diamond_arena_leaderboard_period(text,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'the Diamond board already exists; re-derive this migration';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE DIAMOND RUNNING TOTALS, ONE ROW PER PLAYER PER UTC DAY
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_diamond_player_day (
  user_id        uuid        NOT NULL,
  stat_date      date        NOT NULL,
  hands_dealt    integer     NOT NULL DEFAULT 0,
  total_winnings numeric     NOT NULL DEFAULT 0,
  total_losses   numeric     NOT NULL DEFAULT 0,
  sum_big_blind  numeric     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_diamond_player_day_pkey PRIMARY KEY (user_id, stat_date)
);
CREATE INDEX ca_diamond_player_day_stat_date_idx ON public.ca_diamond_player_day (stat_date);
ALTER TABLE public.ca_diamond_player_day ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_diamond_player_day FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ca_diamond_player_day TO service_role;
COMMENT ON TABLE public.ca_diamond_player_day IS
  'The Diamond twin of player_stats'' running totals for the Diamond Arena leaderboard: per player per UTC day, the Diamond cash hands dealt, what the seat won (won_amt), what it put in (invested_actions + my_blind) and the big blind, folded once per hand by the post-commit projection from that hand''s Diamond stat rows. The stat rows keep only a player''s newest 1,000 hands per asset; this keeps every day. Private (RLS, no browser grant); read by fn_diamond_arena_leaderboard_period. Migration 20260930043000_a_diamond_table_ranks_its_own_hands.';

-- ---------------------------------------------------------------------------
-- 3. THE PROJECTION FOLDS EACH DIAMOND CASH HAND, ONCE
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)');
  v_def text;
  v_n integer;
  v_old text := $f$  ON CONFLICT (user_id,hand_id) DO NOTHING;

  -- Daily Mission booking has its own durable outbox. The hand-history
$f$;
  v_new text := $f$  ON CONFLICT (user_id,hand_id) DO NOTHING;

  -- Projection 4b: the Diamond leaderboard's running totals (migration
  -- 20260930043000). The stat rows keep a player's newest 1,000 hands of an
  -- asset, so a window cannot be read back from them; this keeps what
  -- Projection 2 keeps for chips (cash hands, seats with a profile): hands,
  -- won, put in and the big blind, per player per UTC day, from this hand's
  -- Diamond stat rows whichever writer wrote them. Player order, as every
  -- stat writer. A chip hand never enters this branch.
  IF COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL AND v_club IS NOT NULL THEN
    INSERT INTO public.ca_diamond_player_day AS dd
      (user_id,stat_date,hands_dealt,total_winnings,total_losses,sum_big_blind,updated_at)
    SELECT s.user_id,v_date,1,s.won_amt,s.invested_actions+s.my_blind,
           greatest(coalesce(v_h.big_blind,0),0),now()
      FROM public.ca_hand_player_stat s
     WHERE s.hand_id=v_h.id AND s.asset='diamonds' AND s.is_cash
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.user_id)
     ORDER BY s.user_id
    ON CONFLICT (user_id,stat_date) DO UPDATE SET
      hands_dealt=dd.hands_dealt+EXCLUDED.hands_dealt,
      total_winnings=dd.total_winnings+EXCLUDED.total_winnings,
      total_losses=dd.total_losses+EXCLUDED.total_losses,
      sum_big_blind=dd.sum_big_blind+EXCLUDED.sum_big_blind,
      updated_at=now();
  END IF;

  -- Daily Mission booking has its own durable outbox. The hand-history
$f$;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_project_hand_side_effects_after_post_commit_20260908(uuid) is missing';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'daf6adcc7fb0784004f60a28a70b97cb' THEN
    RAISE EXCEPTION 'the post-commit projection is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the post-commit projection: the stat-row insert end occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'daf6adcc7fb0784004f60a28a70b97cb' THEN
    RAISE EXCEPTION 'the post-commit projection: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 4. THE DIAMOND BOARD: THE CHIP PROFIT BOARD, CLAUSE FOR CLAUSE, OVER THE FOLD
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_diamond_arena_leaderboard_period(
  p_period text DEFAULT 'weekly'::text,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0)
RETURNS TABLE(user_id uuid, hands_played numeric, total_winnings numeric, total_losses numeric,
              tournaments_won numeric, sum_big_blind numeric, rank_change integer,
              qualified boolean, rank integer, total_ranked integer, baseline_date date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_arena uuid := public.fn_diamond_arena_club();
  v_period_start date;
  v_start_at timestamptz;
  -- The chip board's "previous" standings are its snapshot dated yesterday,
  -- taken at 00:05 UTC: everything dealt before yesterday.
  v_prev_end date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1;
  v_is_all_time boolean := p_period = 'all_time';
BEGIN
  -- The one calendar window every board uses; it refuses any other period.
  SELECT bounds.start_date, bounds.start_at INTO v_period_start, v_start_at
    FROM public.fn_leaderboard_period_window(p_period, 0) bounds;

  RETURN QUERY
  WITH days AS (
    SELECT d.user_id AS uid,
           sum(d.hands_dealt)::numeric AS d_hands,
           sum(d.total_winnings) AS d_win,
           sum(d.total_losses) AS d_loss,
           sum(d.sum_big_blind) AS d_bb,
           coalesce(sum(d.total_winnings) FILTER (WHERE d.stat_date < v_prev_end), 0) AS p_win,
           coalesce(sum(d.total_losses) FILTER (WHERE d.stat_date < v_prev_end), 0) AS p_loss
      FROM public.ca_diamond_player_day d
     WHERE v_is_all_time OR d.stat_date >= v_period_start
     GROUP BY d.user_id
  ),
  -- A tournament won in the window, by trg_tournament_completed_stats' rule,
  -- counted from the arena's own events.
  wins AS (
    SELECT tp.user_id AS uid, count(*)::numeric AS d_twon
      FROM public.tournaments t
      JOIN public.tournament_players tp ON tp.tournament_id = t.id
     WHERE t.club_id = v_arena
       AND t.status = 'COMPLETED'
       AND (tp.position = 1 OR tp.status = 'winner')
       AND tp.user_id IS NOT NULL
       AND (v_is_all_time OR t.ended_at >= v_start_at)
     GROUP BY tp.user_id
  ),
  cur AS (
    SELECT coalesce(dy.uid, w.uid) AS uid,
           coalesce(dy.d_hands, 0) AS d_hands,
           coalesce(dy.d_win, 0) AS d_win,
           coalesce(dy.d_loss, 0) AS d_loss,
           coalesce(w.d_twon, 0) AS d_twon,
           coalesce(dy.d_bb, 0) AS d_bb,
           -- No previous standing for a player who had not played by then,
           -- nor for a window that had not started by then (the chip board's
           -- missing snapshot row, and its v_prev_end <= v_baseline).
           (NOT EXISTS (SELECT 1 FROM public.ca_diamond_player_day x
                         WHERE x.user_id = coalesce(dy.uid, w.uid)
                           AND x.stat_date < v_prev_end)
            OR (NOT v_is_all_time AND v_prev_end <= v_period_start)) AS no_prev,
           coalesce(dy.p_win, 0) AS p_win,
           coalesce(dy.p_loss, 0) AS p_loss
      FROM days dy
      FULL JOIN wins w ON w.uid = dy.uid
     WHERE NOT public.fn_ca_is_fixture_account(coalesce(dy.uid, w.uid))
  ),
  scored AS (
    SELECT c.*,
           (c.d_win - c.d_loss) AS score,
           (CASE WHEN c.no_prev THEN NULL ELSE (c.p_win - c.p_loss) END) AS prev_score
      FROM cur c
  ),
  ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY s.score DESC NULLS LAST, s.uid) AS rn_now,
           rank() OVER (ORDER BY s.score DESC NULLS LAST) AS rk_now,
           count(*) OVER () AS total_active,
           CASE WHEN s.prev_score IS NULL THEN NULL
                ELSE rank() OVER (ORDER BY s.prev_score DESC NULLS LAST) END AS rk_old
      FROM scored s
     WHERE (s.d_hands > 0 OR s.d_twon > 0 OR s.d_win <> 0 OR s.d_loss <> 0)
  )
  SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_bb,
         COALESCE((r.rk_old - r.rk_now)::integer, 0),
         true,
         r.rk_now::integer, r.total_active::integer,
         (CASE WHEN v_is_all_time THEN NULL ELSE v_period_start END)
    FROM ranked r
   ORDER BY r.rn_now
   LIMIT p_limit OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_arena_leaderboard_period(text, integer, integer) IS
  'The Diamond Arena''s table leaderboard: fn_club_leaderboard_period_v2''s profit board (winnings - losses over the same UTC calendar window, the same order, ties, activity rule and rank change) over ca_diamond_player_day, in whole Diamonds. Horses count; fixture accounts do not (docs/DIAMOND-RULINGS.md). Signed-in players and the service role. Migration 20260930043000_a_diamond_table_ranks_its_own_hands.';

REVOKE ALL ON FUNCTION public.fn_diamond_arena_leaderboard_period(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_arena_leaderboard_period(text, integer, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_fold regclass := to_regclass('public.ca_diamond_player_day');
  v_projection oid := to_regprocedure('public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)');
  v_reader oid := to_regprocedure('public.fn_diamond_arena_leaderboard_period(text,integer,integer)');
  v_period text;
  v_rows integer;
  v_refused boolean := false;
  v_bad text;
BEGIN
  IF v_fold IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ca_diamond_player_day'
            AND is_nullable = 'NO'
            AND (column_name, data_type) IN (('user_id', 'uuid'), ('stat_date', 'date'),
                                             ('hands_dealt', 'integer'), ('total_winnings', 'numeric'),
                                             ('total_losses', 'numeric'), ('sum_big_blind', 'numeric'),
                                             ('updated_at', 'timestamp with time zone'))) <> 7
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ca_diamond_player_day') <> 7
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = v_fold AND contype = 'p'
                       AND pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, stat_date)') THEN
    RAISE EXCEPTION 'the Diamond running totals are not the table as written';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_fold)
     OR has_table_privilege('anon', v_fold, 'SELECT')
     OR has_table_privilege('authenticated', v_fold, 'SELECT')
     OR has_table_privilege('anon', v_fold, 'INSERT')
     OR has_table_privilege('authenticated', v_fold, 'INSERT')
     OR NOT has_table_privilege('service_role', v_fold, 'SELECT') THEN
    RAISE EXCEPTION 'the Diamond running totals must be private to the server';
  END IF;

  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname = 'fn_project_hand_side_effects_after_post_commit_20260908') <> 1
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_projection)
     OR has_function_privilege('anon', v_projection, 'EXECUTE')
     OR has_function_privilege('authenticated', v_projection, 'EXECUTE') THEN
    RAISE EXCEPTION 'the post-commit projection must stay one server-only definer';
  END IF;
  IF (length(pg_get_functiondef(v_projection))
      - length(replace(pg_get_functiondef(v_projection), 'INSERT INTO public.ca_diamond_player_day AS dd', '')))
     / length('INSERT INTO public.ca_diamond_player_day AS dd') <> 1 THEN
    RAISE EXCEPTION 'the post-commit projection does not fold a Diamond cash hand exactly once';
  END IF;

  IF v_reader IS NULL
     OR (SELECT count(*) FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname = 'fn_diamond_arena_leaderboard_period') <> 1
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_reader)
     OR has_function_privilege('anon', v_reader, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_reader, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_reader, 'EXECUTE') THEN
    RAISE EXCEPTION 'the Diamond board must be one definer a signed-in player can call and a visitor cannot';
  END IF;

  IF md5(pg_get_functiondef('public.fn_club_leaderboard_period_v2(uuid,text,text,integer,integer)'::regprocedure))
     <> 'b44ad44876dbf9bb20b85193ae794013' THEN
    RAISE EXCEPTION 'the chip board changed; a chip table''s leaderboard must stay what it was';
  END IF;

  FOREACH v_period IN ARRAY ARRAY['daily', 'weekly', 'monthly', 'all_time'] LOOP
    SELECT count(*) INTO v_rows FROM public.fn_diamond_arena_leaderboard_period(v_period, 25, 0);
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'the Diamond board ranks % players for %, but no Diamond hand has been dealt', v_rows, v_period;
    END IF;
  END LOOP;
  BEGIN
    PERFORM public.fn_diamond_arena_leaderboard_period('session', 25, 0);
  EXCEPTION WHEN invalid_parameter_value THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'the Diamond board answered a period the chip board refuses';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a Diamond switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond table ranks its own hands: the running totals are private, the projection folds a Diamond cash hand once, the board answers every period and starts empty, the chip board is unchanged, nothing opened';
END $m$;

COMMIT;
