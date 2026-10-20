-- Reserved by scripts/new-migration.mjs. Owner ruling, 2026-10-19 19:44 Central:
-- "classic games never get lightning games, only action and madness, make all
-- lightning games 6 handed." The first half is 20261016232120. This is the
-- second: Lightning exists only on a six-seat (handedness 6) Action or Madness
-- game. A game of any other size keeps ordinary entry and lobby actions and is
-- never enabled, converted, formed or counted as Lightning. Horses and humans
-- are not distinguished anywhere here.
-- Read before writing (2026-10-20 00:45 UTC): no cash_games row outside
-- handedness 6 has lightning_enabled or a pending_on/lightning mode, so the new
-- constraint validates without touching any row. No retagging, activation,
-- funding, settlement, seat or drain change.
-- @live-proof: public.fn_lightning_table_size_allowed(6) AND NOT public.fn_lightning_table_size_allowed(9) AND NOT public.fn_lightning_table_size_allowed(5) AND NOT public.fn_lightning_table_size_allowed(NULL)
-- @live-proof: (SELECT pg_get_userbyid(proowner)='postgres' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE') FROM pg_proc WHERE oid='public.fn_lightning_table_size_allowed(integer)'::regprocedure)
-- @live-proof: (SELECT convalidated FROM pg_constraint WHERE conrelid='public.cash_games'::regclass AND conname='cash_games_lightning_six_seat_only')
-- @live-proof: position('LIGHTNING_TABLE_SIZE_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure))>0 AND position('LIGHTNING_TABLE_SIZE_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure))>0 AND position('lightning_table_size_not_allowed' in pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure))>0
-- @live-proof: position('LIGHTNING_TABLE_SIZE_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_hand_template_guard()'::regprocedure))>0 AND position('LIGHTNING_TABLE_SIZE_NOT_ALLOWED' in pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds(uuid)'::regprocedure))>0
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness IS DISTINCT FROM 6 AND (coalesce(lightning_enabled,false) OR cluster_mode IN ('pending_on','lightning')))
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';
-- BEGIN TABLE SIZE INVARIANTS
CREATE FUNCTION public.fn_lightning_table_size_allowed(p_handedness integer)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$ SELECT coalesce(p_handedness = 6, false) $fn$;
ALTER FUNCTION public.fn_lightning_table_size_allowed(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_table_size_allowed(integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_table_size_allowed(integer) TO authenticated,service_role;
-- The same shape as cash_games_lightning_template_allowed: a game that is not
-- six-seat may exist in every ordinary state, and only Lightning is refused.
-- It also refuses changing an active Lightning game's size away from six.
ALTER TABLE public.cash_games ADD CONSTRAINT cash_games_lightning_six_seat_only CHECK (
 public.fn_lightning_table_size_allowed(handedness)
 OR (NOT coalesce(lightning_enabled,false) AND coalesce(cluster_mode,'must_move') NOT IN ('pending_on','lightning'))
);
-- END TABLE SIZE INVARIANTS
-- Patch only unique anchors in catalog-measured installed images (the
-- postimages of 20261016232120 and the installed thresholds wrapper).
DO $patch$
DECLARE
 v_sig text; v_expected text; v_anchors text[]; v_news text[];
 v_def text; v_new text; v_meta jsonb; v_after text; i integer;
BEGIN
 FOR v_sig,v_expected,v_anchors,v_news IN SELECT * FROM (VALUES
 ('public.fn_lightning_operator_control(uuid,text,text,jsonb)',
  '813e24dd762cc05e40cd3f314f98b5dc',
  ARRAY[E'      v_answer:=jsonb_build_object(''ok'',false,''code'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'',''reason'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'');\n      EXIT act;\n    END IF;\n'],
  ARRAY[E'      v_answer:=jsonb_build_object(''ok'',false,''code'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'',''reason'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'');\n      EXIT act;\n    END IF;\n    IF NOT public.fn_lightning_table_size_allowed(g.handedness)\n       AND (v_action IN (''enable_lightning'',''resume'',''enable_joins'')\n       OR (v_action=''set_flag'' AND v_args->>''flag''=''lightning_v1'' AND v_args->>''value''=''true'')) THEN\n      v_answer:=jsonb_build_object(''ok'',false,''code'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'',''reason'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'');\n      EXIT act;\n    END IF;\n']),
 ('public.fn_lightning_rollout_readiness(uuid)',
  'eeec07e85e652927425c00dc6ccbb50a',
  ARRAY[E'    v_reasons:=v_reasons||jsonb_build_object(''code'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'',''severity'',''blocking'',''detail'',''Only Action and Madness support Lightning'');\n  END IF;\n'],
  ARRAY[E'    v_reasons:=v_reasons||jsonb_build_object(''code'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'',''severity'',''blocking'',''detail'',''Only Action and Madness support Lightning'');\n  END IF;\n  IF NOT public.fn_lightning_table_size_allowed((SELECT cg.handedness FROM public.cash_games cg WHERE cg.id=g.id)) THEN\n    v_reasons:=v_reasons||jsonb_build_object(''code'',''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'',''severity'',''blocking'',''detail'',''Only six-seat games support Lightning'');\n  END IF;\n']),
 ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)',
  '54e82f4fc1242910db9445ef9e726985',
  ARRAY[E'    RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',false,''reason'',''lightning_template_not_allowed'');\n  END IF;\n'],
  ARRAY[E'    RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',false,''reason'',''lightning_template_not_allowed'');\n  END IF;\n  IF NOT public.fn_lightning_table_size_allowed((SELECT cg.handedness FROM public.cash_games cg WHERE cg.id=g.id)) THEN\n    RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',false,''reason'',''lightning_table_size_not_allowed'');\n  END IF;\n']),
 ('public.fn_lightning_hand_template_guard()',
  'a5ea48ba97c0d876c6eb11d524d52964',
  ARRAY[E'DECLARE v_rules jsonb; v_template text;\n',
        E' SELECT template_name,ruleset_snapshot INTO v_template,v_rules FROM public.cash_games WHERE id=NEW.cluster_id FOR SHARE;\n',
        E' END IF;\n RETURN NEW;\n'],
  ARRAY[E'DECLARE v_rules jsonb; v_template text; v_handedness integer;\n',
        E' SELECT template_name,ruleset_snapshot,handedness INTO v_template,v_rules,v_handedness FROM public.cash_games WHERE id=NEW.cluster_id FOR SHARE;\n',
        E' END IF;\n IF NOT public.fn_lightning_table_size_allowed(v_handedness) THEN\n  RAISE EXCEPTION ''LIGHTNING_TABLE_SIZE_NOT_ALLOWED: only six-seat games may form Lightning hands''\n   USING ERRCODE=''23514'',CONSTRAINT=''lightning_hand_table_size_allowed'';\n END IF;\n RETURN NEW;\n']),
 ('public.fn_cash_cluster_lightning_thresholds(uuid)',
  '7d15c333256cd99733d275e7794962f4',
  ARRAY[E'         || jsonb_build_object(''game_id'', g.id);\n'],
  ARRAY[E'         || jsonb_build_object(''game_id'', g.id,\n              ''lightning_allowed'', public.fn_lightning_table_size_allowed(g.handedness))\n         || CASE WHEN public.fn_lightning_table_size_allowed(g.handedness) THEN ''{}''::jsonb\n                 ELSE jsonb_build_object(''reason'', ''LIGHTNING_TABLE_SIZE_NOT_ALLOWED'') END;\n'])
 ) p(sig,expected,anchors,news)
 LOOP
  SELECT jsonb_build_array(proowner,proacl::text,prosecdef,proconfig,provolatile,prorettype,proargtypes::text) INTO v_meta FROM pg_proc WHERE oid=v_sig::regprocedure;
  v_def:=pg_get_functiondef(v_sig::regprocedure);
  IF md5(v_def) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Lightning table size predecessor changed: % (%)',v_sig,md5(v_def); END IF;
  v_new:=v_def;
  FOR i IN 1..cardinality(v_anchors) LOOP
   IF (length(v_new)-length(replace(v_new,v_anchors[i],'')))<>length(v_anchors[i]) THEN
    RAISE EXCEPTION 'Lightning table size anchor % not unique: %',i,v_sig;
   END IF;
   v_new:=replace(v_new,v_anchors[i],v_news[i]);
  END LOOP;
  EXECUTE v_new;
  v_after:=pg_get_functiondef(v_sig::regprocedure);
  IF v_after IS DISTINCT FROM v_new
    OR v_meta IS DISTINCT FROM (SELECT jsonb_build_array(proowner,proacl::text,prosecdef,proconfig,provolatile,prorettype,proargtypes::text) FROM pg_proc WHERE oid=v_sig::regprocedure) THEN
    RAISE EXCEPTION 'Lightning table size postimage/security changed: %',v_sig;
  END IF;
 END LOOP;
END $patch$;
COMMIT;
