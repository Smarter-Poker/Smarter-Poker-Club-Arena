CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_prior_path text := COALESCE(
    current_setting('app.money_path',true),'');
  v_result jsonb;
BEGIN
  PERFORM set_config(
    'app.money_path','fn_settle_satellite_tournament',true);
  BEGIN
    v_result :=
      public.fn_settle_satellite_tournament_pre_money_path_gate(
        p_tournament_id,p_observed_winner_id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.money_path',v_prior_path,true);
    RAISE;
  END;
  PERFORM set_config('app.money_path',v_prior_path,true);
  RETURN v_result;
END;
$function$
