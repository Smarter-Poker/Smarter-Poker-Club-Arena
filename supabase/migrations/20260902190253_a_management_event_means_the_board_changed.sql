-- A management event means the board changed. (Part 1 of 2: the game rows.)
--
-- Table Management subscribes to every game_management_events row for its
-- scope and turns each one into a full board refresh, and this emitter fired
-- on EVERY row write with no test of whether anything the board renders had
-- moved: `updated_at`, `current_level`, `level_started_at`, `on_break`,
-- `break_ends_at`, `total_rake`, `hands_dealt`, `avg_pot`, `live_state`,
-- `bomb_pot_sched_state` - the heartbeat of every running game, none of which
-- the board shows.
--
-- Measured on Deep Stack Society (2a1132b9-5ba2-42e6-9f01-30a7fcffebe3) in the
-- hour before this change: 16,685 tournament events and 2,502 table events,
-- out of 235,306 rows accumulated for that one club. Every one was delivered
-- to every open management page and turned into a five-round-trip reload,
-- which is how the page came to sit on "Loading Live Game Controls..." and
-- never leave it.
--
-- This changes WHEN an event is emitted, never WHAT it says. The UPDATE guard
-- compares exactly the projection fn_list_managed_games returns, so if the
-- board would render differently, an event still fires. INSERT and DELETE are
-- untouched: they always change the board. The test is on which columns moved
-- and never on who was in the seat, so horses announce and are announced
-- exactly as any other player.
--
-- Split from the club_members half of this change because the two together
-- deadlocked against a realtime worker: any DDL here contends on
-- realtime.subscription, and holding AccessExclusive on a table as hot as
-- club_members for the length of a two-part migration is asking for it.

BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_emit_managed_game_row_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club  uuid := COALESCE(to_jsonb(NEW) ->> 'club_id', to_jsonb(OLD) ->> 'club_id')::uuid;
  v_id    uuid := COALESCE(to_jsonb(NEW) ->> 'id',      to_jsonb(OLD) ->> 'id')::uuid;
  v_watch text[];
BEGIN
  -- Tournament backing tables are represented by the tournament event itself.
  IF TG_TABLE_NAME = 'tables' THEN
    IF COALESCE(to_jsonb(NEW) ->> 'tournament_id',
                to_jsonb(OLD) ->> 'tournament_id') IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Exactly the columns fn_list_managed_games projects for this kind. Keep
    -- these two lists in step with that function: a column the board reads and
    -- this does not watch is a row that silently stops refreshing.
    v_watch := CASE TG_TABLE_NAME
      WHEN 'tables' THEN ARRAY[
        'club_id', 'union_id', 'tournament_id', 'is_deleted', 'name', 'status',
        'game_variant', 'current_players', 'max_players', 'small_blind',
        'big_blind', 'min_buy_in', 'max_buy_in', 'created_at']
      ELSE ARRAY[
        'club_id', 'union_id', 'name', 'status', 'game_type', 'variant',
        'current_players', 'max_players', 'start_time', 'created_at',
        'buy_in_amount', 'guaranteed_prize', 'prize_pool']
    END;

    IF (SELECT jsonb_object_agg(k, COALESCE(to_jsonb(OLD) -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
       IS NOT DISTINCT FROM
       (SELECT jsonb_object_agg(k, COALESCE(to_jsonb(NEW) -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
    THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    'game_changed', v_club, NULL, NULL,
    CASE WHEN TG_TABLE_NAME = 'tables' THEN 'table' ELSE 'tournament' END,
    v_id, NULL, jsonb_build_object('operation', lower(TG_OP)));
  RETURN NULL;
END;
$fn$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_emit_managed_game_row_event'
      AND p.prosecdef
      AND p.prosrc LIKE '%v_watch%'
  ) THEN
    RAISE EXCEPTION
      'fn_emit_managed_game_row_event lost its security-definer flag or its changed-column guard';
  END IF;

  -- The guard is only correct while both game triggers still route through it.
  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND p.proname = 'fn_emit_managed_game_row_event'
        AND c.relname IN ('tables', 'tournaments')) <> 2 THEN
    RAISE EXCEPTION 'expected the tables and tournaments emitters to share fn_emit_managed_game_row_event';
  END IF;
END;
$assert$;

COMMIT;
