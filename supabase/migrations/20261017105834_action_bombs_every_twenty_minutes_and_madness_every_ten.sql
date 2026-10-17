-- 20261017105834_action_bombs_every_twenty_minutes_and_madness_every_ten.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- @live-proof: (public.fn_cash_template_defaults('action', 'nlh')->'bombs'->>'trigger') = 'timed_20m' AND (public.fn_cash_template_defaults('madness', 'nlh')->'bombs'->>'trigger') = 'timed_10m' AND position('timed_20m' in pg_get_functiondef('public.fn_cash_apply_ruleset(uuid)'::regprocedure)) > 0
--
-- WHAT THIS CHANGES, AND WHY (Dan 2026-10-16, with screenshots of the lobby):
--   "change it from bomb pot every orbit to every 10 minutes for madness and
--    every 20 minutes for action."
--
-- The cadence is a template promise (fn_cash_template_defaults owns it, and
-- zz_cash_game_floor_from_template rewrites a game's snapshot from it on
-- every write), so the card text and the dealt cadence can only agree if the
-- template itself changes. Before: Action = 'timed_15m' (900 s), Madness =
-- 'every_orbit' (once_per_orbit). After: Action = 'timed_20m' (1200 s),
-- Madness = 'timed_10m' (600 s).
--
-- No engine change: the engine already deals bomb_pot_trigger_mode 'timed'
-- with any bomb_pot_interval_seconds, and re-reads both at hand boundaries
-- (ServerTableEngineBase, "THE TEMPLATED RULES, RE-READ"). A bomb already
-- armed or owed is kept by the scheduler.
--
-- HOW: the four functions that name a trigger token are patched by exact text
-- replacement of the reviewed lines, guarded by the md5 of the definition read
-- from production on 2026-10-17. A changed definition refuses the migration
-- rather than overwriting someone else's work. Every other line, owner, ACL,
-- SECURITY DEFINER and search_path is preserved by CREATE OR REPLACE of the
-- function's own definition. The old tokens ('timed_15m', 'every_orbit') stay
-- valid in the projections so a snapshot that is not rewritten (a retired
-- club's game is read-only) still projects to what it says.
--
-- Then every non-retired Action/Madness game's snapshot is rewritten from the
-- template (a no-op write of ruleset_snapshot fires the template trigger) and
-- projected onto its open tables with fn_cash_apply_ruleset, and the result is
-- asserted: no live Action/Madness game or open table keeps the old cadence.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  v_def text;
  v_new text;

  -- Replace exactly one occurrence of p_old, refusing if it is absent or repeated.
  v_patches jsonb := jsonb_build_array(
    jsonb_build_object(
      'fn', 'public.fn_cash_template_defaults(text,text)',
      'md5', 'f8616b0433f0420032a6233879876c79',
      'edits', jsonb_build_array(
        jsonb_build_array(
          $o$'trigger', CASE v_t WHEN 'action' THEN 'timed_15m' WHEN 'madness' THEN 'every_orbit' ELSE NULL END,$o$,
          $n$'trigger', CASE v_t WHEN 'action' THEN 'timed_20m' WHEN 'madness' THEN 'timed_10m' ELSE NULL END,$n$))),
    jsonb_build_object(
      'fn', 'public.fn_cash_apply_ruleset(uuid)',
      'md5', '1e4075534d1890aeabd55f5b95f1b118',
      'edits', jsonb_build_array(
        jsonb_build_array(
          $o$v_trigger_mode := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'$o$,
          $n$v_trigger_mode := CASE WHEN v_bomb_on AND v_bomb_trigger IN ('timed_10m', 'timed_15m', 'timed_20m') THEN 'timed'$n$),
        jsonb_build_array(
          $o$v_interval := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 900 ELSE NULL END;$o$,
          $n$v_interval := CASE WHEN NOT v_bomb_on THEN NULL
                     WHEN v_bomb_trigger = 'timed_10m' THEN 600
                     WHEN v_bomb_trigger = 'timed_15m' THEN 900
                     WHEN v_bomb_trigger = 'timed_20m' THEN 1200
                     ELSE NULL END;$n$))),
    jsonb_build_object(
      'fn', 'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)',
      'md5', 'a0446fd0b9a46aae6ef93e4632c8e06e',
      'edits', jsonb_build_array(
        jsonb_build_array(
          $o$CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'$o$,
          $n$CASE WHEN v_bomb_on AND v_bomb_trigger IN ('timed_10m', 'timed_15m', 'timed_20m') THEN 'timed'$n$),
        jsonb_build_array(
          $o$CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 900 ELSE NULL END,$o$,
          $n$CASE WHEN NOT v_bomb_on THEN NULL
         WHEN v_bomb_trigger = 'timed_10m' THEN 600
         WHEN v_bomb_trigger = 'timed_15m' THEN 900
         WHEN v_bomb_trigger = 'timed_20m' THEN 1200
         ELSE NULL END,$n$))),
    jsonb_build_object(
      'fn', 'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
      'md5', '0dba5ef9b28b5747159cd4d804e52680',
      'edits', jsonb_build_array(
        jsonb_build_array(
          $o$v_bomb_trigger NOT IN ('timed_15m', 'every_orbit')$o$,
          $n$v_bomb_trigger NOT IN ('timed_10m', 'timed_15m', 'timed_20m', 'every_orbit')$n$)))
  );
  p jsonb; e jsonb; v_oid oid; v_old text; v_rep text;
BEGIN
  FOR p IN SELECT * FROM jsonb_array_elements(v_patches) LOOP
    v_oid := (p->>'fn')::regprocedure;
    v_def := pg_get_functiondef(v_oid);
    IF md5(v_def) <> p->>'md5' THEN
      RAISE EXCEPTION 'CADENCE_PATCH_REFUSED: % changed since review (md5 %, expected %)',
        p->>'fn', md5(v_def), p->>'md5';
    END IF;
    v_new := v_def;
    FOR e IN SELECT * FROM jsonb_array_elements(p->'edits') LOOP
      v_old := e->>0; v_rep := e->>1;
      IF (length(v_new) - length(replace(v_new, v_old, ''))) / length(v_old) <> 1 THEN
        RAISE EXCEPTION 'CADENCE_PATCH_REFUSED: % does not contain exactly one [%]', p->>'fn', v_old;
      END IF;
      v_new := replace(v_new, v_old, v_rep);
    END LOOP;
    EXECUTE v_new;
  END LOOP;

  -- The template now promises the new cadence.
  IF public.fn_cash_template_defaults('action', 'nlh')->'bombs'->>'trigger' <> 'timed_20m'
     OR public.fn_cash_template_defaults('madness', 'plo4')->'bombs'->>'trigger' <> 'timed_10m'
     OR public.fn_cash_template_defaults('classic', 'nlh')->'bombs'->>'enabled' <> 'false' THEN
    RAISE EXCEPTION 'CADENCE_PATCH_REFUSED: template defaults did not take the new cadence';
  END IF;
END
$migration$;

-- Rewrite each live (non-retired) Action/Madness game's snapshot from the
-- template, then project it onto that game's open tables.
DO $apply$
DECLARE
  g record;
  v_games integer := 0;
  v_bad integer;
BEGIN
  FOR g IN
    SELECT cg.id
      FROM public.cash_games cg
      JOIN public.clubs c ON c.id = cg.club_id
     WHERE cg.template_name IN ('action', 'madness')
       AND cg.ruleset_snapshot IS NOT NULL
       AND coalesce(c.lifecycle_status, '') <> 'retired'
     ORDER BY cg.id
  LOOP
    UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot WHERE id = g.id;
    PERFORM public.fn_cash_apply_ruleset(g.id);
    v_games := v_games + 1;
  END LOOP;

  SELECT count(*) INTO v_bad
    FROM public.cash_games cg
    JOIN public.clubs c ON c.id = cg.club_id
   WHERE coalesce(c.lifecycle_status, '') <> 'retired'
     AND cg.ruleset_snapshot IS NOT NULL
     AND ((cg.template_name = 'action'  AND cg.ruleset_snapshot->'bombs'->>'trigger' IS DISTINCT FROM 'timed_20m')
       OR (cg.template_name = 'madness' AND cg.ruleset_snapshot->'bombs'->>'trigger' IS DISTINCT FROM 'timed_10m'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'CADENCE_PATCH_REFUSED: % live Action/Madness snapshots kept the old cadence', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.tables t
    JOIN public.cash_games cg ON cg.id = t.cluster_id
    JOIN public.clubs c ON c.id = cg.club_id
   WHERE coalesce(c.lifecycle_status, '') <> 'retired'
     AND t.lifecycle <> 'closed'
     AND coalesce(t.is_deleted, false) = false
     AND cg.template_name IN ('action', 'madness')
     AND (t.bomb_pot_trigger_mode IS DISTINCT FROM 'timed'
       OR t.bomb_pot_interval_seconds IS DISTINCT FROM
          CASE cg.template_name WHEN 'action' THEN 1200 ELSE 600 END);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'CADENCE_PATCH_REFUSED: % open Action/Madness tables kept the old cadence', v_bad;
  END IF;

  RAISE NOTICE 'cadence applied to % Action/Madness games', v_games;
END
$apply$;

COMMIT;
