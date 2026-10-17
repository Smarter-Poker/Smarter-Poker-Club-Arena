create table if not exists public.anti_cheat_exemptions (
  player_id uuid not null references public.profiles(id) on delete cascade,
  flag_type text not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (player_id, flag_type)
);
alter table public.anti_cheat_exemptions enable row level security;

create or replace function public.fn_anti_cheat_flags_skip_exempt()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.anti_cheat_exemptions e
             where e.player_id = new.player_id and e.flag_type = new.flag_type) then
    return null;
  end if;
  return new;
end $$;

drop trigger if exists trg_anti_cheat_flags_skip_exempt on public.anti_cheat_flags;
create trigger trg_anti_cheat_flags_skip_exempt
  before insert on public.anti_cheat_flags
  for each row execute function public.fn_anti_cheat_flags_skip_exempt();

insert into public.anti_cheat_exemptions (player_id, flag_type, reason) values
  ('47965354-0e56-43ef-931c-ddaab82af765', 'multi_account', 'Owner beta testing (KingFish)'),
  ('9b027798-9532-403f-a5c1-15554ce2959c', 'multi_account', 'Owner beta testing (Danimal)')
on conflict do nothing;

update public.anti_cheat_flags
set status = 'reviewed', reviewed_at = now(),
    review_notes = 'Owner beta testing account; multi-account exempt'
where flag_type = 'multi_account'
  and status = 'open'
  and player_id in ('47965354-0e56-43ef-931c-ddaab82af765','9b027798-9532-403f-a5c1-15554ce2959c');
