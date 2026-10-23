CREATE OR REPLACE FUNCTION public.fn_cash_game_max_stake_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(new.enabled, false) and coalesce(new.bb, 0) > 2.00 then
    raise exception using errcode = '22023',
      message = 'Cash games are capped at 1.00/2.00 blinds';
  end if;
  return new;
end
$function$;
