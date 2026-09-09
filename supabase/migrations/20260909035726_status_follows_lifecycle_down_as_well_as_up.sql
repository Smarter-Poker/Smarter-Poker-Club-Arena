-- 20260909035726_status_follows_lifecycle_down_as_well_as_up.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A TABLE MUST NOT BE OPEN AND CLOSED AT THE SAME TIME
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tables` carries two liveness fields and they can disagree. `fn_cash_cluster_tick`
-- already repairs ONE direction, and its own comment names the cause:
--
--   -- status = 'closed' with lifecycle still 'live' (an operator's close-game
--   -- action and the pre-controller close path write status only). The census
--   -- reads status and drops them, the roles step reads lifecycle and still
--   -- counts them, so a game could hold a Main 1 nobody could see and a feeder
--   -- with nobody to feed.
--
-- The MIRROR had no repair at all, and it is the one that reaches a player:
-- `lifecycle = 'closed'` with `status = 'waiting'`. The lobby and every
-- status-based read treat that table as joinable, while `fn_cash_apply_ruleset`
-- skips it - its WHERE is `t.lifecycle <> 'closed'` - so it can be sat at while
-- carrying a ruleset nothing is reconciling.
--
-- MEASURED 2026-09-09 03:55 UTC: **32 fleet tables** in exactly that state, the
-- oldest since 2026-09-04. Five of them were still advertising an ante or a bomb
-- pot after their game had already been corrected to the Classic contract, for
-- precisely this reason - the reconciler could not see them.
--
-- THE FIX is symmetric with the repair that already exists: an EMPTY table whose
-- lifecycle is closed has its status follow it down. Only empty ones. A
-- closed-lifecycle table WITH a seat is already sent back to `breaking` by the
-- sweep further up in the same function, which is the path that walks it empty
-- first - so no player is ever closed out from under.
--
-- It emits `status_followed_lifecycle` into `cash_cluster_events` and adds it to
-- the tick's `v_actions`, exactly as its mirror does, so the repair is visible
-- rather than silent.
--
-- ORDERING MATTERS AND I GOT IT WRONG ONCE. The first apply inserted this block
-- BETWEEN the lifecycle-follows-status UPDATE and its own `GET DIAGNOSTICS
-- v_n = ROW_COUNT`, which silently stole that statement's row count for my
-- event. It was corrected in the same session by moving the block BELOW the
-- pair it had split. `GET DIAGNOSTICS` reads the statement immediately before
-- it; anything inserted between an UPDATE and its diagnostics changes what the
-- older code reports. This file is the corrected end state.
--
-- HOW THIS EDITS THE FUNCTION. The body is 38KB and owns the whole cluster tick.
-- This reads the LIVE definition, does one literal insertion, and refuses to
-- proceed if the anchor is absent or if a landmark goes missing from the result.
--
-- ROLLBACK
--   Delete the `status_followed_lifecycle` UPDATE and its event block.
--
-- Wrap ALL DDL for one change in ONE transaction (club-arena CLAUDE.md,
-- production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  -- Anchor on the COMPLETE lifecycle-follows-status pair, so the new block can
  -- only ever land after it and can never split an UPDATE from its diagnostics.
  v_anchor CONSTANT text :=
'  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, ''lifecycle_followed_status'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''lifecycle_followed_status'', v_n);
  END IF;';
  v_repl CONSTANT text :=
'  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, ''lifecycle_followed_status'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''lifecycle_followed_status'', v_n);
  END IF;

  -- AND THE SAME SPLIT IN THE OTHER DIRECTION (2026-09-09).
  -- `lifecycle closed / status waiting` had no repair, and it is the one that
  -- reaches a player: the lobby treats the table as joinable while
  -- fn_cash_apply_ruleset skips it as closed, so it can be sat at carrying a
  -- ruleset nothing is reconciling. 32 fleet tables were in that state.
  -- Only EMPTY ones follow down; one with a seat is already sent back to
  -- `breaking` by the sweep above, which walks it empty first.
  UPDATE public.tables SET status = ''closed'', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND lifecycle = ''closed'' AND status <> ''closed''
     AND coalesce(is_deleted, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, ''status_followed_lifecycle'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''status_followed_lifecycle'', v_n);
  END IF;';
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position('status_followed_lifecycle' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION
      'the lifecycle_followed_status pair is not in the live definition in the shape this migration expects';
  END IF;

  v_new := replace(v_src, v_anchor, v_repl);

  IF position('status_followed_lifecycle' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  IF position('lifecycle_followed_status' in v_new) = 0
     OR position('fn_platform_frozen' in v_new) = 0
     OR position('AND NOT (g.enabled AND role = ''main'' AND main_index = 1)' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

COMMIT;
