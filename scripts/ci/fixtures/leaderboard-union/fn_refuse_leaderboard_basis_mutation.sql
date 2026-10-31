CREATE OR REPLACE FUNCTION public.fn_refuse_leaderboard_basis_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_BASIS_IMMUTABLE';
END;
$function$
