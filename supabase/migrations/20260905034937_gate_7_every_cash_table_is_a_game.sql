-- 20260905034937_gate_7_every_cash_table_is_a_game.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- GATE 7 - THE CUTOVER: EVERY CASH TABLE IS A GAME (Operation Table Stakes,
-- OPORD 1.4 s2.3 / 18.6; Dan 2026-09-05 "DO WHAT YOU THINK NEEDS TO BE DONE")
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Read from production at 04:10 UTC: 105 open cash tables outside a cluster
-- (193 seated), 104 of them Deep Stack Society's, opened by Operation Stable
-- Hand's planner (`openPlannedTables`) as plain tables; one Midway Union stray
-- whose game already exists. Every rule in Gates 0-6 - the stay clock and the
-- winner's floor, must-move in join order, the seat change, the snapshot as
-- the rule, one card per game - stops at those tables. OPORD ROE 18 says no
-- agent instruction opens a cash table; the recon (docs/HANDOFF-TABLE-STAKES-
-- GATE-7.md) put three options to Dan and he chose to proceed: OPTION A. The
-- Stable Hand plans GAMES from here (engine, same PR: it asks
-- fn_cash_game_ensure for a game per key and never inserts a table), and the
-- cluster controller runs every table on the platform.
--
-- This migration:
--
-- 1. `fn_cash_game_ensure(club, variant, sb, bb, template, handedness)` -
--    service-only: the game for a key, created with Main 1 if absent
--    (the platform's own default games are "created from the same path",
--    OPORD s2.1), re-enabled if disabled. The Stable Hand's new open order.
-- 2. THE ADOPTION. For each (club, variant, sb, bb) with open cash tables and
--    no game: one cash_games row whose snapshot is built FROM the key's
--    oldest table - its ante, VPIP floor and window, bomb clock, buy-in band,
--    seats, options - so Gate 5's applier changes NOTHING on those tables on
--    day one, except straddles (R2: no straddles on any cash game; 6 keys).
--    Template by the shape of those rules. Tables join the game by age: the
--    oldest is Main 1, the next are Main 2..N, the newest of two or more is
--    the feeder; an empty one goes in `breaking` so the tick closes it with
--    nobody to cash out. The union stray joins its existing game. Names take
--    the cluster convention. The Stable Hand's park/retire keys and the
--    lifecycle-pass flags come off (a cluster table's life is the
--    controller's). Everyone seated goes on the game's roster at their chair
--    time. `game_adopted` records each game with its counts.
-- 3. THE LAW, in the database: `tables_cash_needs_a_game` - an open cash
--    table (no tournament, not closed/deleted) must carry a cluster_id. Added
--    NOT VALID (no scan under an exclusive lock on a realtime-published
--    table; new rows are checked at once) and validated in its own
--    transaction, which takes no lock that blocks play.
--
-- Handedness is the oldest table's max_players, not forced to R1's 6 for the
-- PLO family: 8 seated at an 8-max table cannot be told to stand. The seat
-- law for NEW games is unchanged (fn_cash_game_create enforces 6).
--
-- Probed rolled back over every key first (scripts/dev/probe-cutover.sql).
--
-- ROLLBACK:
--   ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game;
--   DROP FUNCTION IF EXISTS public.fn_cash_game_ensure(uuid, text, numeric, numeric, text, integer);
--   -- the adopted games: UPDATE tables SET cluster_id = NULL, role = NULL,
--   -- main_index = NULL, lifecycle = NULL WHERE cluster_id IN (SELECT game_id
--   -- FROM cash_cluster_events WHERE kind = 'game_adopted'); then delete
--   -- those cash_games rows. Their snapshots came from the tables, so the
--   -- tables carry their own rules again the moment the link is cut.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 1 - the door the Stable Hand uses, and the adoption (DML)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_cash_game_ensure(
  p_club_id uuid, p_variant text, p_sb numeric, p_bb numeric,
  p_template text DEFAULT 'classic', p_handedness integer DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  g record; v_def jsonb; v_snap jsonb; v_id uuid; v_union uuid;
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(p_variant);
  v_label text; v_variant_label text; v_name text; v_seats integer;
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN v_t := 'classic'; END IF;
  SELECT * INTO g FROM public.cash_games
   WHERE club_id = p_club_id AND variant = v_v AND sb = p_sb AND bb = p_bb
   ORDER BY enabled DESC, created_at LIMIT 1;
  IF FOUND THEN
    IF NOT g.enabled THEN
      UPDATE public.cash_games SET enabled = true, closed_at = NULL, closed_by = NULL, updated_at = now()
       WHERE id = g.id;
      INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, 'game_woken', jsonb_build_object('by', 'fn_cash_game_ensure'));
    END IF;
    -- A game with no open table at all: Main 1 is opened, as at creation.
    IF NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
                    AND coalesce(t.is_deleted, false) = false) THEN
      PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
    END IF;
    RETURN g.id;
  END IF;

  v_def := public.fn_cash_template_defaults(v_t, v_v);
  v_seats := coalesce(p_handedness, (v_def->>'seats')::integer, 6);
  v_snap := v_def || jsonb_build_object('seats', v_seats, 'sb', p_sb, 'bb', p_bb,
                                        'resolved_at', to_jsonb(clock_timestamp()),
                                        'created_by', 'fn_cash_game_ensure');
  v_variant_label := CASE v_v
    WHEN 'nlh' THEN 'NLH' WHEN 'plo4' THEN 'PLO4' WHEN 'plo5' THEN 'PLO5' WHEN 'plo6' THEN 'PLO6'
    WHEN 'plo8' THEN 'PLO8' WHEN 'flo8' THEN 'FLO8' WHEN 'flh' THEN 'FLH'
    WHEN 'short_deck' THEN 'Short Deck' WHEN 'pineapple' THEN 'Pineapple' ELSE upper(v_v) END;
  v_label := public.fn_cash_stakes_label(p_sb, p_bb, v_v);
  v_name := left(v_variant_label || ' ' || v_label || ' ' || initcap(v_t), 60);
  SELECT u.id INTO v_union
    FROM public.fn_club_union_context(p_club_id) ctx
    JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);

  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move)
  VALUES
    (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, NULL, true)
  RETURNING id INTO v_id;
  PERFORM public.fn_cash_cluster_open_table(v_id, 'main', 1, 'live', NULL);
  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (v_id, 'game_created', jsonb_build_object('name', v_name, 'must_move', true, 'by', 'fn_cash_game_ensure'));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_game_ensure(uuid, text, numeric, numeric, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_ensure(uuid, text, numeric, numeric, text, integer) TO service_role;

-- ── The adoption ────────────────────────────────────────────────────────────

DO $adopt$
DECLARE
  k record; o record; t record; g record;
  v_game uuid; v_template text; v_ante text; v_trigger text; v_snap jsonb; v_def jsonb;
  v_union uuid; v_name text; v_variant_label text; v_label text;
  v_idx integer; v_n integer; v_count integer;
  v_games integer := 0; v_tables integer := 0; v_seated integer := 0; v_broken integer := 0;
  v_has_feeder boolean; v_max_main integer;
BEGIN
  FOR k IN
    SELECT tb.club_id, tb.game_variant AS variant, tb.small_blind AS sb, tb.big_blind AS bb,
           count(*) AS n
      FROM public.tables tb
     WHERE tb.tournament_id IS NULL AND tb.cluster_id IS NULL
       AND coalesce(tb.is_deleted, false) = false
       AND tb.status NOT IN ('closed', 'deleted')
       AND tb.club_id IS NOT NULL AND tb.game_variant IS NOT NULL
       AND tb.small_blind > 0 AND tb.big_blind > tb.small_blind
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 2, 3, 4
  LOOP
    -- The key's oldest open table is the rulebook.
    SELECT * INTO o FROM public.tables tb
     WHERE tb.club_id = k.club_id AND tb.game_variant = k.variant AND tb.small_blind = k.sb AND tb.big_blind = k.bb
       AND tb.tournament_id IS NULL AND tb.cluster_id IS NULL AND coalesce(tb.is_deleted, false) = false
       AND tb.status NOT IN ('closed', 'deleted')
     ORDER BY tb.created_at, tb.id LIMIT 1;

    -- An existing game for the key (the union stray) adopts; otherwise one
    -- is written from the rulebook.
    SELECT * INTO g FROM public.cash_games gg
     WHERE gg.club_id = k.club_id AND gg.variant = k.variant AND gg.sb = k.sb AND gg.bb = k.bb
     ORDER BY gg.enabled DESC, gg.created_at LIMIT 1;
    IF FOUND THEN
      v_game := g.id;
    ELSE
      v_ante := CASE WHEN coalesce(o.ante_enabled, false) AND coalesce(o.ante, 0) > 0
                       THEN CASE WHEN coalesce(o.big_blind_ante_enabled, false) THEN 'bb' ELSE 'sb' END
                     ELSE 'none' END;
      v_trigger := CASE WHEN NOT coalesce(o.bomb_pot_enabled, false) THEN NULL
                        WHEN o.bomb_pot_trigger_mode = 'timed' THEN 'timed_15m'
                        ELSE 'every_orbit' END;
      v_template := CASE
        WHEN v_ante = 'bb' AND coalesce(o.nit_game, false) AND v_trigger = 'every_orbit' THEN 'madness'
        WHEN coalesce(o.nit_game, false) AND v_trigger = 'timed_15m' THEN 'action'
        ELSE 'classic' END;
      v_def := public.fn_cash_template_defaults(v_template, k.variant);
      v_snap := v_def || jsonb_build_object(
        'seats', coalesce(o.max_players, (v_def->>'seats')::integer, 6),
        'seat_choices', jsonb_build_array(coalesce(o.max_players, (v_def->>'seats')::integer, 6)),
        'regular_ante', v_ante,
        'vpip_floor', CASE WHEN coalesce(o.nit_game, false) THEN coalesce(o.maintain_percent_min, 0) ELSE 0 END,
        'vpip_window', coalesce(nullif(o.maintain_hands, 0), 10),
        'bombs', jsonb_build_object(
            'enabled', coalesce(o.bomb_pot_enabled, false),
            'trigger', v_trigger,
            'ante_bb', CASE WHEN coalesce(o.bomb_pot_enabled, false) THEN coalesce(o.bomb_pot_ante_multiplier, 2) END,
            'boards', CASE WHEN coalesce(o.bomb_pot_enabled, false) THEN coalesce(o.bomb_pot_board_count, 1) END),
        'min_buyin_bb', GREATEST(1, round(coalesce(nullif(o.min_buy_in, 0), k.bb * 40) / k.bb)::integer),
        'max_buyin_bb', GREATEST(2, round(coalesce(nullif(o.max_buy_in, 0), k.bb * 200) / k.bb)::integer),
        'straddle', false,
        'options', jsonb_build_object(
            'is_private', coalesce(o.is_private, false), 'is_vip_only', coalesce(o.is_vip_only, false),
            'is_anonymous', coalesce(o.is_anonymous, false), 'ban_chat', coalesce(o.ban_chat, false),
            'insurance_enabled', coalesce(o.insurance_enabled, false),
            'seven_deuce_enabled', coalesce(o.seven_deuce_enabled, false),
            'action_time_seconds', coalesce(o.action_time_seconds, 15)),
        'sb', k.sb, 'bb', k.bb,
        'resolved_at', to_jsonb(clock_timestamp()),
        'adopted_from', o.id);
      v_variant_label := CASE k.variant
        WHEN 'nlh' THEN 'NLH' WHEN 'plo4' THEN 'PLO4' WHEN 'plo5' THEN 'PLO5' WHEN 'plo6' THEN 'PLO6'
        WHEN 'plo8' THEN 'PLO8' WHEN 'flo8' THEN 'FLO8' WHEN 'flh' THEN 'FLH'
        WHEN 'short_deck' THEN 'Short Deck' WHEN 'pineapple' THEN 'Pineapple' ELSE upper(k.variant) END;
      v_label := public.fn_cash_stakes_label(k.sb, k.bb, k.variant);
      v_name := left(v_variant_label || ' ' || v_label || ' ' || initcap(v_template), 60);
      SELECT u.id INTO v_union
        FROM public.fn_club_union_context(k.club_id) ctx
        JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);
      INSERT INTO public.cash_games
        (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move,
         cap_mains)
      VALUES
        (k.club_id, v_union, v_name, v_template, k.variant, k.sb, k.bb,
         LEAST(9, GREATEST(2, coalesce(o.max_players, 6))), v_snap, NULL, true,
         GREATEST(8, LEAST(32, k.n::integer)))
      RETURNING id INTO v_game;
      SELECT * INTO g FROM public.cash_games WHERE id = v_game;
      v_games := v_games + 1;
    END IF;

    -- Roles by age. An existing game keeps its Main 1; the adopted tables
    -- take the next indexes.
    SELECT coalesce(max(main_index), 0), bool_or(role = 'feeder') INTO v_max_main, v_has_feeder
      FROM public.tables WHERE cluster_id = v_game AND lifecycle <> 'closed';
    v_has_feeder := coalesce(v_has_feeder, false);
    v_idx := 0; v_count := 0;
    FOR t IN
      SELECT tb.id, tb.created_at,
             (SELECT count(*) FROM public.table_seats s WHERE s.table_id = tb.id AND s.left_at IS NULL) AS seated,
             row_number() OVER (ORDER BY tb.created_at, tb.id) AS rn,
             count(*) OVER () AS total
        FROM public.tables tb
       WHERE tb.club_id = k.club_id AND tb.game_variant = k.variant AND tb.small_blind = k.sb AND tb.big_blind = k.bb
         AND tb.tournament_id IS NULL AND tb.cluster_id IS NULL AND coalesce(tb.is_deleted, false) = false
         AND tb.status NOT IN ('closed', 'deleted')
       ORDER BY tb.created_at, tb.id
    LOOP
      v_count := v_count + 1;
      IF t.rn = t.total AND (t.total > 1 OR v_max_main >= 1) AND NOT v_has_feeder THEN
        -- The newest joins as the feeder (when the game has a Main already).
        UPDATE public.tables
           SET cluster_id = v_game, role = 'feeder', main_index = NULL,
               lifecycle = CASE WHEN t.seated > 0 THEN 'live' ELSE 'breaking' END,
               break_started_at = CASE WHEN t.seated > 0 THEN NULL ELSE clock_timestamp() END,
               name = left(g.name, 50) || ' Feeder',
               auto_restart = false, auto_create_table = false, auto_extension = false,
               settings = coalesce(settings, '{}'::jsonb) - 'retire_when_empty' - 'night_parked',
               opened_at = coalesce(opened_at, t.created_at), live_at = coalesce(live_at, t.created_at),
               updated_at = now()
         WHERE id = t.id;
        v_has_feeder := true;
      ELSE
        v_max_main := v_max_main + 1;
        UPDATE public.tables
           SET cluster_id = v_game, role = 'main', main_index = v_max_main,
               lifecycle = CASE WHEN t.seated > 0 OR v_max_main = 1 THEN 'live' ELSE 'breaking' END,
               break_started_at = CASE WHEN t.seated > 0 OR v_max_main = 1 THEN NULL ELSE clock_timestamp() END,
               name = CASE WHEN v_max_main = 1 THEN g.name ELSE left(g.name, 50) || ' Main ' || v_max_main END,
               auto_restart = false, auto_create_table = false, auto_extension = false,
               settings = coalesce(settings, '{}'::jsonb) - 'retire_when_empty' - 'night_parked',
               opened_at = coalesce(opened_at, t.created_at), live_at = coalesce(live_at, t.created_at),
               updated_at = now()
         WHERE id = t.id;
      END IF;
      IF t.seated = 0 AND NOT (v_max_main = 1 AND t.rn = 1) THEN v_broken := v_broken + 1; END IF;
      v_tables := v_tables + 1;
      v_seated := v_seated + t.seated;
    END LOOP;

    -- Everyone seated is on the game's roster at their chair time.
    INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
    SELECT v_game, s.user_id, min(s.joined_at)
      FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
     WHERE tb.cluster_id = v_game AND s.left_at IS NULL AND s.user_id IS NOT NULL
     GROUP BY s.user_id
    ON CONFLICT (game_id, user_id) WHERE left_at IS NULL DO NOTHING;

    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (v_game, 'game_adopted',
            jsonb_build_object('club_id', k.club_id, 'variant', k.variant, 'sb', k.sb, 'bb', k.bb,
                               'tables', v_count, 'template', g.template_name, 'rulebook', o.id));
  END LOOP;

  RAISE NOTICE 'cutover: % games written, % tables adopted, % seated, % empty tables set breaking',
    v_games, v_tables, v_seated, v_broken;

  IF EXISTS (SELECT 1 FROM public.tables tb WHERE tb.tournament_id IS NULL AND tb.cluster_id IS NULL
              AND coalesce(tb.is_deleted, false) = false AND tb.status NOT IN ('closed', 'deleted')
              AND tb.club_id IS NOT NULL AND tb.game_variant IS NOT NULL AND tb.small_blind > 0 AND tb.big_blind > tb.small_blind) THEN
    RAISE EXCEPTION 'cutover: an open cash table is still outside a cluster';
  END IF;
END $adopt$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 2 - the law, added without a scan (lock-timed, retried by the applier)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game;
ALTER TABLE public.tables ADD CONSTRAINT tables_cash_needs_a_game
  CHECK (
    tournament_id IS NOT NULL
    OR cluster_id IS NOT NULL
    OR status IN ('closed', 'deleted')
    OR coalesce(is_deleted, false)
    OR club_id IS NULL
    OR game_variant IS NULL
    OR coalesce(small_blind, 0) <= 0
    OR coalesce(big_blind, 0) <= coalesce(small_blind, 0)
  ) NOT VALID;
COMMENT ON CONSTRAINT tables_cash_needs_a_game ON public.tables IS
  'Gate 7 (2026-09-05): an open cash table belongs to a cash_games row. There is no standalone cash table.';
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 3 - validate (SHARE UPDATE EXCLUSIVE: play continues)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;
ALTER TABLE public.tables VALIDATE CONSTRAINT tables_cash_needs_a_game;
COMMIT;
