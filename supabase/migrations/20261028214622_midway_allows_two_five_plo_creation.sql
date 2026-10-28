-- Owner October 28: enable Midway Union 2/5 PLO for CHEDDERS GAME.
-- Preserve the October 23 cap everywhere else. No existing game is reopened,
-- no wallet/roster changed, and creation still uses the authorized atomic RPC.
-- Function-only replacement: no hot-table DDL or engine activation required.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cash_game_max_stake_guard()'::regprocedure))
     <> '868b3f5b90d5266cf8cf68d20105345c' THEN
    RAISE EXCEPTION 'Cash stake guard changed; inspect before installation';
  END IF;
END
$preimage$;
CREATE OR REPLACE FUNCTION public.fn_cash_game_max_stake_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(new.enabled, false) and coalesce(new.bb, 0) > 2.00 then
    -- The requested exception is this exact stake, this union host and PLO.
    if new.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
       and new.variant in ('plo4', 'plo5', 'plo6')
       and new.sb = 2.00 and new.bb = 5.00 then
      return new;
    end if;
    raise exception using errcode = '22023',
      message = 'Cash games are capped at 1.00/2.00 blinds, except Midway Union 2.00/5.00 PLO';
  end if;
  return new;
end
$function$;
-- @live-proof: position('new.sb = 2.00 and new.bb = 5.00' in pg_get_functiondef('public.fn_cash_game_max_stake_guard()'::regprocedure)) > 0
COMMIT;
