-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825225618; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_club_members_no_agent_cycle()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cursor uuid;
  v_hops   int := 0;
begin
  if new.agent_id is null then
    return new;
  end if;

  if new.agent_id = new.user_id then
    raise exception
      'club_members.agent_id: a member cannot be their own upline (club %, member %)',
      new.club_id, new.user_id
      using errcode = '23514';
  end if;

  v_cursor := new.agent_id;
  while v_cursor is not null and v_hops < 64 loop
    if v_cursor = new.user_id then
      raise exception
        'club_members.agent_id: % cannot sit under % - that would close a cycle in club %',
        new.user_id, new.agent_id, new.club_id
        using errcode = '23514';
    end if;
    select cm.agent_id
      into v_cursor
      from public.club_members cm
     where cm.club_id = new.club_id
       and cm.user_id = v_cursor;
    if not found then
      exit;
    end if;
    v_hops := v_hops + 1;
  end loop;

  if v_hops >= 64 then
    raise exception
      'club_members.agent_id: the upline chain above % is deeper than 64 levels or already loops',
      new.agent_id
      using errcode = '23514';
  end if;

  return new;
end
$function$;

comment on function public.fn_club_members_no_agent_cycle() is
  'Refuses a club_members.agent_id write that would make a member their own upline or close a cycle. Walks up from the proposed parent, club scoped, capped at 64 hops.';

drop trigger if exists trg_club_members_no_agent_cycle on public.club_members;
drop trigger if exists trg_club_members_no_agent_cycle_ins on public.club_members;
drop trigger if exists trg_club_members_no_agent_cycle_upd on public.club_members;

create trigger trg_club_members_no_agent_cycle_ins
  before insert on public.club_members
  for each row
  when (new.agent_id is not null)
  execute function public.fn_club_members_no_agent_cycle();

create trigger trg_club_members_no_agent_cycle_upd
  before update of agent_id on public.club_members
  for each row
  when (new.agent_id is not null and new.agent_id is distinct from old.agent_id)
  execute function public.fn_club_members_no_agent_cycle();

do $$
declare c int;
begin
  select count(*) into c
    from pg_trigger t
    join pg_class rel on rel.oid = t.tgrelid
   where rel.relname = 'club_members'
     and t.tgname in ('trg_club_members_no_agent_cycle_ins',
                      'trg_club_members_no_agent_cycle_upd')
     and not t.tgisinternal;
  if c <> 2 then
    raise exception 'post-check: expected 2 cycle guard triggers on club_members, found %', c;
  end if;
end $$;

do $$
declare
  v_ins int;
  v_upd int;
begin
  select t.tgtype into v_ins from pg_trigger t join pg_class rel on rel.oid = t.tgrelid
   where rel.relname = 'club_members' and t.tgname = 'trg_club_members_no_agent_cycle_ins';
  select t.tgtype into v_upd from pg_trigger t join pg_class rel on rel.oid = t.tgrelid
   where rel.relname = 'club_members' and t.tgname = 'trg_club_members_no_agent_cycle_upd';
  if (v_ins & 7) <> 7 then
    raise exception 'post-check: insert guard is not BEFORE INSERT FOR EACH ROW (tgtype %)', v_ins;
  end if;
  if (v_upd & 19) <> 19 then
    raise exception 'post-check: update guard is not BEFORE UPDATE FOR EACH ROW (tgtype %)', v_upd;
  end if;
end $$;
