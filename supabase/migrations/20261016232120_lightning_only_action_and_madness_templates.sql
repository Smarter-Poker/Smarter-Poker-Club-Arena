-- Reserved by scripts/new-migration.mjs. Owner 2026-10-16: only Action/Madness.
-- No retagging, activation, funding, settlement or drain changes.
-- @live-proof: public.fn_lightning_template_allowed('action','{"template":"action"}') AND public.fn_lightning_template_allowed('madness','{"template":"madness"}') AND NOT public.fn_lightning_template_allowed('classic','{"template":"classic"}') AND NOT public.fn_lightning_template_allowed(NULL,'{}')
-- @live-proof: (SELECT count(*)=2 AND bool_and(pg_get_userbyid(proowner)='postgres' AND NOT has_function_privilege('anon',oid,'EXECUTE')) FROM pg_proc WHERE oid IN('public.fn_lightning_template_allowed(text,jsonb)'::regprocedure,'public.fn_lightning_hand_template_guard()'::regprocedure))
-- @live-proof: (SELECT convalidated FROM pg_constraint WHERE conrelid='public.cash_games'::regclass AND conname='cash_games_lightning_template_allowed')
-- @live-proof: position('LIGHTNING_TEMPLATE_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure))>0 AND position('LIGHTNING_TEMPLATE_NOT_ALLOWED' in pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure))>0 AND position('lightning_template_not_allowed' in pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure))>0
-- @live-proof: (SELECT count(*)=1 FROM pg_trigger WHERE tgrelid='public.lightning_hand'::regclass AND tgname='lightning_hand_template_guard' AND tgenabled='O' AND NOT tgisinternal)
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';
-- BEGIN TEMPLATE INVARIANTS
CREATE FUNCTION public.fn_lightning_template_allowed(p_template text,p_rules jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$ SELECT coalesce(p_template IN ('action','madness') AND p_rules->>'template'=p_template,false) $fn$;
ALTER FUNCTION public.fn_lightning_template_allowed(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_template_allowed(text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_lightning_template_allowed(text,jsonb) TO authenticated,service_role;
ALTER TABLE public.cash_games ADD CONSTRAINT cash_games_lightning_template_allowed CHECK (
 public.fn_lightning_template_allowed(template_name,ruleset_snapshot)
 OR (NOT coalesce(lightning_enabled,false) AND coalesce(cluster_mode,'must_move') NOT IN ('pending_on','lightning'))
);
-- Shared row lock serializes a template change with formation. Existing hands
-- and their settlement/release remain untouched.
CREATE FUNCTION public.fn_lightning_hand_template_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE v_rules jsonb; v_template text;
BEGIN
 SELECT template_name,ruleset_snapshot INTO v_template,v_rules FROM public.cash_games WHERE id=NEW.cluster_id FOR SHARE;
 IF NOT public.fn_lightning_template_allowed(v_template,v_rules) THEN
  RAISE EXCEPTION 'LIGHTNING_TEMPLATE_NOT_ALLOWED: only Action and Madness may form Lightning hands'
   USING ERRCODE='23514',CONSTRAINT='lightning_hand_template_allowed';
 END IF;
 RETURN NEW;
END $fn$;
ALTER FUNCTION public.fn_lightning_hand_template_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_hand_template_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER lightning_hand_template_guard BEFORE INSERT ON public.lightning_hand
FOR EACH ROW EXECUTE FUNCTION public.fn_lightning_hand_template_guard();
-- END TEMPLATE INVARIANTS
-- Patch only unique anchors in catalog-measured installed predecessors.
DO $patch$
DECLARE v_sig text; v_expected text; v_anchor text; v_add text; v_def text; v_meta jsonb; v_after text;
BEGIN
 FOR v_sig,v_expected,v_anchor,v_add IN SELECT * FROM (VALUES
 ('public.fn_lightning_operator_control(uuid,text,text,jsonb)',
 '97c0cf44448f28535894dec862a4586b', E'  <<act>>\n  BEGIN\n',
 E'    IF NOT public.fn_lightning_template_allowed(g.template_name,g.ruleset_snapshot)\n       AND (v_action IN (''enable_lightning'',''resume'',''enable_joins'')\n       OR (v_action=''set_flag'' AND v_args->>''flag''=''lightning_v1'' AND v_args->>''value''=''true'')) THEN\n      v_answer:=jsonb_build_object(''ok'',false,''code'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'',''reason'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'');\n      EXIT act;\n    END IF;\n'),
 ('public.fn_lightning_rollout_readiness(uuid)',
 '8fc9b9db3f7b773581c4752e3d90b00d', E'  v_row := public.fn_lightning_operator_cluster_row(g.id, v_now);\n',
 E'  IF NOT public.fn_lightning_template_allowed((SELECT cg.template_name FROM public.cash_games cg WHERE cg.id=g.id),(SELECT cg.ruleset_snapshot FROM public.cash_games cg WHERE cg.id=g.id)) THEN\n    v_reasons:=v_reasons||jsonb_build_object(''code'',''LIGHTNING_TEMPLATE_NOT_ALLOWED'',''severity'',''blocking'',''detail'',''Only Action and Madness support Lightning'');\n  END IF;\n'),
 ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)',
 '2879e777f5fd0f355e1049a67b5dab41', E'  v_epoch := g.cluster_epoch;\n',
 E'  IF NOT public.fn_lightning_template_allowed((SELECT cg.template_name FROM public.cash_games cg WHERE cg.id=g.id),(SELECT cg.ruleset_snapshot FROM public.cash_games cg WHERE cg.id=g.id)) THEN\n    RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',false,''reason'',''lightning_template_not_allowed'');\n  END IF;\n')
 ) p(sig,expected,anchor,addition)
 LOOP
  SELECT jsonb_build_array(proowner,proacl::text,prosecdef,proconfig,provolatile,prorettype,proargtypes::text) INTO v_meta FROM pg_proc WHERE oid=v_sig::regprocedure;
  v_def:=pg_get_functiondef(v_sig::regprocedure);
  IF md5(v_def) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Lightning template predecessor changed: % (%)',v_sig,md5(v_def); END IF;
  IF (length(v_def)-length(replace(v_def,v_anchor,'')))<>length(v_anchor) THEN RAISE EXCEPTION 'Lightning template anchor not unique: %',v_sig; END IF;
  IF v_sig LIKE '%operator_control%' THEN EXECUTE replace(v_def,v_anchor,v_anchor||v_add);
  ELSE EXECUTE replace(v_def,v_anchor,v_add||v_anchor); END IF;
  v_after:=pg_get_functiondef(v_sig::regprocedure);
  IF v_after IS DISTINCT FROM (CASE WHEN v_sig LIKE '%operator_control%' THEN replace(v_def,v_anchor,v_anchor||v_add) ELSE replace(v_def,v_anchor,v_add||v_anchor) END)
    OR v_meta IS DISTINCT FROM (SELECT jsonb_build_array(proowner,proacl::text,prosecdef,proconfig,provolatile,prorettype,proargtypes::text) FROM pg_proc WHERE oid=v_sig::regprocedure) THEN
    RAISE EXCEPTION 'Lightning template postimage/security changed: %',v_sig;
  END IF;
 END LOOP;
END $patch$;
COMMIT;
