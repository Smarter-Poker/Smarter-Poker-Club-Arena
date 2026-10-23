-- 20261023160959_cash_game_stake_cap_allows_one_two_for_every_variant.sql
--
-- RECORDED AFTER THE FACT. Another session applied this to production at
-- 16:10 UTC on 2026-10-23 (it is in supabase_migrations.schema_migrations under
-- this version and name) and re-enabled the four NLH $1/$2 cash games, but no
-- file reached the repo. This is the live definition, read back with
-- pg_get_functiondef, so the repo matches the database.
--
-- Dan 2026-10-23: "NO GAMES HIGHER THEN .50-1.00 MOVING FORWARD", then "YOU CAN
-- OPEN BACK UP 1-2 PLO", then (12:32 Chicago) "KEEP 1-2 FOR ALL". The cap is
-- $1/$2 for every variant: an enabled cash game may not carry a big blind
-- above 2.00. The trigger itself (trg_cash_game_max_stake_guard, BEFORE INSERT
-- OR UPDATE OF enabled, bb, variant ON cash_games) comes from 20261023072007
-- and is unchanged.

BEGIN;

create or replace function public.fn_cash_game_max_stake_guard()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if coalesce(new.enabled, false) and coalesce(new.bb, 0) > 2.00 then
    raise exception using errcode = '22023',
      message = 'Cash games are capped at 1.00/2.00 blinds';
  end if;
  return new;
end
$function$;

COMMIT;
