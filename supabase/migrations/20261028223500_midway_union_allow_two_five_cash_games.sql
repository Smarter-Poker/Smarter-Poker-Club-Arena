BEGIN;
-- Owner direction 2026-10-28: remove cash game stake cap on Midway Union, allow up to 2/5 elsewhere
CREATE OR REPLACE FUNCTION public.fn_cash_game_max_stake_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_union uuid;
begin
  -- Midway Union is unrestricted on cash stakes (owner order 2026-10-28)
  if coalesce(new.union_id, '00000000-0000-0000-0000-000000000000'::uuid) = 'fade0000-0000-0000-0000-000000000001'::uuid
     or coalesce(new.club_id, '00000000-0000-0000-0000-000000000000'::uuid) = 'fade0000-0000-0000-0000-000000000001'::uuid then
    return new;
  end if;

  select c.union_id into v_union from public.clubs c where c.id = new.club_id;
  if v_union = 'fade0000-0000-0000-0000-000000000001'::uuid then
    return new;
  end if;

  -- Cash games elsewhere are capped at 2.00/5.00 blinds
  if coalesce(new.enabled, false) and coalesce(new.bb, 0) > 5.00 then
    raise exception using errcode = '22023',
      message = 'Cash games are capped at 2.00/5.00 blinds';
  end if;
  return new;
end
$function$;
COMMIT;
