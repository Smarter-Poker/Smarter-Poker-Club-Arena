CREATE OR REPLACE FUNCTION public.fn_ca_recovery_fee_cents(p_gross_cents bigint, p_ratio numeric, p_unit_cents integer DEFAULT 1)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_gross_cents IS NULL OR p_gross_cents <= 0 THEN 0
    WHEN p_ratio IS NULL THEN NULL
    WHEN p_ratio <= 0 THEN 0
    ELSE LEAST(
      public.fn_ca_unit_floor_cents(
        trunc(p_gross_cents::numeric * p_ratio + 0.000001)::bigint, p_unit_cents),
      public.fn_ca_unit_floor_cents(
        trunc(p_gross_cents::numeric * 0.1 + 0.000001)::bigint, p_unit_cents))
  END;
$function$
