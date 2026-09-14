-- 20260909181704_a_main_keeps_its_number_while_it_breaks
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
--
-- ═══════════════════════════════════════════════════════════════════════════
--  TWO TABLES CANNOT BOTH BE MAIN 2
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Step 6 of `fn_cash_cluster_tick` renumbers the mains:
--
--     FOR t IN SELECT * FROM unnest(v_census) c
--               WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main'
--               ORDER BY c.created_at LOOP
--       v_idx := v_idx + 1; ...
--
-- A main that is BREAKING is not in that set, so it keeps whatever
-- `main_index` it had while the survivors renumber past it.
--
-- That is reachable, and not rarely. Step 5 chooses the break candidate:
--
--     ORDER BY (c.seated = 0) DESC, (c.role = 'feeder') DESC,
--              c.main_index DESC NULLS FIRST, c.created_at DESC
--
-- EMPTY FIRST - deliberately, since 2026-09-05 ("an empty table has nobody to
-- move and nothing to interrupt"). So an empty Main 2 is chosen ahead of a
-- populated feeder. Mains 1, 2, 3 with Main 2 empty: Main 2 goes `breaking`
-- holding index 2, and the SAME tick renumbers Main 3 down to 2. Two tables on
-- the board carry `main_index = 2`, and both are named "<game> Main 2", until
-- the break completes and `fn_closed_cluster_main_releases_index` nulls the
-- index of the closed one.
--
-- Nothing refuses it: there is no unique index on (cluster_id, main_index) -
-- only `tables_main_index_check` (>= 1) and the release trigger, which fires at
-- CLOSE, not at BREAK.
--
-- WHAT IT COSTS while the duplicate stands:
--
--   * `fn_cash_clusters_to_tick` picks `main1_table_id` by
--     `main_index = 1 AND lifecycle <> 'closed' ORDER BY created_at LIMIT 1` -
--     a BREAKING table satisfies that. That id is the key of the controller's
--     per-game eligible-horse map, so the OPEN rule can count buyers against a
--     table that refuses every one of them (`TABLE_CLOSING`).
--   * two rows in the lobby with the same name, one of which cannot be joined.
--   * `main_renumbered` churn: 3,407 renumber events in seven days, each one a
--     rename players can see.
--
-- MEASURED: 0 duplicates on the board at audit time, and no `main_renumbered`
-- event in seven days that landed on a concurrently-breaking main's index. So
-- this is a latent hole rather than a live outage - it is filed as P2 and
-- fixed, not left because it has not fired yet.
--
-- THE FIX. In the same transaction that creates the collision, the BREAKING
-- main is moved above the live range. Placed AFTER the demote-to-feeder block
-- so `v_idx` (the live main count) and that block's `v_idx >= 2` test are
-- untouched; a demoted table carries `main_index = NULL` and so cannot collide
-- with the numbers this loop hands out. The breaking table's lifecycle, its
-- seats and the moves already planned off it are not touched - only its number
-- and its name, once.
--
-- Renaming the table that is going away is the right half to move: the players
-- on it have already been told the name of their DESTINATION, not of the table
-- they are leaving.
--
-- ROLLBACK
--   Delete the `breaking_main_released_a_live_index` loop.
--
-- HOW THIS EDITS THE FUNCTION. The live definition is read and patched by one
-- literal replacement anchored on the complete demote block, with landmark
-- assertions on the result. ONE transaction (production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_anchor CONSTANT text := $old$  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;$old$;
  v_repl CONSTANT text := $new$  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;

  -- A BREAKING MAIN KEEPS A NUMBER A SURVIVOR IS RENUMBERED INTO (2026-09-09).
  -- The loop above walks live|opening mains only, so a BREAKING main holds its
  -- old index while the survivors renumber past it. The break candidate is
  -- chosen empty-first, so an empty Main 2 is taken ahead of a populated
  -- feeder and Main 3 is renumbered to 2 in the same pass: two tables carrying
  -- main_index 2, both named "... Main 2", until the break completes and
  -- fn_closed_cluster_main_releases_index nulls the closed one. Nothing
  -- refuses the duplicate - there is no unique index on
  -- (cluster_id, main_index) - and fn_cash_clusters_to_tick reads
  -- `main_index = 1 AND lifecycle <> 'closed'`, which a breaking table
  -- satisfies, so the controller's eligible-horse map can be keyed on a table
  -- that refuses every player it is sent.
  --
  -- So the breaking one moves above the live range, here, in the transaction
  -- that created the collision. After the demote block on purpose: v_idx is
  -- the live main count and a demoted table's main_index is NULL, so these
  -- numbers can collide with nothing. Seats, lifecycle and planned moves are
  -- untouched.
  FOR t IN SELECT * FROM unnest(v_census) c
            WHERE c.breaking AND c.role = 'main'
              AND c.main_index IS NOT NULL AND c.main_index <= v_idx
            ORDER BY c.main_index
  LOOP
    v_idx := v_idx + 1;
    UPDATE public.tables SET main_index = v_idx, name = left(g.name, 50) || ' Main ' || v_idx
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, t.id, 'main_renumbered',
            jsonb_build_object('from', t.main_index, 'to', v_idx,
                               'reason', 'breaking_main_released_a_live_index'));
    v_actions := v_actions || jsonb_build_object('breaking_main_renumbered', t.id);
  END LOOP;$new$;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position('breaking_main_released_a_live_index' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION
      'the demote-to-feeder block is not in the live definition in the shape this migration expects';
  END IF;

  v_new := replace(v_src, v_anchor, v_repl);

  IF position('breaking_main_released_a_live_index' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  IF position('main_demoted_to_feeder' in v_new) = 0
     OR position('fn_platform_frozen' in v_new) = 0
     OR position('feeder_promoted_to_main' in v_new) = 0
     OR position('main1_reopened' in v_new) = 0
     OR position('table_break_started' in v_new) = 0
     OR position('status_followed_lifecycle' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

DO $assert$
DECLARE v_def text; v_dupes integer;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('breaking_main_released_a_live_index' in v_def) = 0 THEN
    RAISE EXCEPTION 'the breaking-main release is not in the live definition after apply';
  END IF;

  -- Nothing on the board may already be carrying a duplicate index; if one is,
  -- say so rather than leaving it for the next tick to trip over.
  SELECT count(*) INTO v_dupes FROM (
    SELECT cluster_id, main_index FROM public.tables
     WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
       AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false
     GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE WARNING 'ATTENTION: % (cluster, main_index) pairs are duplicated right now; the next tick of each game clears them', v_dupes;
  END IF;
END;
$assert$;

COMMIT;
