-- CASHIER PHASE 2: AUTHORIZATION + AUDIT CONTRACTS (2026-08-31)
--
-- 1. A clean replay used legacy SELECT policies that exposed every club member
--    and agent row to every member. Production had narrower hot-fixed policies,
--    but they were not reproducible from migrations.
-- 2. The legacy tournament ticket policies survived some upgrade paths and let
--    every cashier-role member read every ticket, including unrelated agents'
--    downlines.
-- 3. The three money RPCs accepted a missing retry key and silently generated a
--    new one. A direct/old caller therefore had no protection from commit plus
--    lost-response retries.
-- 4. Ticket cancellation and redemption wrote generic peer_transfer rows with
--    no ticket id. The closing escrow leg could not be joined to its ticket.

begin;

-- ---------------------------------------------------------------------------
-- Deterministic row visibility. Keep self, staff, owned-union overseers, and
-- the caller's own cashier downline. Remove every broad legacy alias first.
-- ---------------------------------------------------------------------------
drop policy if exists club_members_select on public.club_members;
drop policy if exists "Members can view club members" on public.club_members;
drop policy if exists "Club staff can read club rosters" on public.club_members;
drop policy if exists "Members can read own club memberships" on public.club_members;
drop policy if exists agent_reads_own_roster on public.club_members;
drop policy if exists cashier_downline_read on public.club_members;

create policy "Members can read own club memberships"
on public.club_members for select to authenticated
using (user_id = (select auth.uid()));

create policy "Club staff can read club rosters"
on public.club_members for select to authenticated
using (
  public.is_club_admin(club_id, (select auth.uid()))
  or exists (
    select 1 from public.clubs c
     where c.id = club_members.club_id
       and c.owner_id = (select auth.uid())
  )
);

create policy cashier_downline_read
on public.club_members for select to authenticated
using (
  public.fn_club_cashier_scope(club_id, (select auth.uid())) = 'downline'
  and public.fn_club_cashier_can_transact(club_id, (select auth.uid()), user_id)
);

-- Commit one authorization surface at a time. Holding club_members while
-- waiting for agents deadlocks with normal reads that join them in the other
-- order. Each surface remains atomic and every following block is idempotent.
commit;
begin;

drop policy if exists agents_select on public.agents;
drop policy if exists agents_club_owner_read on public.agents;
drop policy if exists agents_read_own_or_club_manager on public.agents;
drop policy if exists agents_cashier_scoped_read on public.agents;

create policy agents_cashier_scoped_read
on public.agents for select to authenticated
using (
  user_id = (select auth.uid())
  or public.fn_club_cashier_scope(club_id, (select auth.uid())) = 'all'
  or (
    public.fn_club_cashier_scope(club_id, (select auth.uid())) = 'downline'
    and public.fn_club_cashier_can_transact(club_id, (select auth.uid()), user_id)
  )
);

revoke select, insert, update, delete on public.agents from anon;
revoke insert, update, delete on public.agents from authenticated;
grant select on public.agents to authenticated;

commit;
begin;

drop policy if exists "View tickets" on public.tournament_tickets;
drop policy if exists tournament_tickets_read on public.tournament_tickets;
drop policy if exists cashier_tournament_tickets_read on public.tournament_tickets;

create policy cashier_tournament_tickets_read
on public.tournament_tickets for select to authenticated
using (
  issued_by = (select auth.uid())
  or holder_id = (select auth.uid())
  or public.fn_club_cashier_scope(club_id, (select auth.uid())) = 'all'
);

revoke select, insert, update, delete on public.tournament_tickets from anon;
revoke insert, update, delete on public.tournament_tickets from authenticated;
grant select on public.tournament_tickets to authenticated;

commit;
begin;

-- ---------------------------------------------------------------------------
-- Mandatory retry keys. Preserve the public signatures for PostgREST, move the
-- proven money bodies behind non-callable cores, and refuse missing intent ids
-- before a balance row can be touched.
-- ---------------------------------------------------------------------------
do $migration$
begin
  if to_regprocedure(
    'public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)'
  ) is null then
    alter function public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)
      rename to fn_agent_wallet_send_phase2_core_20260831;
  end if;
  if to_regprocedure(
    'public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)'
  ) is null then
    alter function public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)
      rename to fn_agent_wallet_claim_back_phase2_core_20260831;
  end if;
  if to_regprocedure(
    'public.fn_issue_tournament_ticket_phase2_core_20260831(uuid,uuid,numeric,text,text)'
  ) is null then
    alter function public.fn_issue_tournament_ticket(uuid,uuid,numeric,text,text)
      rename to fn_issue_tournament_ticket_phase2_core_20260831;
  end if;
end
$migration$;

revoke all on function public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)
  from public, anon, authenticated;
revoke all on function public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)
  from public, anon, authenticated;
revoke all on function public.fn_issue_tournament_ticket_phase2_core_20260831(uuid,uuid,numeric,text,text)
  from public, anon, authenticated;

create or replace function public.fn_agent_wallet_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text default 'player_wallet',
  p_reason text default null, p_op_id uuid default null
) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Send');
  end if;
  return public.fn_agent_wallet_send_phase2_core_20260831(
    p_club_id,p_to_user_id,p_amount,p_destination,p_reason,p_op_id
  );
end
$function$;

create or replace function public.fn_agent_wallet_claim_back(
  p_club_id uuid, p_transaction_id uuid, p_amount numeric default null,
  p_reason text default null, p_op_id uuid default null
) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Claim Back');
  end if;
  return public.fn_agent_wallet_claim_back_phase2_core_20260831(
    p_club_id,p_transaction_id,p_amount,p_reason,p_op_id
  );
end
$function$;

create or replace function public.fn_issue_tournament_ticket(
  p_club_id uuid, p_holder_id uuid, p_value numeric,
  p_note text default null, p_idempotency_key text default null
) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
begin
  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Ticket');
  end if;
  return public.fn_issue_tournament_ticket_phase2_core_20260831(
    p_club_id,p_holder_id,p_value,p_note,p_idempotency_key
  );
end
$function$;

revoke all on function public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)
  from public, anon;
revoke all on function public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)
  from public, anon;
revoke all on function public.fn_issue_tournament_ticket(uuid,uuid,numeric,text,text)
  from public, anon;
grant execute on function public.fn_agent_wallet_send(uuid,uuid,numeric,text,text,uuid)
  to authenticated, service_role;
grant execute on function public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)
  to authenticated, service_role;
grant execute on function public.fn_issue_tournament_ticket(uuid,uuid,numeric,text,text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Ticket escrow closes with one distinct, ticket-linked ledger receipt. The
-- ticket row serializes retries, and the unique receipt makes a second closing
-- leg impossible even if a future caller regresses the status check.
-- ---------------------------------------------------------------------------
create unique index if not exists chip_transactions_ticket_cancel_receipt_uidx
  on public.chip_transactions ((metadata->>'ticket_id'))
  where transaction_type='tournament_ticket_cancel';
create unique index if not exists chip_transactions_ticket_redeem_receipt_uidx
  on public.chip_transactions ((metadata->>'ticket_id'))
  where transaction_type='tournament_ticket_redeem';

create or replace function public.fn_cancel_tournament_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_t public.tournament_tickets%rowtype;
  v_after numeric;
  v_receipt public.chip_transactions%rowtype;
begin
  if v_me is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_ticket_id is null then return jsonb_build_object('success',false,'error','Choose A Ticket'); end if;

  select * into v_t from public.tournament_tickets where id=p_ticket_id for update;
  if not found then return jsonb_build_object('success',false,'error','Ticket Not Found'); end if;
  if v_t.issued_by is distinct from v_me then
    return jsonb_build_object('success',false,'error','Only The Issuer May Cancel A Ticket');
  end if;
  if v_t.status='cancelled' then
    select * into v_receipt from public.chip_transactions
     where transaction_type='tournament_ticket_cancel'
       and metadata->>'ticket_id'=p_ticket_id::text limit 1;
    if found then
      return jsonb_build_object(
        'success',true,'replayed',true,'refunded',v_t.value,
        'your_balance',(v_receipt.metadata->>'issuer_balance_after')::numeric,
        'transaction_id',v_receipt.id
      );
    end if;
  end if;
  if v_t.status<>'issued' then
    return jsonb_build_object('success',false,'error','Ticket Already '||initcap(v_t.status));
  end if;

  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()
   where club_id=v_t.club_id and user_id=v_me
     and coalesce(status,'active') in ('active','approved')
   returning chip_balance into v_after;
  if v_after is null then
    return jsonb_build_object(
      'success',false,
      'error','You Are No Longer A Member Of That Club, So The Escrow Has Nowhere To Land'
    );
  end if;

  update public.tournament_tickets
     set status='cancelled',cancelled_at=now()
   where id=p_ticket_id;
  insert into public.chip_transactions
    (club_id,from_user_id,to_user_id,amount,transaction_type,notes,balance_after,metadata)
  values (
    v_t.club_id,null,v_me,v_t.value,'tournament_ticket_cancel',
    'Tournament Ticket Cancelled: Escrow Refunded',v_after,
    jsonb_build_object(
      'ticket_id',p_ticket_id,'issuer_id',v_t.issued_by,'holder_id',v_t.holder_id,
      'escrow_action','refund_to_issuer','issuer_balance_after',v_after
    )
  ) returning * into v_receipt;

  return jsonb_build_object(
    'success',true,'replayed',false,'refunded',v_t.value,
    'your_balance',v_after,'transaction_id',v_receipt.id
  );
end
$function$;

create or replace function public.fn_redeem_tournament_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_t public.tournament_tickets%rowtype;
  v_after numeric;
  v_receipt public.chip_transactions%rowtype;
begin
  if v_me is null then return jsonb_build_object('success',false,'error','Not Authenticated'); end if;
  if p_ticket_id is null then return jsonb_build_object('success',false,'error','Choose A Ticket'); end if;

  select * into v_t from public.tournament_tickets where id=p_ticket_id for update;
  if not found then return jsonb_build_object('success',false,'error','Ticket Not Found'); end if;
  if v_t.holder_id is distinct from v_me then
    return jsonb_build_object('success',false,'error','This Ticket Is Not Yours');
  end if;
  if v_t.status='redeemed' then
    select * into v_receipt from public.chip_transactions
     where transaction_type='tournament_ticket_redeem'
       and metadata->>'ticket_id'=p_ticket_id::text limit 1;
    if found then
      return jsonb_build_object(
        'success',true,'replayed',true,'value',v_t.value,
        'your_balance',(v_receipt.metadata->>'holder_balance_after')::numeric,
        'transaction_id',v_receipt.id
      );
    end if;
  end if;
  if v_t.status<>'issued' then
    return jsonb_build_object('success',false,'error','Ticket Already '||initcap(v_t.status));
  end if;

  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()
   where club_id=v_t.club_id and user_id=v_me
     and coalesce(status,'active') in ('active','approved')
   returning chip_balance into v_after;
  if v_after is null then
    return jsonb_build_object('success',false,'error','You Are No Longer A Member Of That Club');
  end if;

  update public.tournament_tickets
     set status='redeemed',redeemed_at=now()
   where id=p_ticket_id;
  insert into public.chip_transactions
    (club_id,from_user_id,to_user_id,amount,transaction_type,notes,balance_after,metadata)
  values (
    v_t.club_id,null,v_me,v_t.value,'tournament_ticket_redeem',
    'Tournament Ticket Redeemed: Escrow Released',v_after,
    jsonb_build_object(
      'ticket_id',p_ticket_id,'issuer_id',v_t.issued_by,'holder_id',v_t.holder_id,
      'escrow_action','release_to_holder','holder_balance_after',v_after
    )
  ) returning * into v_receipt;

  insert into public.wallet_transactions
    (user_id,wallet_type,type,amount,category,description,balance_after)
  values (
    v_me,'PLAYER','credit',v_t.value,'transfer',
    'Tournament Ticket Redeemed: Escrow Released',v_after
  );

  return jsonb_build_object(
    'success',true,'replayed',false,'value',v_t.value,
    'your_balance',v_after,'transaction_id',v_receipt.id
  );
end
$function$;

revoke all on function public.fn_cancel_tournament_ticket(uuid) from public, anon;
revoke all on function public.fn_redeem_tournament_ticket(uuid) from public, anon;
grant execute on function public.fn_cancel_tournament_ticket(uuid) to authenticated, service_role;
grant execute on function public.fn_redeem_tournament_ticket(uuid) to authenticated, service_role;

do $assert$
declare
  v_src text;
begin
  if exists (
    select 1 from pg_policies
     where schemaname='public' and tablename='tournament_tickets'
       and policyname in ('View tickets','tournament_tickets_read')
  ) then
    raise exception 'legacy broad tournament ticket policy survived';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname='public' and tablename in ('agents','club_members')
       and cmd='SELECT' and trim(coalesce(qual,''))='true'
  ) then
    raise exception 'broad cashier roster policy survived';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.fn_agent_wallet_send_phase2_core_20260831(uuid,uuid,numeric,text,text,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.fn_issue_tournament_ticket_phase2_core_20260831(uuid,uuid,numeric,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can bypass a mandatory retry-key wrapper';
  end if;
  select pg_get_functiondef(
    'public.fn_cancel_tournament_ticket(uuid)'::regprocedure
  ) into v_src;
  if v_src not like '%tournament_ticket_cancel%' or v_src not like '%ticket_id%' then
    raise exception 'ticket cancellation is not bound to a distinct ticket receipt';
  end if;
  select pg_get_functiondef(
    'public.fn_redeem_tournament_ticket(uuid)'::regprocedure
  ) into v_src;
  if v_src not like '%tournament_ticket_redeem%' or v_src not like '%ticket_id%' then
    raise exception 'ticket redemption is not bound to a distinct ticket receipt';
  end if;
end
$assert$;

commit;
