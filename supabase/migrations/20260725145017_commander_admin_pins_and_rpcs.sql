-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725145017 "commander_admin_pins_and_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 81594e1f7dd4c8d76d27fdf9bcfe09d8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commander audit 2026-07-25: admin PIN storage + RPCs (pin-setup/pin-verify
-- previously called set/verify_commander_admin_pin which did not exist).
-- Tier 2: new table + new functions, no existing objects altered.

create table if not exists public.commander_admin_pins (
  user_id uuid primary key,
  pin_hash text not null,
  fail_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.commander_admin_pins enable row level security;
-- No policies: service-role only access (routes use the service key).

create or replace function public.set_commander_admin_pin(p_user_id uuid, p_pin_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_pin_hash is null or length(p_pin_hash) < 32 then
    raise exception 'invalid arguments';
  end if;
  insert into commander_admin_pins (user_id, pin_hash)
  values (p_user_id, p_pin_hash)
  on conflict (user_id)
  do update set pin_hash = excluded.pin_hash, fail_count = 0, locked_until = null, updated_at = now();
end;
$$;

create or replace function public.verify_commander_admin_pin(p_user_id uuid, p_pin_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row commander_admin_pins%rowtype;
begin
  select * into v_row from commander_admin_pins where user_id = p_user_id;
  if not found then
    return jsonb_build_object('pin_set', false, 'valid', false, 'locked', false);
  end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object('pin_set', true, 'valid', false, 'locked', true,
                              'locked_until', v_row.locked_until);
  end if;
  if v_row.pin_hash = p_pin_hash then
    update commander_admin_pins set fail_count = 0, locked_until = null, updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('pin_set', true, 'valid', true, 'locked', false);
  end if;
  update commander_admin_pins
     set fail_count = fail_count + 1,
         locked_until = case when fail_count + 1 >= 10 then now() + interval '15 minutes' else locked_until end,
         updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('pin_set', true, 'valid', false, 'locked', false);
end;
$$;

revoke all on function public.set_commander_admin_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.verify_commander_admin_pin(uuid, text) from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='commander_admin_pins') then
    raise exception 'commander_admin_pins was not created';
  end if;
end $$;
