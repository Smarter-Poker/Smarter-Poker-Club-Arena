-- 20261026015255_lightning_never_runs_short_deck_omaha_hi_lo_or_pineapple.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- OWNER RULINGS, 2026-10-25 16:55 Central, verbatim:
--   "SHORT DESK AND OMAHA HI LOW SHOULD NOT BE RUNNING LIGHTNING AT THIS POINT,
--    JUST FEEDER GAMES."
--   "AND PINNEAPPLE AS WELL, SHOULD ONLY BE FEEDER GAME, NOT LIGHTNING"
-- Approved for production at 17:22 Central: "Approved: install the rule on
-- production that Short Deck, Omaha Hi-Lo and Pineapple never run Lightning,
-- and rename the four drained games."
--
-- WHAT ALREADY HAPPENED (not in this file): at 21:57-21:58 UTC the four live
-- Lightning games of these variants were drained through the operator door
-- (fn_lightning_operator_control 'drain', request ids
-- 4a1f0c2e-8d1b-4f6e-9a77-20261025165{1,2,3,4}). Every drain completed in
-- under 80 s; all 56 pool sessions closed onto their anchor seats; every chip
-- is accounted for by a seat cash-out receipt or a must-move seat move. The
-- four games read must_move, lightning_enabled false, enabled true.
--
-- WHAT THIS CHANGES, mirroring the six-seat rule (20261020005222) door for door:
--   1. fn_lightning_variant_allowed(variant): false for short_deck, flo8, plo8,
--      pineapple (and their spellings shortdeck, omaha8, o8, pineapple_holdem)
--      and for a missing variant.
--   2. cash_games_lightning_variant_allowed: such a game exists in every
--      ordinary state; only Lightning (lightning_enabled, pending_on,
--      lightning) is refused. Read before writing: no row violates it.
--   3. Every Lightning door refuses them by name, LIGHTNING_VARIANT_NOT_ALLOWED:
--      the operator door (enable_lightning, resume, enable_joins, lightning_v1
--      on), rollout readiness, hand formation, the hand guard trigger, and the
--      thresholds reader (lightning_allowed false).
--   4. fn_cash_game_create refuses an Action/Madness/Lightning request for
--      these variants by name before anything is written; a Classic request
--      is unchanged, so they are still created as ordinary feeder games.
--      fn_cash_template_defaults is deliberately NOT changed: the floor
--      trigger calls it on every write to cash_games, and a raise there would
--      break every write to the four existing Madness/Action games.
--   5. The four drained games stop saying "Lightning Games": each is named
--      for its own template (VARIANT sb/bb Madness or Action), and their open
--      tables follow the same projection 20261023230807 uses. They keep
--      running as must-move feeder games; no seat, stack or wallet is touched.
-- Horses and humans are not distinguished anywhere here.
--
-- @live-proof: NOT public.fn_lightning_variant_allowed('short_deck') AND NOT public.fn_lightning_variant_allowed('flo8') AND NOT public.fn_lightning_variant_allowed('plo8') AND NOT public.fn_lightning_variant_allowed('pineapple') AND NOT public.fn_lightning_variant_allowed(NULL) AND public.fn_lightning_variant_allowed('nlh') AND public.fn_lightning_variant_allowed('plo5') AND public.fn_lightning_variant_allowed('flh')
-- @live-proof: (SELECT convalidated FROM pg_constraint WHERE conrelid='public.cash_games'::regclass AND conname='cash_games_lightning_variant_allowed')
-- @live-proof: position('LIGHTNING_VARIANT_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure))>0 AND position('LIGHTNING_VARIANT_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure))>0 AND position('lightning_variant_not_allowed' in pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure))>0
-- @live-proof: position('LIGHTNING_VARIANT_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_hand_template_guard()'::regprocedure))>0 AND position('LIGHTNING_VARIANT_NOT_ALLOWED' in pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds(uuid)'::regprocedure))>0 AND position('LIGHTNING_VARIANT_NOT_ALLOWED' in pg_get_functiondef('public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure))>0
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.cash_games WHERE NOT public.fn_lightning_variant_allowed(variant) AND (coalesce(lightning_enabled,false) OR cluster_mode IN ('pending_on','lightning')))
-- @live-proof: (SELECT count(*) = 4 FROM public.cash_games WHERE id IN ('0bc9bdf3-7fa6-43ed-855a-9be01b5a6073','1db812e6-159c-4fc0-9a0f-fa715210f4d1','59a58b1c-6881-416f-a122-4804db63b6dc','a80b38df-58ab-4192-b960-ddadc4ecd382') AND name NOT LIKE '%Lightning%' AND enabled AND NOT lightning_enabled AND cluster_mode = 'must_move')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

-- BEGIN VARIANT INVARIANTS
CREATE FUNCTION public.fn_lightning_variant_allowed(p_variant text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$ SELECT coalesce(lower(p_variant) NOT IN
  ('short_deck','shortdeck','flo8','plo8','omaha8','o8','pineapple','pineapple_holdem'), false) $fn$;
ALTER FUNCTION public.fn_lightning_variant_allowed(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_variant_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_variant_allowed(text) TO authenticated, service_role;

-- The same shape as cash_games_lightning_six_seat_only: such a game may exist
-- in every ordinary state, and only Lightning is refused.
ALTER TABLE public.cash_games ADD CONSTRAINT cash_games_lightning_variant_allowed CHECK (
  public.fn_lightning_variant_allowed(variant)
  OR (NOT coalesce(lightning_enabled, false) AND coalesce(cluster_mode, 'must_move') NOT IN ('pending_on', 'lightning'))
);
-- END VARIANT INVARIANTS

-- Patch only unique anchors in the catalog-measured installed images
-- (each one the postimage of 20261020005222 or a later installed image).
DO $patch$
DECLARE
  v_sig text; v_expected text; v_anchors text[]; v_news text[];
  v_def text; v_new text; v_meta jsonb; v_after text; i integer;
BEGIN
  FOR v_sig, v_expected, v_anchors, v_news IN SELECT * FROM (VALUES
  ('public.fn_lightning_operator_control(uuid,text,text,jsonb)',
   '27b33d9e639494132f0ba259aebbd52b',
   ARRAY[E'      v_answer:=jsonb_build_object(''ok'',false,''code'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'',''reason'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'');\n      EXIT act;\n    END IF;\n'],
   ARRAY[E'      v_answer:=jsonb_build_object(''ok'',false,''code'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'',''reason'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'');\n      EXIT act;\n    END IF;\n    IF NOT public.fn_lightning_variant_allowed((SELECT cg.variant FROM public.cash_games cg WHERE cg.id=g.id))\n       AND (v_action IN (''enable_lightning'',''resume'',''enable_joins'')\n       OR (v_action=''set_flag'' AND v_args->>''flag''=''lightning_v1'' AND v_args->>''value''=''true'')) THEN\n      v_answer:=jsonb_build_object(''ok'',false,''code'',''LIGHTNING_VARIANT_NOT_ALLOWED'',''reason'',''LIGHTNING_VARIANT_NOT_ALLOWED'');\n      EXIT act;\n    END IF;\n']),
  ('public.fn_lightning_rollout_readiness(uuid)',
   '641cd87a7f5c1ca0328d058f311b4c5c',
   ARRAY[E'    v_reasons:=v_reasons||jsonb_build_object(''code'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'',''severity'',''blocking'',''detail'',''Only six-seat games support Lightning'');\n  END IF;\n'],
   ARRAY[E'    v_reasons:=v_reasons||jsonb_build_object(''code'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'',''severity'',''blocking'',''detail'',''Only six-seat games support Lightning'');\n  END IF;\n  IF NOT public.fn_lightning_variant_allowed((SELECT cg.variant FROM public.cash_games cg WHERE cg.id=g.id)) THEN\n    v_reasons:=v_reasons||jsonb_build_object(''code'',''LIGHTNING_VARIANT_NOT_ALLOWED'',''severity'',''blocking'',''detail'',''Short Deck, Omaha Hi-Lo and Pineapple run as feeder games, not Lightning'');\n  END IF;\n']),
  ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)',
   '58becd904e14a3c94cc422372b489373',
   ARRAY[E'    RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',false,''reason'',''lightning_table_size_not_allowed'');\n  END IF;\n'],
   ARRAY[E'    RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',false,''reason'',''lightning_table_size_not_allowed'');\n  END IF;\n  IF NOT public.fn_lightning_variant_allowed((SELECT cg.variant FROM public.cash_games cg WHERE cg.id=g.id)) THEN\n    RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',false,''reason'',''lightning_variant_not_allowed'');\n  END IF;\n']),
  ('public.fn_lightning_hand_template_guard()',
   'e2fd0ecac0748c0f9563eecc4108e9a9',
   ARRAY[E'DECLARE v_rules jsonb; v_template text; v_handedness integer;\n',
         E' SELECT template_name,ruleset_snapshot,handedness INTO v_template,v_rules,v_handedness FROM public.cash_games WHERE id=NEW.cluster_id FOR SHARE;\n',
         E'  RAISE EXCEPTION ''LIGHTNING_TABLE_SIZE_NOT_ALLOWED: only six-seat games may form Lightning hands''\n   USING ERRCODE=''23514'',CONSTRAINT=''lightning_hand_table_size_allowed'';\n END IF;\n'],
   ARRAY[E'DECLARE v_rules jsonb; v_template text; v_handedness integer; v_variant text;\n',
         E' SELECT template_name,ruleset_snapshot,handedness,variant INTO v_template,v_rules,v_handedness,v_variant FROM public.cash_games WHERE id=NEW.cluster_id FOR SHARE;\n',
         E'  RAISE EXCEPTION ''LIGHTNING_TABLE_SIZE_NOT_ALLOWED: only six-seat games may form Lightning hands''\n   USING ERRCODE=''23514'',CONSTRAINT=''lightning_hand_table_size_allowed'';\n END IF;\n IF NOT public.fn_lightning_variant_allowed(v_variant) THEN\n  RAISE EXCEPTION ''LIGHTNING_VARIANT_NOT_ALLOWED: Short Deck, Omaha Hi-Lo and Pineapple never form Lightning hands''\n   USING ERRCODE=''23514'',CONSTRAINT=''lightning_hand_variant_allowed'';\n END IF;\n']),
  ('public.fn_cash_cluster_lightning_thresholds(uuid)',
   '23bf6043e45ef4f357f22aeb3672ad3c',
   ARRAY[E'  SELECT id, handedness, ruleset_snapshot INTO g FROM public.cash_games WHERE id = p_game_id;\n',
         E'              ''lightning_allowed'', public.fn_lightning_table_size_allowed(g.handedness))\n         || CASE WHEN public.fn_lightning_table_size_allowed(g.handedness) THEN ''{}''::jsonb\n                 ELSE jsonb_build_object(''reason'', ''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'') END;\n'],
   ARRAY[E'  SELECT id, handedness, ruleset_snapshot, variant INTO g FROM public.cash_games WHERE id = p_game_id;\n',
         E'              ''lightning_allowed'', public.fn_lightning_table_size_allowed(g.handedness)\n                                     AND public.fn_lightning_variant_allowed(g.variant))\n         || CASE WHEN NOT public.fn_lightning_table_size_allowed(g.handedness)\n                 THEN jsonb_build_object(''reason'', ''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'')\n                 WHEN NOT public.fn_lightning_variant_allowed(g.variant)\n                 THEN jsonb_build_object(''reason'', ''LIGHTNING_VARIANT_NOT_ALLOWED'')\n                 ELSE ''{}''::jsonb END;\n']),
  ('public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
   '670f025df2141f915f5107a7ae152952',
   ARRAY[E'  RETURN public.fn_cash_game_create_impl_20260905(\n'],
   ARRAY[E'  -- LIGHTNING VARIANTS (Dan 2026-10-25): Short Deck, Omaha Hi-Lo and\n  -- Pineapple run only as ordinary feeder games, never as Lightning.\n  IF lower(coalesce(p_template, '''')) IN (''action'',''madness'',''lightning'')\n     AND NOT public.fn_lightning_variant_allowed(p_variant) THEN\n    RAISE EXCEPTION ''LIGHTNING_VARIANT_NOT_ALLOWED: Short Deck, Omaha Hi-Lo And Pineapple Run As Classic Games''\n      USING ERRCODE = ''23514'', HINT = ''lightning_variant_not_allowed'';\n  END IF;\n\n  RETURN public.fn_cash_game_create_impl_20260905(\n'])
  ) p(sig, expected, anchors, news)
  LOOP
    SELECT jsonb_build_array(proowner, proacl::text, prosecdef, proconfig, provolatile, prorettype, proargtypes::text)
      INTO v_meta FROM pg_proc WHERE oid = v_sig::regprocedure;
    v_def := pg_get_functiondef(v_sig::regprocedure);
    IF md5(v_def) IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Lightning variant predecessor changed: % (%)', v_sig, md5(v_def);
    END IF;
    v_new := v_def;
    FOR i IN 1 .. cardinality(v_anchors) LOOP
      IF (length(v_new) - length(replace(v_new, v_anchors[i], ''))) <> length(v_anchors[i]) THEN
        RAISE EXCEPTION 'Lightning variant anchor % not unique: %', i, v_sig;
      END IF;
      v_new := replace(v_new, v_anchors[i], v_news[i]);
    END LOOP;
    EXECUTE v_new;
    v_after := pg_get_functiondef(v_sig::regprocedure);
    IF v_after IS DISTINCT FROM v_new
       OR v_meta IS DISTINCT FROM (SELECT jsonb_build_array(proowner, proacl::text, prosecdef, proconfig, provolatile, prorettype, proargtypes::text)
                                     FROM pg_proc WHERE oid = v_sig::regprocedure) THEN
      RAISE EXCEPTION 'Lightning variant postimage/security changed: %', v_sig;
    END IF;
  END LOOP;
END $patch$;

-- The four drained games are named for their own template, and their open
-- tables follow the same projection 20261023230807 uses. Nothing else moves.
DO $rename$
DECLARE
  c_games constant uuid[] := ARRAY[
    '0bc9bdf3-7fa6-43ed-855a-9be01b5a6073', -- FLO8 0.25/0.50 (madness)
    '1db812e6-159c-4fc0-9a0f-fa715210f4d1', -- PLO8 0.25/0.50 (action)
    '59a58b1c-6881-416f-a122-4804db63b6dc', -- SHORT_DECK 0.25/0.50 (madness)
    'a80b38df-58ab-4192-b960-ddadc4ecd382'  -- SHORT_DECK 0.50/1.00 (madness)
  ]::uuid[];
  v_me xid := pg_current_xact_id()::xid;
  v_n integer;
  r record;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE g.id = ANY (c_games) AND g.closed_at IS NULL AND g.enabled
     AND NOT coalesce(g.lightning_enabled, false) AND g.cluster_mode = 'must_move'
     AND g.template_name IN ('action', 'madness') AND g.name LIKE '% Lightning Games'
     AND NOT public.fn_lightning_variant_allowed(g.variant);
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'expected the four drained Lightning games as must-move feeder games, found %', v_n;
  END IF;

  FOR r IN SELECT g.id, upper(g.variant) || ' ' || g.sb::text || '/' || g.bb::text || ' '
                  || CASE g.template_name WHEN 'action' THEN 'Action' ELSE 'Madness' END AS name
             FROM public.cash_games g WHERE g.id = ANY (c_games) ORDER BY g.id LOOP
    UPDATE public.cash_games SET name = r.name, updated_at = now() WHERE id = r.id;
    UPDATE public.tables t SET name = CASE
        WHEN t.role = 'main' AND coalesce(t.main_index, 1) > 1 THEN left(r.name, 50) || ' Main ' || t.main_index
        WHEN t.role = 'feeder' THEN left(r.name, 50) || ' Feeder'
        ELSE r.name END, updated_at = now()
     WHERE t.cluster_id = r.id AND t.lifecycle <> 'closed' AND NOT coalesce(t.is_deleted, false);
  END LOOP;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  SELECT g.id, 'game_renamed_by_owner_instruction',
         jsonb_build_object('migration', '20261026015255', 'name', g.name,
           'owner_words', 'SHORT DESK AND OMAHA HI LOW SHOULD NOT BE RUNNING LIGHTNING AT THIS POINT, JUST FEEDER GAMES. / AND PINNEAPPLE AS WELL, SHOULD ONLY BE FEEDER GAME, NOT LIGHTNING')
    FROM public.cash_games g WHERE g.id = ANY (c_games);

  -- ONLY THESE FOUR GAMES AND THEIR TABLES, AND NO MONEY OR SEAT.
  IF EXISTS (SELECT 1 FROM public.cash_games WHERE xmin = v_me AND NOT (id = ANY (c_games))) THEN
    RAISE EXCEPTION 'a game outside the four drained games changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables WHERE xmin = v_me AND NOT (cluster_id = ANY (c_games))) THEN
    RAISE EXCEPTION 'a table outside the four drained games changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.clubs WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.table_seats WHERE left_at IS NULL AND xmin = v_me) THEN
    RAISE EXCEPTION 'the rename wrote a wallet, treasury or seat row';
  END IF;
END $rename$;

COMMIT;
