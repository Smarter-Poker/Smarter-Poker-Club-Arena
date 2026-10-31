-- Extend the maintained native operator predecessor with its installed guards.
-- Everything else, including global request lock and full action body, is unchanged.
DO $fixture$
DECLARE p regprocedure := 'public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure; d text;
BEGIN
 SELECT pg_get_functiondef(p) INTO d;
 IF md5(d)<>'97c0cf44448f28535894dec862a4586b' THEN RAISE EXCEPTION 'Unexpected maintained operator predecessor'; END IF;
 d:=replace(d,$anchor$  <<act>>
  BEGIN
    IF g.cluster_mode = 'frozen'$anchor$,$guards$  <<act>>
  BEGIN
    IF NOT public.fn_lightning_template_allowed(g.template_name,g.ruleset_snapshot)
       AND (v_action IN ('enable_lightning','resume','enable_joins')
       OR (v_action='set_flag' AND v_args->>'flag'='lightning_v1' AND v_args->>'value'='true')) THEN
      v_answer:=jsonb_build_object('ok',false,'code','LIGHTNING_TEMPLATE_NOT_ALLOWED','reason','LIGHTNING_TEMPLATE_NOT_ALLOWED');
      EXIT act;
    END IF;
    IF NOT public.fn_lightning_table_size_allowed(g.handedness)
       AND (v_action IN ('enable_lightning','resume','enable_joins')
       OR (v_action='set_flag' AND v_args->>'flag'='lightning_v1' AND v_args->>'value'='true')) THEN
      v_answer:=jsonb_build_object('ok',false,'code','LIGHTNING_TABLE_SIZE_NOT_ALLOWED','reason','LIGHTNING_TABLE_SIZE_NOT_ALLOWED');
      EXIT act;
    END IF;
    IF NOT public.fn_lightning_variant_allowed((SELECT cg.variant FROM public.cash_games cg WHERE cg.id=g.id))
       AND (v_action IN ('enable_lightning','resume','enable_joins')
       OR (v_action='set_flag' AND v_args->>'flag'='lightning_v1' AND v_args->>'value'='true')) THEN
      v_answer:=jsonb_build_object('ok',false,'code','LIGHTNING_VARIANT_NOT_ALLOWED','reason','LIGHTNING_VARIANT_NOT_ALLOWED');
      EXIT act;
    END IF;
    IF g.cluster_mode = 'frozen'$guards$);
 EXECUTE d;
 IF md5(pg_get_functiondef(p))<>'e99c43433703d45dac01948de8ef77d8' THEN RAISE EXCEPTION 'Fixture does not equal current production e99'; END IF;
END $fixture$;
REVOKE ALL ON FUNCTION public.fn_lightning_operator_control(uuid,text,text,jsonb) FROM PUBLIC;
ALTER FUNCTION public.fn_lightning_operator_control(uuid,text,text,jsonb) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_lightning_operator_control(uuid,text,text,jsonb) TO authenticated,service_role;
