CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text DEFAULT 'all'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_units text;
  v_value numeric;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'diamond_economics_unset:<null>/%', COALESCE(p_scope,'<null>')
      USING ERRCODE = 'PDE01';
  END IF;
  v_units := public.fn_ca_diamond_economics_units_of(p_name);
  IF v_units IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unknown_name:%', p_name USING ERRCODE = 'PDE02';
  END IF;
  IF v_units IN ('boolean','account','choice','role','hand','game_list','shares','period') THEN
    RAISE EXCEPTION 'diamond_economics_not_a_number:% (units %, read it with fn_ca_diamond_economic_text)',
      p_name, v_units USING ERRCODE = 'PDE02';
  END IF;
  -- No fallback: the scope asked for is the scope read.
  SELECT e.value INTO v_value
    FROM public.ca_diamond_economics e
   WHERE e.name = p_name AND e.scope = COALESCE(p_scope,'all')
   ORDER BY e.recorded_at DESC, e.id DESC
   LIMIT 1;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unset:%/%', p_name, COALESCE(p_scope,'all')
      USING ERRCODE = 'PDE01';
  END IF;
  RETURN v_value;
END $function$

