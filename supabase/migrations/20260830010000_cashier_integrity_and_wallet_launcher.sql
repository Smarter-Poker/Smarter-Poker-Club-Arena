-- CASHIER INTEGRITY + SCALE CLOSEOUT (2026-08-30)
-- Reconstructs the two cashier tables, binds request/ticket replay keys to the
-- full intent, serialises request quotas, closes ticket membership TOCTOU, and
-- prevents authenticated clients from writing agent wallet balances directly.

begin;

create table if not exists public.chip_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  requester_id uuid not null references auth.users(id) on delete cascade,
  approver_id uuid references auth.users(id) on delete set null,
  amount numeric(18,2) not null check (amount > 0),
  note text,
  status text not null default 'pending',
  responded_by uuid references auth.users(id) on delete set null,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  op_id uuid
);

do $migration$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='chip_requests' and column_name='op_id'
  ) then
    alter table public.chip_requests add column op_id uuid;
  end if;
end $migration$;
create unique index if not exists chip_requests_requester_op_uidx
  on public.chip_requests (club_id, requester_id, op_id) where op_id is not null;
create index if not exists chip_requests_cashier_inbox_idx
  on public.chip_requests (club_id, approver_id, status, created_at desc);
create index if not exists chip_requests_requester_status_idx
  on public.chip_requests (club_id, requester_id, status, created_at desc);
alter table public.chip_requests enable row level security;
drop policy if exists cashier_chip_requests_read on public.chip_requests;
create policy cashier_chip_requests_read on public.chip_requests for select to authenticated
using (
  requester_id=(select auth.uid()) or approver_id=(select auth.uid())
  or public.fn_club_cashier_scope(club_id,(select auth.uid()))='all'
);
revoke insert, update, delete on public.chip_requests from authenticated, anon;
grant select on public.chip_requests to authenticated;

create table if not exists public.tournament_tickets (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  issued_by uuid references auth.users(id),
  holder_id uuid not null references auth.users(id),
  value numeric(18,2) not null check (value > 0),
  status text not null default 'issued',
  note text,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  cancelled_at timestamptz
);

do $migration$
begin
  -- A clean replay reaches us with the legacy required `issuer_id` column.
  -- Rename it when possible so the replacement RPC cannot trip that old
  -- NOT NULL constraint. If a partially-upgraded database has both columns,
  -- copy the data, remove the legacy policy dependency, then remove the alias.
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='tournament_tickets' and column_name='issued_by'
  ) and exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='tournament_tickets' and column_name='issuer_id'
  ) then
    alter table public.tournament_tickets rename column issuer_id to issued_by;
  elsif not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='tournament_tickets' and column_name='issued_by'
  ) then
    alter table public.tournament_tickets add column issued_by uuid references auth.users(id);
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='tournament_tickets' and column_name='cancelled_at'
  ) then
    alter table public.tournament_tickets add column cancelled_at timestamptz;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='tournament_tickets' and column_name='issuer_id'
  ) then
    update public.tournament_tickets set issued_by=issuer_id where issued_by is null;
    drop policy if exists "View tickets" on public.tournament_tickets;
    alter table public.tournament_tickets drop column issuer_id;
  end if;
end $migration$;

do $migration$
declare c record;
begin
  -- Recreate deterministically. Merely finding the word "issued" did not prove
  -- a partial legacy constraint also allowed cancellation.
  for c in
    select conname from pg_constraint
     where conrelid='public.tournament_tickets'::regclass
       and contype='c' and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.tournament_tickets drop constraint %I', c.conname);
  end loop;
  update public.tournament_tickets set status='issued' where status='active';
  alter table public.tournament_tickets alter column status set default 'issued';
  alter table public.tournament_tickets
    add constraint tournament_tickets_status_check
    check (status in ('issued','redeemed','cancelled')) not valid;
  alter table public.tournament_tickets validate constraint tournament_tickets_status_check;
end $migration$;
create index if not exists tournament_tickets_holder_status_idx
  on public.tournament_tickets (holder_id, status, created_at desc);
create index if not exists tournament_tickets_issuer_idx
  on public.tournament_tickets (issued_by, status, created_at desc);
alter table public.tournament_tickets enable row level security;
drop policy if exists cashier_tournament_tickets_read on public.tournament_tickets;
create policy cashier_tournament_tickets_read on public.tournament_tickets for select to authenticated
using (
  issued_by=(select auth.uid()) or holder_id=(select auth.uid())
  or public.fn_club_cashier_scope(club_id,(select auth.uid()))='all'
);
revoke insert, update, delete on public.tournament_tickets from authenticated, anon;
grant select on public.tournament_tickets to authenticated;

-- One server response now contains the horse flag; the SPA no longer performs
-- one profiles request per 300 roster rows before it can paint the cashier.
create or replace function public.fn_club_cashier_members_v2(p_club_id uuid)
returns table (
  user_id uuid, role text, role_rank int, depth int, chip_balance numeric,
  name text, username text, player_number text, avatar_url text, is_horse boolean
)
language sql stable security definer set search_path to 'public','pg_temp'
as $function$
  select m.user_id, m.role, m.role_rank, m.depth, m.chip_balance,
         m.name, m.username, m.player_number, m.avatar_url,
         coalesce(p.is_horse, false)
    from public.fn_club_cashier_members(p_club_id) m
    left join public.profiles p on p.id=m.user_id
   order by m.role_rank desc, m.user_id
$function$;
revoke all on function public.fn_club_cashier_members_v2(uuid) from public, anon;
grant execute on function public.fn_club_cashier_members_v2(uuid) to authenticated, service_role;

drop function if exists public.fn_request_chips(uuid,numeric,text);
create or replace function public.fn_request_chips(
  p_club_id uuid, p_amount numeric, p_note text default null, p_op_id uuid default null
) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_agent uuid;
  v_open int;
  v_prior public.chip_requests%rowtype;
  v_note text := nullif(btrim(coalesce(p_note,'')), '');
  v_id uuid;
begin
  if v_me is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_club_id is null or p_amount is null or p_amount <= 0 or p_amount > 1e9 then
    return jsonb_build_object('success',false,'error','Enter A Valid Request Amount');
  end if;
  if p_amount <> round(p_amount,2) then
    return jsonb_build_object('success',false,'error','Chips Move In Hundredths At Most');
  end if;

  -- One requester/club lock makes the max-three rule true under concurrency.
  perform pg_advisory_xact_lock(hashtextextended('chip-request:'||p_club_id::text||':'||v_me::text,0));
  if p_op_id is not null then
    select * into v_prior from public.chip_requests
     where club_id=p_club_id and requester_id=v_me and op_id=p_op_id;
    if found then
      if v_prior.amount is distinct from p_amount or v_prior.note is distinct from v_note then
        return jsonb_build_object('success',false,'error','That Retry Key Belongs To A Different Request');
      end if;
      return jsonb_build_object('success',true,'request_id',v_prior.id,'replayed',true);
    end if;
  end if;

  select cm.agent_id into v_agent from public.club_members cm
   where cm.club_id=p_club_id and cm.user_id=v_me
     and coalesce(cm.status,'active') in ('active','approved') for update;
  if not found then return jsonb_build_object('success',false,'error','You Are Not An Active Member Of This Club'); end if;
  if v_agent is null then select owner_id into v_agent from public.clubs where id=p_club_id; end if;
  select count(*) into v_open from public.chip_requests
   where club_id=p_club_id and requester_id=v_me and status='pending';
  if v_open >= 3 then return jsonb_build_object('success',false,'error','You Already Have 3 Open Requests'); end if;

  insert into public.chip_requests(club_id,requester_id,approver_id,amount,note,op_id)
  values(p_club_id,v_me,v_agent,p_amount,v_note,p_op_id) returning id into v_id;
  return jsonb_build_object('success',true,'request_id',v_id,'replayed',false);
end
$function$;
revoke all on function public.fn_request_chips(uuid,numeric,text,uuid) from public, anon;
grant execute on function public.fn_request_chips(uuid,numeric,text,uuid) to authenticated, service_role;

create unique index if not exists ux_chip_transactions_idempotency_key
  on public.chip_transactions ((metadata->>'idempotency_key'))
  where metadata ? 'idempotency_key';

-- Every financial authorization that depends on the club hierarchy and every
-- hierarchy mutation take the same transaction lock. This closes the gap where
-- an intermediate downline edge could be reassigned while a cashier RPC was
-- recursively authorizing it.
create or replace function public.lock_club_cashier_hierarchy_mutation()
returns trigger language plpgsql set search_path to 'public','pg_temp'
as $function$
declare
  v_old_club uuid := case when tg_op in ('UPDATE','DELETE') then old.club_id else null end;
  v_new_club uuid := case when tg_op in ('INSERT','UPDATE') then new.club_id else null end;
begin
  if v_old_club is not null and (v_new_club is null or v_old_club::text <= v_new_club::text) then
    perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||v_old_club::text,0));
  end if;
  if v_new_club is not null and v_new_club is distinct from v_old_club then
    perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||v_new_club::text,0));
  end if;
  if v_old_club is not null and v_new_club is not null and v_old_club::text > v_new_club::text then
    perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||v_old_club::text,0));
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;
drop trigger if exists lock_cashier_hierarchy_insert_delete on public.club_members;
create trigger lock_cashier_hierarchy_insert_delete
before insert or delete on public.club_members for each row
execute function public.lock_club_cashier_hierarchy_mutation();
drop trigger if exists lock_cashier_hierarchy_update on public.club_members;
create trigger lock_cashier_hierarchy_update
before update of club_id,agent_id,role,status on public.club_members for each row
execute function public.lock_club_cashier_hierarchy_mutation();

create or replace function public.fn_issue_tournament_ticket(
  p_club_id uuid, p_holder_id uuid, p_value numeric,
  p_note text default null, p_idempotency_key text default null
) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_holder_role text;
  v_after numeric;
  v_key text := nullif(btrim(coalesce(p_idempotency_key,'')),'');
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
  v_prior record;
  v_ticket_id uuid;
  v_first uuid;
  v_second uuid;
begin
  if v_me is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_club_id is null or p_holder_id is null or p_holder_id=v_me then
    return jsonb_build_object('success',false,'error','Choose Another Active Member');
  end if;
  if p_value is null or p_value <= 0 or p_value > 1e9 or p_value <> round(p_value,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Ticket Value');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('ticket:'||v_key,0));
    select ct.* into v_prior from public.chip_transactions ct
     where ct.metadata->>'idempotency_key'=v_key limit 1;
    if found then
      if v_prior.transaction_type <> 'tournament_ticket_issue'
         and not (v_prior.transaction_type='peer_transfer'
                  and v_prior.notes ilike 'Tournament ticket issued%') then
        return jsonb_build_object('success',false,'error','That Retry Key Is Already In Use');
      end if;
      if v_prior.club_id is distinct from p_club_id
         or v_prior.from_user_id is distinct from v_me
         or v_prior.to_user_id is distinct from p_holder_id
         or v_prior.amount is distinct from p_value
         or (v_prior.metadata ? 'note'
             and coalesce(v_prior.metadata->>'note','') is distinct from coalesce(v_note,'')) then
        return jsonb_build_object('success',false,'error','That Retry Key Belongs To A Different Ticket');
      end if;
      return jsonb_build_object('success',true,'replayed',true,
        'ticket_id',v_prior.metadata->>'ticket_id',
        'your_balance',(v_prior.metadata->>'issuer_balance_after')::numeric);
    end if;
  end if;

  -- Lock both memberships in deterministic order, then re-check every role and
  -- downline rule while the rows cannot be deleted or reassigned underneath us.
  if v_me < p_holder_id then v_first:=v_me; v_second:=p_holder_id;
  else v_first:=p_holder_id; v_second:=v_me; end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_first for update;
  if not found then return jsonb_build_object('success',false,'error','A Required Membership No Longer Exists'); end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_second for update;
  if not found then return jsonb_build_object('success',false,'error','A Required Membership No Longer Exists'); end if;

  select role into v_role from public.club_members
   where club_id=p_club_id and user_id=v_me and coalesce(status,'active') in ('active','approved');
  select role into v_holder_role from public.club_members
   where club_id=p_club_id and user_id=p_holder_id and coalesce(status,'active') in ('active','approved');
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Your Role Cannot Issue Tickets');
  end if;
  if v_holder_role is null then return jsonb_build_object('success',false,'error','Recipient Is Not Active In This Club'); end if;
  if v_role in ('super_agent','agent','sub_agent')
     and not public.fn_club_cashier_can_transact(p_club_id,v_me,p_holder_id) then
    return jsonb_build_object('success',false,'error','Recipient Is Not In Your Downline');
  end if;

  update public.club_members set chip_balance=coalesce(chip_balance,0)-p_value,updated_at=now()
   where club_id=p_club_id and user_id=v_me and coalesce(status,'active') in ('active','approved')
     and coalesce(chip_balance,0)>=p_value returning chip_balance into v_after;
  if not found then return jsonb_build_object('success',false,'error','Insufficient Chips'); end if;

  insert into public.tournament_tickets(club_id,issued_by,holder_id,value,note)
  values(p_club_id,v_me,p_holder_id,p_value,v_note) returning id into v_ticket_id;
  insert into public.chip_transactions
    (club_id,from_user_id,to_user_id,amount,transaction_type,notes,balance_after,metadata)
  values(p_club_id,v_me,p_holder_id,p_value,'tournament_ticket_issue',
    'Tournament Ticket Issued',v_after,
    jsonb_strip_nulls(jsonb_build_object(
      'idempotency_key',v_key,'ticket_id',v_ticket_id,'issuer_id',v_me,
      'holder_id',p_holder_id,'value',p_value,'note',v_note,'issuer_balance_after',v_after)));
  return jsonb_build_object('success',true,'replayed',false,'ticket_id',v_ticket_id,'your_balance',v_after);
end
$function$;
revoke all on function public.fn_issue_tournament_ticket(uuid,uuid,numeric,text,text) from public, anon;
grant execute on function public.fn_issue_tournament_ticket(uuid,uuid,numeric,text,text) to authenticated, service_role;

-- SECURITY DEFINER cashier functions run as their owner. Direct PostgREST
-- writes run as authenticated and may never change a wallet balance, even if
-- a broad legacy UPDATE policy admits the row.
create or replace function public.guard_agent_wallet_direct_update()
returns trigger language plpgsql set search_path to 'public','pg_temp'
as $function$
begin
  if current_user in ('authenticated','anon') then
    if tg_op='INSERT' and (
      coalesce(new.agent_wallet_balance,0)<>0 or coalesce(new.business_balance,0)<>0 or
      coalesce(new.player_wallet_balance,0)<>0 or coalesce(new.player_balance,0)<>0 or
      coalesce(new.promo_wallet_balance,0)<>0 or coalesce(new.promo_balance,0)<>0 or
      coalesce(new.credit_limit,0)<>0 or coalesce(new.credit_used,0)<>0 or
      coalesce(new.commission_rate,0)<>0 or coalesce(new.player_rakeback_rate,0)<>0
    ) then
      raise exception 'Agent financial accounts may only be created through authorized operations';
    elsif tg_op='UPDATE' and (
      new.agent_wallet_balance is distinct from old.agent_wallet_balance or
      new.business_balance is distinct from old.business_balance or
      new.player_wallet_balance is distinct from old.player_wallet_balance or
      new.player_balance is distinct from old.player_balance or
      new.promo_wallet_balance is distinct from old.promo_wallet_balance or
      new.promo_balance is distinct from old.promo_balance or
      new.credit_limit is distinct from old.credit_limit or
      new.credit_used is distinct from old.credit_used or
      new.commission_rate is distinct from old.commission_rate or
      new.player_rakeback_rate is distinct from old.player_rakeback_rate
    ) then
      raise exception 'Agent financial accounts may only change through authorized operations';
    end if;
  end if;
  return new;
end
$function$;
drop trigger if exists guard_agent_wallet_direct_update on public.agents;
create trigger guard_agent_wallet_direct_update before insert or update on public.agents
for each row execute function public.guard_agent_wallet_direct_update();
-- The SPA already uses SECURITY DEFINER management RPCs. Keep table DML closed
-- even if a broad legacy RLS policy is replayed after this migration.
revoke insert, update, delete on public.agents from public, authenticated, anon;

do $assert$
begin
  if not exists (select 1 from pg_indexes where indexname='chip_requests_requester_op_uidx') then
    raise exception 'cashier request replay index missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname='guard_agent_wallet_direct_update' and not tgisinternal) then
    raise exception 'agent wallet direct-write guard missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname='lock_cashier_hierarchy_update' and not tgisinternal) then
    raise exception 'cashier hierarchy mutation lock missing';
  end if;
end
$assert$;

commit;
