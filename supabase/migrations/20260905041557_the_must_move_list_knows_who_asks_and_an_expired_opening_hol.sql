-- 20260905041557_the_must_move_list_knows_who_asks_and_an_expired_opening_hol.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Operation Table Stakes deep dive, 2026-09-05 04:30 UTC):
--
-- 1. THE MUST-MOVE LIST KNOWS WHO ASKS. `fn_cash_game_must_move_list` (#3055)
--    is SECURITY DEFINER, executable by `authenticated`, takes no identity and
--    never reads one - exactly the shape `check-telemetry-exposure.mjs` refuses,
--    and it has failed that check on every pull request since it merged. The
--    list is meant to be posted (Dan: "RECORD AND POST THE ORDER OF WHEN A
--    PLAYER JOINED THE GAME"), so it stays readable - by a signed-in caller or
--    the engine. A caller with no account gets an empty list, not a roster.
--
-- 2. AN EXPIRED OPENING HOLD RESTS. With Main 1 full and ONE buyer, the tick
--    armed a 60 s hold, expired it, and re-armed it ten seconds later, for as
--    long as the table stayed full: two `cash_cluster_events` rows every 70 s
--    per game in that state (PLO4 0.10/0.25 Classic wrote 24 in 20 minutes).
--    After an expiry the game now rests five minutes before it may hold again.
--    The rest lives in `cash_games.opening_hold_rested_until`. Two buyers still
--    open a feeder at once; the rest only governs the one-buyer hold.
--
-- The tick body is patched IN PLACE by substring, asserted to match exactly
-- once, because the live body (md5 f2b83050…, `feat/gate-5-the-snapshot-is-
-- the-rule`, PR #3066) is ahead of the last file on main (060000, 1be446e7…)
-- and a full redefinition from either would clobber the other. The hold block
-- is byte-identical in both.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The list knows who asks
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_game_must_move_list(p_game_id uuid)
RETURNS TABLE(pos integer, user_id uuid, alias text, table_id uuid, table_name text, role text, main_index integer, joined_at timestamp with time zone)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  -- Posted for the game's players and the engine; nobody else. A caller with
  -- no account reads nothing (the empty list), the definer never raises.
  SELECT (row_number() OVER (ORDER BY r.joined_at, r.id))::integer AS pos,
         r.user_id, public.fn_player_display_name(r.user_id) AS alias,
         t.id, t.name, t.role, t.main_index, r.joined_at
    FROM public.cash_game_roster r
    JOIN public.table_seats ts ON ts.user_id = r.user_id AND ts.left_at IS NULL
    JOIN public.tables t ON t.id = ts.table_id AND t.cluster_id = r.game_id AND t.lifecycle <> 'closed'
   WHERE r.game_id = p_game_id AND r.left_at IS NULL
     AND NOT (t.role = 'main' AND t.main_index = 1)
     AND (auth.uid() IS NOT NULL OR public.fn_caller_is_engine())
   ORDER BY r.joined_at, r.id;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_game_must_move_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_must_move_list(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. An expired opening hold rests
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.cash_games ADD COLUMN IF NOT EXISTS opening_hold_rested_until timestamptz;

DO $do$
DECLARE src text; a_old text; a_new text; b_old text; b_new text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'fn_cash_cluster_tick' AND pronamespace = 'public'::regnamespace;

  a_old := E'      IF g.opening_hold_since IS NULL THEN\n        UPDATE public.cash_games SET opening_hold_since = v_now WHERE id = g.id;\n        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, ''table_opening_hold'');\n';
  a_new := E'      -- AN EXPIRED HOLD RESTS (2026-09-05): five minutes before the next.\n      IF g.opening_hold_since IS NULL\n         AND (g.opening_hold_rested_until IS NULL OR g.opening_hold_rested_until <= v_now) THEN\n        UPDATE public.cash_games SET opening_hold_since = v_now WHERE id = g.id;\n        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, ''table_opening_hold'');\n';
  b_old := E'      ELSIF g.opening_hold_since < v_now - interval ''60 seconds'' THEN\n        UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;\n        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, ''table_opening_hold_expired'');\n';
  b_new := E'      ELSIF g.opening_hold_since IS NOT NULL AND g.opening_hold_since < v_now - interval ''60 seconds'' THEN\n        UPDATE public.cash_games SET opening_hold_since = NULL, opening_hold_rested_until = v_now + interval ''5 minutes'' WHERE id = g.id;\n        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, ''table_opening_hold_expired'');\n';

  IF (length(src) - length(replace(src, a_old, ''))) / length(a_old) <> 1 THEN RAISE EXCEPTION 'hold-arm block not found exactly once'; END IF;
  IF (length(src) - length(replace(src, b_old, ''))) / length(b_old) <> 1 THEN RAISE EXCEPTION 'hold-expiry block not found exactly once'; END IF;
  src := replace(replace(src, a_old, a_new), b_old, b_new);
  EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS $fn$' || src || '$fn$';
END $do$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Assertions
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'fn_cash_cluster_tick' AND pronamespace = 'public'::regnamespace;
  IF src NOT LIKE '%opening_hold_rested_until <= v_now%' OR src NOT LIKE '%opening_hold_rested_until = v_now + interval ''5 minutes''%' THEN
    RAISE EXCEPTION 'fn_cash_cluster_tick does not rest an expired hold';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'fn_cash_game_must_move_list' AND pronamespace = 'public'::regnamespace;
  IF src NOT LIKE '%auth.uid() IS NOT NULL OR public.fn_caller_is_engine()%' THEN
    RAISE EXCEPTION 'fn_cash_game_must_move_list does not know who asks';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_games' AND column_name = 'opening_hold_rested_until') THEN
    RAISE EXCEPTION 'cash_games.opening_hold_rested_until is missing';
  END IF;
END $$;

COMMIT;
