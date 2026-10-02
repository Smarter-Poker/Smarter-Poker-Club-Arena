-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821152550 "chip_requests_and_tournament_tickets"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 20410327e49633ec57e7b9835b5d4f25 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════════
-- CASHIER: the two features the Trade view was only PRETENDING to have
-- (Dan 2026-08-21: "finish up everything thats still pending and not finished")
--
-- 1. CHIP REQUESTS — a player asks their agent/owner for chips; the agent sees
--    it in the Chip Request tab and approves in one tap. Approval reuses the
--    exact conserved club-ledger move fn_cashier_send_chips performs, so a
--    request can never create chips.
-- 2. TOURNAMENT TICKETS — "Send Ticket" issues a real, redeemable buy-in
--    credit. Issuing DEBITS the issuer immediately (the chips are escrowed on
--    the ticket, not conjured); redeeming credits the holder. Cancelling
--    refunds the issuer. Chips are conserved at every step.
--
-- ROLLBACK:
--   drop function public.fn_respond_chip_request(uuid, text);
--   drop function public.fn_request_chips(uuid, numeric, text);
--   drop function public.fn_redeem_tournament_ticket(uuid);
--   drop function public.fn_cancel_tournament_ticket(uuid);
--   drop function public.fn_issue_tournament_ticket(uuid, uuid, numeric, text);
--   drop table public.chip_requests; drop table public.tournament_tickets;
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Tables ────────────────────────────────────────────────────────────────────
create table if not exists public.chip_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  requester_id uuid not null,
  approver_id uuid,                 -- the agent/owner the request is aimed at
  amount numeric not null check (amount > 0),
  note text,
  status text not null default 'pending'
    check (status in ('pending','approved','declined','cancelled')),
  responded_by uuid,
  responded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists chip_requests_club_status_idx
  on public.chip_requests (club_id, status, created_at desc);
create index if not exists chip_requests_approver_idx
  on public.chip_requests (approver_id, status);
create index if not exists chip_requests_requester_idx
  on public.chip_requests (requester_id, status);

create table if not exists public.tournament_tickets (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  issued_by uuid not null,
  holder_id uuid not null,
  value numeric not null check (value > 0),
  note text,
  status text not null default 'issued'
    check (status in ('issued','redeemed','cancelled')),
  redeemed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tournament_tickets_holder_idx
  on public.tournament_tickets (holder_id, status, created_at desc);
create index if not exists tournament_tickets_club_idx
  on public.tournament_tickets (club_id, status, created_at desc);

alter table public.chip_requests enable row level security;
alter table public.tournament_tickets enable row level security;

-- Readable by the two parties and by club staff; ALL writes go through the
-- SECURITY DEFINER RPCs below (no direct insert/update policy exists).
drop policy if exists chip_requests_read on public.chip_requests;
create policy chip_requests_read on public.chip_requests for select to authenticated
using (
  requester_id = auth.uid()
  or approver_id = auth.uid()
  or exists (select 1 from club_members cm
              where cm.club_id = chip_requests.club_id and cm.user_id = auth.uid()
                and cm.role in ('owner','co_owner','admin','super_agent','agent','sub_agent'))
);

drop policy if exists tournament_tickets_read on public.tournament_tickets;
create policy tournament_tickets_read on public.tournament_tickets for select to authenticated
using (
  holder_id = auth.uid()
  or issued_by = auth.uid()
  or exists (select 1 from club_members cm
              where cm.club_id = tournament_tickets.club_id and cm.user_id = auth.uid()
                and cm.role in ('owner','co_owner','admin','super_agent','agent','sub_agent'))
);

-- ── 1. Player asks for chips ──────────────────────────────────────────────────
create or replace function public.fn_request_chips(
  p_club_id uuid,
  p_amount numeric,
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_agent uuid;
  v_open int;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'amount exceeds limit');
  end if;

  select agent_id into v_agent from club_members
   where club_id = p_club_id and user_id = v_me and status = 'active';
  if not found then
    return jsonb_build_object('success', false, 'error', 'you are not an active member of this club');
  end if;

  -- No agent assigned? aim it at the club owner so it is never orphaned.
  if v_agent is null then
    select owner_id into v_agent from clubs where id = p_club_id;
  end if;

  select count(*) into v_open from chip_requests
   where club_id = p_club_id and requester_id = v_me and status = 'pending';
  if v_open >= 3 then
    return jsonb_build_object('success', false, 'error', 'you already have 3 open requests');
  end if;

  insert into chip_requests (club_id, requester_id, approver_id, amount, note)
  values (p_club_id, v_me, v_agent, p_amount, nullif(trim(coalesce(p_note,'')), ''));

  return jsonb_build_object('success', true);
end $$;

-- ── 2. Agent/owner answers it ─────────────────────────────────────────────────
create or replace function public.fn_respond_chip_request(
  p_request_id uuid,
  p_action text                      -- 'approve' | 'decline' | 'cancel'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_req record;
  v_role text;
  v_from_bal numeric;
  v_from_after numeric;
  v_to_after numeric;
  v_first uuid; v_second uuid;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_action not in ('approve','decline','cancel') then
    return jsonb_build_object('success', false, 'error', 'invalid action');
  end if;

  select * into v_req from chip_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'request not found'); end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('success', false, 'error', 'request already ' || v_req.status);
  end if;

  -- The requester may cancel their own open request.
  if p_action = 'cancel' then
    if v_req.requester_id <> v_me then
      return jsonb_build_object('success', false, 'error', 'only the requester may cancel');
    end if;
    update chip_requests set status = 'cancelled', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'cancelled');
  end if;

  select role into v_role from club_members
   where club_id = v_req.club_id and user_id = v_me and status = 'active';
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success', false, 'error', 'you cannot answer chip requests here');
  end if;
  -- Agent tier may only answer their OWN downline's requests.
  if v_role in ('super_agent','agent','sub_agent') and v_req.approver_id is distinct from v_me then
    return jsonb_build_object('success', false, 'error', 'this request is not addressed to you');
  end if;

  if p_action = 'decline' then
    update chip_requests set status = 'declined', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'declined');
  end if;

  -- APPROVE = the same conserved club-ledger move as a cashier Send Out.
  if v_me = v_req.requester_id then
    return jsonb_build_object('success', false, 'error', 'you cannot approve your own request');
  end if;

  if v_me < v_req.requester_id then v_first := v_me; v_second := v_req.requester_id;
  else v_first := v_req.requester_id; v_second := v_me; end if;
  perform 1 from club_members where club_id = v_req.club_id and user_id = v_first for update;
  perform 1 from club_members where club_id = v_req.club_id and user_id = v_second for update;

  select coalesce(chip_balance,0) into v_from_bal from club_members
   where club_id = v_req.club_id and user_id = v_me;
  if v_from_bal < v_req.amount then
    return jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_from_bal);
  end if;

  update club_members set chip_balance = chip_balance - v_req.amount, updated_at = now()
   where club_id = v_req.club_id and user_id = v_me returning chip_balance into v_from_after;
  update club_members set chip_balance = coalesce(chip_balance,0) + v_req.amount, updated_at = now()
   where club_id = v_req.club_id and user_id = v_req.requester_id returning chip_balance into v_to_after;

  insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  values (v_req.club_id, v_me, v_req.requester_id, v_req.amount, 'peer_transfer',
          'Chip request approved', v_to_after);
  insert into wallet_transactions (user_id, wallet_type, type, amount, category, description, balance_after)
  values (v_me, 'PLAYER', 'debit', v_req.amount, 'transfer', 'Chip request approved', v_from_after),
         (v_req.requester_id, 'PLAYER', 'credit', v_req.amount, 'transfer', 'Chip request approved', v_to_after);

  update chip_requests set status = 'approved', responded_by = v_me, responded_at = now()
   where id = p_request_id;

  return jsonb_build_object('success', true, 'status', 'approved',
                            'your_balance', v_from_after, 'their_balance', v_to_after);
end $$;

-- ── 3. Tournament tickets ─────────────────────────────────────────────────────
create or replace function public.fn_issue_tournament_ticket(
  p_club_id uuid,
  p_holder_id uuid,
  p_value numeric,
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_holder_agent uuid;
  v_bal numeric;
  v_after numeric;
  v_first uuid; v_second uuid;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_value is null or p_value <= 0 then
    return jsonb_build_object('success', false, 'error', 'ticket value must be > 0');
  end if;
  if p_holder_id = v_me then
    return jsonb_build_object('success', false, 'error', 'cannot issue a ticket to yourself');
  end if;

  select role into v_role from club_members
   where club_id = p_club_id and user_id = v_me and status = 'active';
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success', false, 'error', 'your role cannot issue tickets');
  end if;

  select agent_id into v_holder_agent from club_members
   where club_id = p_club_id and user_id = p_holder_id and status = 'active';
  if not found then
    return jsonb_build_object('success', false, 'error', 'recipient is not an active member of this club');
  end if;
  if v_role in ('super_agent','agent','sub_agent') and v_holder_agent is distinct from v_me then
    return jsonb_build_object('success', false, 'error', 'recipient is not in your downline');
  end if;

  if v_me < p_holder_id then v_first := v_me; v_second := p_holder_id;
  else v_first := p_holder_id; v_second := v_me; end if;
  perform 1 from club_members where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members where club_id = p_club_id and user_id = v_second for update;

  select coalesce(chip_balance,0) into v_bal from club_members
   where club_id = p_club_id and user_id = v_me;
  if v_bal < p_value then
    return jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_bal);
  end if;

  -- Escrow: the issuer pays NOW, the ticket holds the value until redeemed.
  update club_members set chip_balance = chip_balance - p_value, updated_at = now()
   where club_id = p_club_id and user_id = v_me returning chip_balance into v_after;

  insert into tournament_tickets (club_id, issued_by, holder_id, value, note)
  values (p_club_id, v_me, p_holder_id, p_value, nullif(trim(coalesce(p_note,'')), ''));

  insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  values (p_club_id, v_me, p_holder_id, p_value, 'peer_transfer',
          'Tournament ticket issued (escrowed until redeemed)', v_after);

  return jsonb_build_object('success', true, 'your_balance', v_after);
end $$;

create or replace function public.fn_redeem_tournament_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_t record;
  v_after numeric;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  select * into v_t from tournament_tickets where id = p_ticket_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'ticket not found'); end if;
  if v_t.holder_id <> v_me then
    return jsonb_build_object('success', false, 'error', 'this ticket is not yours');
  end if;
  if v_t.status <> 'issued' then
    return jsonb_build_object('success', false, 'error', 'ticket already ' || v_t.status);
  end if;

  update club_members set chip_balance = coalesce(chip_balance,0) + v_t.value, updated_at = now()
   where club_id = v_t.club_id and user_id = v_me returning chip_balance into v_after;
  if v_after is null then
    return jsonb_build_object('success', false, 'error', 'you are no longer a member of that club');
  end if;

  update tournament_tickets set status = 'redeemed', redeemed_at = now() where id = p_ticket_id;

  insert into wallet_transactions (user_id, wallet_type, type, amount, category, description, balance_after)
  values (v_me, 'PLAYER', 'credit', v_t.value, 'transfer', 'Tournament ticket redeemed', v_after);

  return jsonb_build_object('success', true, 'value', v_t.value, 'your_balance', v_after);
end $$;

create or replace function public.fn_cancel_tournament_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_t record;
  v_after numeric;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  select * into v_t from tournament_tickets where id = p_ticket_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'ticket not found'); end if;
  if v_t.issued_by <> v_me then
    return jsonb_build_object('success', false, 'error', 'only the issuer may cancel a ticket');
  end if;
  if v_t.status <> 'issued' then
    return jsonb_build_object('success', false, 'error', 'ticket already ' || v_t.status);
  end if;

  -- Refund the escrow to the issuer.
  update club_members set chip_balance = coalesce(chip_balance,0) + v_t.value, updated_at = now()
   where club_id = v_t.club_id and user_id = v_me returning chip_balance into v_after;
  update tournament_tickets set status = 'cancelled', cancelled_at = now() where id = p_ticket_id;

  insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  values (v_t.club_id, null, v_me, v_t.value, 'peer_transfer', 'Tournament ticket cancelled (escrow refunded)', v_after);

  return jsonb_build_object('success', true, 'refunded', v_t.value, 'your_balance', v_after);
end $$;

revoke all on function public.fn_request_chips(uuid, numeric, text) from public, anon;
revoke all on function public.fn_respond_chip_request(uuid, text) from public, anon;
revoke all on function public.fn_issue_tournament_ticket(uuid, uuid, numeric, text) from public, anon;
revoke all on function public.fn_redeem_tournament_ticket(uuid) from public, anon;
revoke all on function public.fn_cancel_tournament_ticket(uuid) from public, anon;
grant execute on function public.fn_request_chips(uuid, numeric, text) to authenticated, service_role;
grant execute on function public.fn_respond_chip_request(uuid, text) to authenticated, service_role;
grant execute on function public.fn_issue_tournament_ticket(uuid, uuid, numeric, text) to authenticated, service_role;
grant execute on function public.fn_redeem_tournament_ticket(uuid) to authenticated, service_role;
grant execute on function public.fn_cancel_tournament_ticket(uuid) to authenticated, service_role;
grant select on public.chip_requests to authenticated;
grant select on public.tournament_tickets to authenticated;
