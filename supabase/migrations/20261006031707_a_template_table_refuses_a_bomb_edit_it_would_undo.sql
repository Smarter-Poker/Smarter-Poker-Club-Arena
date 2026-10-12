-- 20261006031707_a_template_table_refuses_a_bomb_edit_it_would_undo.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (launch audit 2026-10-05, bomb pot settings):
--
-- "Edit Bomb Pot Settings" calls fn_update_table_bomb_settings, a plain UPDATE
-- of public.tables. A table that belongs to a cash game (tables.cluster_id is
-- set; read on production: every open cash table) has its bomb columns
-- written back from cash_games.ruleset_snapshot by fn_cash_apply_ruleset on
-- every cluster tick, about every five seconds. So the host saw "saved" and
-- the table reverted with no message, and the save had already wiped the bomb
-- schedule (bomb_pot_sched_state, bomb_pot_next_due_at). The four columns the
-- ruleset does not write (fixed ante, bomb variant, button policy, announce
-- seconds) stuck, so a table could then play a bomb its lobby card and "Set
-- By The Template" readout did not describe.
--
-- Two writers of one rule. The template is the authority, so the table-level
-- door now refuses a template table before it writes anything, and says why.
-- A table with no cluster keeps the door exactly as it was.
--
-- The function is rewritten FROM ITS INSTALLED DEFINITION with one block
-- added, and the migration refuses a definition it was not written against.
--
-- @live-proof: position('set_by_the_game_template' in pg_get_functiondef('public.fn_update_table_bomb_settings(uuid,jsonb)'::regprocedure)) > 0

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
  c_fn     constant regprocedure := 'public.fn_update_table_bomb_settings(uuid,jsonb)'::regprocedure;
  c_anchor constant text := E'  v_enabled := COALESCE((p_settings ->> ''bomb_pot_enabled'')::boolean, false);\n';
  v_def    text := pg_get_functiondef(c_fn);
  v_new    text;
BEGIN
  -- Applying this twice changes nothing the second time.
  IF position('set_by_the_game_template' in v_def) > 0 THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '1686b0072db257921e0dfba91a888bf4' THEN
    RAISE EXCEPTION 'fn_update_table_bomb_settings is not the definition this migration was written against (md5 %); re-read it first', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_anchor, ''))) <> length(c_anchor) THEN
    RAISE EXCEPTION 'the first settings read was not found exactly once';
  END IF;

  v_new := replace(v_def, c_anchor, $block$  -- THE TEMPLATE IS THE ONE AUTHORITY (launch audit 2026-10-05). A table that
  -- belongs to a cash game has these columns written back from the game's
  -- ruleset on every cluster tick, so an edit here was undone within seconds
  -- after wiping the bomb schedule. Refused before anything is written.
  IF EXISTS (
    SELECT 1 FROM public.tables t WHERE t.id = p_table_id AND t.cluster_id IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'set_by_the_game_template');
  END IF;

$block$ || c_anchor);

  EXECUTE v_new;

  IF position('set_by_the_game_template' in pg_get_functiondef(c_fn)) = 0 THEN
    RAISE EXCEPTION 'a template table still accepts a bomb edit';
  END IF;
END
$do$;

COMMIT;
