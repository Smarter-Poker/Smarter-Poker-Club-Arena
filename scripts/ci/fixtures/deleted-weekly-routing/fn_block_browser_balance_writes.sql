CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_changed text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_table_name = 'club_members' then
    if new.chip_balance is distinct from old.chip_balance then
      v_changed := 'chip_balance';
    elsif new.held_chips is distinct from old.held_chips then
      v_changed := 'held_chips';
    elsif new.locked_chips is distinct from old.locked_chips then
      v_changed := 'locked_chips';
    elsif new.promo_balance is distinct from old.promo_balance then
      v_changed := 'promo_balance';
    end if;
  elsif tg_table_name = 'clubs' then
    if new.chip_treasury is distinct from old.chip_treasury then
      v_changed := 'chip_treasury';
    elsif new.chip_pool is distinct from old.chip_pool then
      v_changed := 'chip_pool';
    end if;
  end if;

  if v_changed is null then
    return new;
  end if;

  raise exception
    'Direct balance mutation of %.% from the browser is forbidden. Chips move only through the money RPCs.',
    tg_table_name, v_changed
    using errcode = 'insufficient_privilege';
end
$function$
