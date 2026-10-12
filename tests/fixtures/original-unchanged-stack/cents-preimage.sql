CREATE OR REPLACE FUNCTION public.fn_pnl_evidence_cents(p_value jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v numeric;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
 v := (p_value#>>'{}')::numeric;
 IF v::text IN ('NaN','Infinity','-Infinity') OR v<>round(v,2) THEN RETURN NULL; END IF;
 RETURN v;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END $function$
