-- ═══════════════════════════════════════════════════════════════════════════
-- CASHIER PHASE 2 — CASH OUT LIFECYCLE, UNION SENDS, RECONCILIATION (2026-08-27)
-- ───────────────────────────────────────────────────────────────────────────
-- Continuation of 20260826_cashier_send_out_and_claim_back_audit_fixes. Every
-- claim below was verified against production source; money-path fixes are
-- probed inside rolled-back transactions before this ships (see the audit
-- record). IMPORTANT CONTEXT: chip_transactions holds ZERO rows of type
-- 'union_member_send' or 'union_promo_send' — the two broken union branches
-- below have never successfully run, so these fixes are PREVENTIVE; no repair
-- migration is needed.
--
--  1. fn_cashout_approve minted the approver's agents row WITHOUT the
--     NOT NULL commission_rate / player_rakeback_rate — the same 23502 the
--     three send RPCs had. First cash-out approval by a never-funded agent
--     crashed. Now uses fn_ensure_agent_row.
--
--  2. fn_expire_stale_cashouts could DESTROY the escrow: if the player had
--     left the club, the refund UPDATE matched no row and the function still
--     marked the escrow released and the request expired, with a NULL
--     balance_after. Now recreates the membership row exactly as
--     fn_cashout_release already does — an escrow refund must always land.
--
--  3. fn_cashout_request accepted sub-cent amounts (rounded debit against an
--     unrounded escrow) and had no upper bound. Hundredths guard + 1e9 cap,
--     matching every send RPC.
--
--  4. Replay lookups in fn_cashout_request / approve / release matched op_id
--     without the caller, handing anyone who could read a transaction row a
--     "success, replayed" receipt for an operation they never performed.
--     All are now caller-pinned.
--
--  5. fn_union_send_to_member ('chips') credited through
--     atomic_credit_wallet_and_log, which resolves the player's HOME club —
--     possibly a club OUTSIDE the union — so union money could land in a
--     foreign club's economy. And ('promo') credited add_to_promo_wallet,
--     which writes the FROZEN public.wallets pool (dead since 2026-08-21;
--     nothing reads it): promo sends destroyed value by stranding it. Both
--     branches also wrote chip_transactions.club_id = the UNION id, which
--     violates fk_chip_transactions_club_id_clubs on any new row. All fixed:
--     the credit resolves to a membership INSIDE the union, agent-tier
--     recipients are coerced into their agent/promo float (the 2026-08-25
--     law), players get chip_balance (promo is just as good as cash), and
--     both the union ledger and the resolved club's ledger get a row. The
--     anon EXECUTE grant is revoked.
--
--  6. fn_union_distribute_promo ('agent' target) credited
--     club_members.promo_balance — a column NOTHING reads (all zero in
--     production; the promo cashier spends agents.promo_wallet_balance).
--     Distributed promo was unreachable by the receiving agent. Now credits
--     the agents promo float via fn_ensure_agent_row (the sync trigger keeps
--     the legacy agents.promo_balance column mirrored).
--
--  7. reconcile_ledger_nightly gains a CASHIER INTEGRITY section:
--     stuck cash-out escrow (unreleased escrow on a non-pending request, or
--     released escrow on a still-pending one), negative cashier balances
--     (agent floats, promo floats, member wallets, club treasuries), and
--     agent-wallet sends whose claimed_back exceeds their amount — each filed
--     into ledger_reconcile_log as critical, the channel that already alerts.
--
-- ROLLBACK: all statements are CREATE OR REPLACE FUNCTION or grant changes;
-- previous definitions are in the pre-phase-2 schema and this file's history.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1+3+4. Cash out request ─────────────────────────────────────────────────
create or replace function public.fn_cashout_request(
  p_club_id uuid, p_amount numeric, p_note text default null, p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor   uuid := auth.uid();
  v_op_id   uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior   record;
  v_agent   uuid;
  v_before  numeric;
  v_after   numeric;
  v_cashout uuid;
  v_name    text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  -- Caller-pinned replay: an op_id is only a replay of THIS player's request.
  select id, amount, related_cashout_id, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'cashout_request_escrow'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id,
      'amount', v_prior.amount,
      'agent_id', v_prior.metadata ->> 'agent_id');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  -- Hundredths at most: club_members.chip_balance is numeric(20,2), so a finer
  -- amount debits rounded while the escrow row stores it raw — value drifts.
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Request Limit');
  end if;

  select coalesce(cm.chip_balance, 0), cm.agent_id
    into v_before, v_agent
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = v_actor
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_before is null then
    return jsonb_build_object('success', false,
      'error', 'You Are Not An Active Member Of This Club');
  end if;
  if v_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'You Only Hold ' || trim(to_char(v_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_before, 'requested', p_amount);
  end if;

  if v_agent is null then
    select c.owner_id into v_agent from clubs c where c.id = p_club_id;
  end if;
  if v_agent is null then
    select cm.user_id into v_agent
      from club_members cm
     where cm.club_id = p_club_id
       and cm.role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent')
     order by case cm.role
                when 'owner' then 1 when 'co_owner' then 2 when 'admin' then 3
                when 'super_agent' then 4 else 5 end
     limit 1;
  end if;
  if v_agent is null then
    return jsonb_build_object('success', false,
      'error', 'This Club Has Nobody Who Can Approve A Cash Out');
  end if;
  if v_agent = v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Request A Cash Out From Yourself');
  end if;

  if exists (select 1 from cashout_requests
              where club_id = p_club_id and player_id = v_actor and status = 'pending') then
    return jsonb_build_object('success', false,
      'error', 'You Already Have A Cash Out Waiting. Wait For It Or Cancel It First');
  end if;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) - p_amount,
         updated_at = now()
   where club_id = p_club_id and user_id = v_actor
   returning chip_balance into v_after;

  insert into cashout_requests (club_id, player_id, agent_id, amount, status, player_note)
  values (p_club_id, v_actor, v_agent, p_amount, 'pending', nullif(btrim(p_note), ''))
  returning id into v_cashout;

  insert into chip_escrow (cashout_request_id, player_id, amount, club_id, locked_at)
  values (v_cashout, v_actor, p_amount, p_club_id, now());

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
     related_cashout_id, metadata, balance_after)
  values
    (p_club_id, v_actor, v_agent, p_amount, 'cashout_request_escrow',
     coalesce(nullif(btrim(p_note), ''), 'Cash Out Requested. Chips Held In Escrow'),
     v_cashout,
     jsonb_build_object('op_id', v_op_id, 'agent_id', v_agent,
                        'player_balance_after', v_after),
     v_after);

  select coalesce(nullif(btrim(pr.display_name), ''),
                  nullif(btrim(pr.alias), ''),
                  nullif(btrim(pr.username), ''), 'A Player')
    into v_name
    from profiles pr where pr.id = v_actor;

  insert into notifications (user_id, type, title, message, metadata, actor_id)
  values (v_agent, 'settlement', 'Cash Out Requested',
          coalesce(v_name, 'A Player') || ' Requested To Cash Out '
            || trim(to_char(p_amount, 'FM999,999,999,990')) || ' Chips',
          jsonb_build_object('clubId', p_club_id, 'cashoutId', v_cashout,
                             'amount', p_amount, 'playerName', v_name),
          v_actor);

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', v_cashout, 'agent_id', v_agent, 'amount', p_amount,
    'player_name', v_name,
    'player_balance_after', v_after);
exception
  when unique_violation then
    return jsonb_build_object('success', false,
      'error', 'You Already Have A Cash Out Waiting. Wait For It Or Cancel It First');
end
$function$;

-- ── 1+4. Cash out approve ───────────────────────────────────────────────────
create or replace function public.fn_cashout_approve(
  p_cashout_id uuid, p_note text default null, p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor    uuid := auth.uid();
  v_op_id    uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior    record;
  v_req      record;
  v_escrow   record;
  v_role     text;
  v_agent_id uuid;
  v_after    numeric;
  v_name     text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, related_cashout_id, metadata into v_prior
    from chip_transactions
   where transaction_type = 'cashout_approved'
     and to_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end if;

  select * into v_req from cashout_requests where id = p_cashout_id for update;
  if v_req is null then
    return jsonb_build_object('success', false, 'error', 'That Cash Out Could Not Be Found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Has Already Been Dealt With',
      'current_status', v_req.status);
  end if;

  v_role := public.fn_club_bank_role(v_req.club_id);
  if v_role is null then
    return jsonb_build_object('success', false,
      'error', 'You Are Not A Member Of That Club');
  end if;
  if v_req.agent_id <> v_actor
     and not public.fn_club_cashier_can_transact(v_req.club_id, v_actor, v_req.player_id) then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Belongs To A Different Agent');
  end if;

  select * into v_escrow
    from chip_escrow
   where cashout_request_id = p_cashout_id
   for update;
  if v_escrow is null or v_escrow.released_at is not null then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Are Not Held In Escrow, So Nothing Can Be Released');
  end if;
  if v_escrow.amount <> v_req.amount then
    return jsonb_build_object('success', false,
      'error', 'The Escrowed Amount Does Not Match The Request');
  end if;

  -- THE 23502 FIX (phase 1, applied here too): the bare insert omitted the
  -- NOT NULL commission columns, so a never-funded approver crashed the
  -- approval. fn_ensure_agent_row mints the row correctly and locks it.
  v_agent_id := public.fn_ensure_agent_row(v_req.club_id, v_actor, v_role);
  if v_agent_id is null then
    raise exception 'could not ensure agents row for % in club %', v_actor, v_req.club_id;
  end if;

  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_req.amount,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance into v_after;

  update chip_escrow
     set released_at = now(), release_type = 'completed'
   where id = v_escrow.id;

  update cashout_requests
     set status = 'approved',
         agent_note = coalesce(nullif(btrim(p_note), ''), agent_note),
         acknowledged_at = now(),
         completed_at = now(),
         updated_at = now()
   where id = p_cashout_id;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
     related_cashout_id, metadata, balance_after)
  values
    (v_req.club_id, v_req.player_id, v_actor, v_req.amount, 'cashout_approved',
     coalesce(nullif(btrim(p_note), ''), 'Cash Out Approved. Escrow Released Into The Agent Wallet'),
     p_cashout_id,
     jsonb_build_object('op_id', v_op_id, 'assigned_agent_id', v_req.agent_id,
                        'approved_by', v_actor, 'approver_role', v_role,
                        'agent_wallet_after', v_after),
     v_after);

  select coalesce(nullif(btrim(pr.display_name), ''),
                  nullif(btrim(pr.alias), ''),
                  nullif(btrim(pr.username), ''), 'Your Agent')
    into v_name
    from profiles pr where pr.id = v_actor;

  insert into notifications (user_id, type, title, message, metadata, actor_id)
  values (v_req.player_id, 'settlement', 'Cash Out Approved',
          coalesce(v_name, 'Your Agent') || ' Approved Your Cash Out Of '
            || trim(to_char(v_req.amount, 'FM999,999,999,990')) || ' Chips',
          jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                             'amount', v_req.amount),
          v_actor);

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', p_cashout_id, 'amount', v_req.amount,
    'club_id', v_req.club_id,
    'player_id', v_req.player_id, 'agent_wallet_after', v_after);
exception
  when unique_violation then
    select id, amount, related_cashout_id, metadata into v_prior
      from chip_transactions
     where transaction_type = 'cashout_approved'
       and to_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
end
$function$;

-- ── 4. Cash out release: caller-pinned replays ──────────────────────────────
create or replace function public.fn_cashout_release(
  p_cashout_id uuid, p_note text default null, p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor     uuid := auth.uid();
  v_op_id     uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior     record;
  v_req       record;
  v_escrow    record;
  v_is_player boolean;
  v_type      text;
  v_status    text;
  v_after     numeric;
  v_name      text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, related_cashout_id into v_prior
    from chip_transactions
   where transaction_type in ('cashout_denied', 'cashout_cancelled')
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end if;

  select * into v_req from cashout_requests where id = p_cashout_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'That Cash Out Could Not Be Found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Has Already Been Dealt With',
      'current_status', v_req.status);
  end if;

  v_is_player := (v_req.player_id = v_actor);
  if not v_is_player
     and v_req.agent_id <> v_actor
     and not public.fn_club_cashier_can_transact(v_req.club_id, v_actor, v_req.player_id) then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Belongs To A Different Agent');
  end if;

  select * into v_escrow from chip_escrow where cashout_request_id = p_cashout_id for update;
  if not found or v_escrow.released_at is not null then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Are Not Held In Escrow, So Nothing Can Be Returned');
  end if;

  if v_escrow.amount is distinct from v_req.amount then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Does Not Match The Chips Held For It');
  end if;

  v_type   := case when v_is_player then 'cashout_cancelled' else 'cashout_denied' end;
  v_status := case when v_is_player then 'cancelled' else 'rejected' end;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) + v_escrow.amount,
         updated_at = now()
   where club_id = v_req.club_id and user_id = v_req.player_id
   returning chip_balance into v_after;
  if v_after is null then
    insert into club_members (club_id, user_id, role, chip_balance, status, is_active)
    values (v_req.club_id, v_req.player_id, 'player', v_escrow.amount, 'active', true)
    on conflict (club_id, user_id) do update
      set chip_balance = coalesce(club_members.chip_balance, 0) + excluded.chip_balance,
          updated_at = now()
    returning chip_balance into v_after;
  end if;

  update chip_escrow
     set released_at = now(),
         release_type = case when v_is_player then 'cancelled' else 'rejected' end
   where id = v_escrow.id;

  update cashout_requests
     set status = v_status,
         agent_note  = case when v_is_player then agent_note
                            else coalesce(nullif(btrim(p_note), ''), agent_note) end,
         player_note = case when v_is_player
                            then coalesce(nullif(btrim(p_note), ''), player_note)
                            else player_note end,
         cancelled_at = now(),
         updated_at = now()
   where id = p_cashout_id;

  begin
    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
       related_cashout_id, metadata, balance_after)
    values
      (v_req.club_id, v_actor, v_req.player_id, v_escrow.amount, v_type,
       coalesce(nullif(btrim(p_note), ''), 'Cash Out Closed. Chips Returned From Escrow'),
       p_cashout_id,
       jsonb_build_object('op_id', v_op_id, 'closed_by', v_actor,
                          'player_balance_after', v_after),
       v_after);
  exception when unique_violation then
    select id, amount, related_cashout_id into v_prior
      from chip_transactions
     where transaction_type in ('cashout_denied', 'cashout_cancelled')
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end;

  if not v_is_player then
    select coalesce(nullif(btrim(pr.display_name), ''),
                    nullif(btrim(pr.alias), ''),
                    nullif(btrim(pr.username), ''), 'Your Agent')
      into v_name
      from profiles pr where pr.id = v_actor;

    insert into notifications (user_id, type, title, message, metadata, actor_id)
    values (v_req.player_id, 'settlement', 'Cash Out Declined',
            coalesce(v_name, 'Your Agent') || ' Declined Your Cash Out. '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990')) || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_escrow.amount),
            v_actor);

  elsif v_req.agent_id is not null then
    select coalesce(nullif(btrim(pr.display_name), ''),
                    nullif(btrim(pr.alias), ''),
                    nullif(btrim(pr.username), ''), 'A Player')
      into v_name
      from profiles pr where pr.id = v_req.player_id;

    insert into notifications (user_id, type, title, message, metadata, actor_id)
    values (v_req.agent_id, 'settlement', 'Cash Out Withdrawn',
            coalesce(v_name, 'A Player') || ' Withdrew A Cash Out Request For '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990')) || ' Chips',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_escrow.amount),
            v_req.player_id);
  end if;

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', p_cashout_id, 'amount', v_escrow.amount,
    'club_id', v_req.club_id,
    'player_id', v_req.player_id,
    'agent_id', v_req.agent_id,
    'cancelled_by_player', v_is_player,
    'player_balance_after', v_after);
end
$function$;

-- ── 2. Expiry never burns the escrow ────────────────────────────────────────
create or replace function public.fn_expire_stale_cashouts(p_ttl_hours integer default 72)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_expired integer := 0;
  r         record;
  v_escrow  record;
  v_after   numeric;
begin
  for r in
    select id, club_id, player_id, amount
      from public.cashout_requests
     where status = 'pending'
       and created_at < now() - make_interval(hours => p_ttl_hours)
     for update
  loop
    select * into v_escrow
      from public.chip_escrow
     where cashout_request_id = r.id
     for update;

    if not found or v_escrow.released_at is not null then
      update public.cashout_requests
         set status = 'expired', updated_at = now()
       where id = r.id;
      continue;
    end if;

    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) + v_escrow.amount,
           updated_at   = now()
     where club_id = r.club_id and user_id = r.player_id
     returning chip_balance into v_after;
    -- A REFUND MUST ALWAYS LAND (2026-08-27). If the player left the club the
    -- update above matches nothing, and the old body still released the escrow
    -- and expired the request — the chips vanished. fn_cashout_release solved
    -- this exact case by recreating the membership row; do the same here.
    if v_after is null then
      insert into public.club_members (club_id, user_id, role, chip_balance, status, is_active)
      values (r.club_id, r.player_id, 'player', v_escrow.amount, 'active', true)
      on conflict (club_id, user_id) do update
        set chip_balance = coalesce(club_members.chip_balance, 0) + excluded.chip_balance,
            updated_at = now()
      returning chip_balance into v_after;
    end if;

    update public.chip_escrow
       set released_at  = now(),
           release_type = 'expired'
     where id = v_escrow.id;

    update public.cashout_requests
       set status     = 'expired',
           updated_at = now(),
           agent_note = coalesce(agent_note, '')
                        || ' [Auto Expired After ' || p_ttl_hours::text || 'h. Escrow Refunded]'
     where id = r.id;

    insert into public.chip_transactions (
      id, club_id, from_user_id, to_user_id, amount,
      transaction_type, notes, related_cashout_id, metadata, balance_after, created_at
    ) values (
      gen_random_uuid(), r.club_id, null, r.player_id, v_escrow.amount,
      'cashout_expired_refund',
      'Cash Out Expired After ' || p_ttl_hours::text || 'h. Escrowed Chips Returned To Player',
      r.id,
      jsonb_build_object('op_id', v_escrow.id, 'expired_after_hours', p_ttl_hours),
      v_after,
      now()
    );

    insert into public.notifications (user_id, type, title, message, metadata)
    values (r.player_id, 'settlement', 'Cash Out Expired',
            'Your Cash Out Request Expired And '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990'))
              || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', r.club_id, 'cashoutId', r.id,
                               'amount', v_escrow.amount));

    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end;
$function$;

-- ── 5. Union send to member: money stays inside the union, and lands live ───
create or replace function public.fn_union_send_to_member(
  p_union_id uuid, p_target_user_id uuid, p_kind text, p_amount numeric,
  p_source_wallet text default null, p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor      uuid := auth.uid();
  v_source     text;
  v_after      numeric;
  v_dia_after  numeric;
  v_club       uuid;
  v_role       text;
  v_is_club    boolean;
  v_agent_row  uuid;
  v_to_after   numeric;
  v_dest       text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    if not public.fn_union_can_manage_wallets(p_union_id, v_actor) then
      return jsonb_build_object('success', false, 'error', 'Only the union owner, co-owner or an admin can send from union wallets.');
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'chips move in hundredths at most');
  end if;
  if p_kind not in ('chips','diamonds','promo') then
    return jsonb_build_object('success', false, 'error', 'kind must be chips, diamonds or promo');
  end if;

  -- WHERE THE CREDIT LANDS (2026-08-27). The old body credited through
  -- atomic_credit_wallet_and_log, which resolves the player's HOME club —
  -- possibly OUTSIDE this union — and the promo branch wrote the frozen
  -- public.wallets pool that nothing reads. The membership the money lands in
  -- is now resolved INSIDE the union: the player's home club when that club
  -- is in the union, else their fattest membership among the union's clubs,
  -- else their direct membership row on the union itself.
  select cm.club_id into v_club
    from club_members cm
   where cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
     and cm.club_id = public.fn_player_home_club(p_target_user_id, null)
     and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
   limit 1;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
     order by coalesce(cm.chip_balance, 0) desc, cm.club_id
     limit 1;
  end if;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id = p_union_id
     limit 1;
  end if;
  if v_club is null then
    return jsonb_build_object('success', false, 'error', 'That player is not a member of this union.');
  end if;
  v_is_club := exists (select 1 from clubs c where c.id = v_club);
  select cm.role into v_role from club_members cm
   where cm.club_id = v_club and cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
   limit 1;

  if p_kind = 'diamonds' then
    if p_amount <> floor(p_amount) then
      return jsonb_build_object('success', false, 'error', 'diamonds must be a whole number');
    end if;
    if p_amount > 100000 then
      return jsonb_build_object('success', false, 'error', 'maximum 100,000 diamonds per send');
    end if;
    update profiles set diamonds = coalesce(diamonds, 0) + p_amount
     where id = p_target_user_id
    returning diamonds into v_dia_after;
    if v_dia_after is null then
      return jsonb_build_object('success', false, 'error', 'player profile not found');
    end if;
    insert into diamond_transactions (user_id, type, amount, balance_after, description, transaction_type, source, metadata)
    values (p_target_user_id, 'credit', p_amount, v_dia_after,
            coalesce(p_note, 'Union grant'), 'union_grant', 'union',
            jsonb_build_object('union_id', p_union_id, 'granted_by', v_actor));
    return jsonb_build_object('success', true, 'kind', 'diamonds', 'balance_after', v_dia_after);
  end if;

  if p_kind = 'promo' then
    update union_wallets
       set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
    if v_after is null then
      return jsonb_build_object('success', false, 'error', 'Insufficient promo wallet balance.');
    end if;

    -- Dan 2026-08-24/25: promo to an agent lands in their promo float; promo
    -- to a player is just as good as cash.
    if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
      v_dest := 'promo_float';
      v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
      if v_agent_row is null then
        raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
      end if;
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_row
       returning promo_wallet_balance into v_to_after;
    else
      v_dest := 'player_wallet';
      update club_members
         set chip_balance = coalesce(chip_balance, 0) + p_amount,
             updated_at = now()
       where club_id = v_club and user_id = p_target_user_id
       returning chip_balance into v_to_after;
    end if;
    if v_to_after is null then
      raise exception 'union promo credit landed nowhere for % in %', p_target_user_id, v_club;
    end if;

    insert into union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    values
      (p_union_id, case when v_is_club then v_club else null end,
       'promo_wallet', 'debit', p_amount, v_after, 'promo_member_send',
       coalesce(p_note, 'Union promo to member'), v_actor);
    if v_is_club then
      insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                     metadata)
      values (v_club, v_actor, p_target_user_id, p_amount, 'union_promo_send',
              coalesce(p_note, 'Union promo to member'), v_to_after,
              jsonb_build_object('union_id', p_union_id, 'destination', v_dest));
    end if;
    return jsonb_build_object('success', true, 'kind', 'promo', 'wallet_after', v_after,
                              'destination', v_dest, 'recipient_balance_after', v_to_after);
  end if;

  -- p_kind = 'chips'
  v_source := coalesce(p_source_wallet, 'chips');
  if v_source not in ('chips','rake','promo') then
    return jsonb_build_object('success', false, 'error', 'source wallet must be chips, rake or promo');
  end if;

  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
  elsif v_source = 'rake' then
    update union_wallets set rake_wallet = rake_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(rake_wallet, 0) >= p_amount
    returning rake_wallet into v_after;
  else
    update union_wallets set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
  end if;

  if v_after is null then
    return jsonb_build_object('success', false, 'error', 'Insufficient balance in the selected union wallet.');
  end if;

  -- Agent to agent always credits the agent wallet (Dan 2026-08-25); a plain
  -- member gets their playing balance, inside the union, atomically.
  if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_dest := 'agent_wallet';
    v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
    if v_agent_row is null then
      raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_agent_row
     returning agent_wallet_balance into v_to_after;
  else
    v_dest := 'player_wallet';
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = v_club and user_id = p_target_user_id
     returning chip_balance into v_to_after;
  end if;
  if v_to_after is null then
    raise exception 'union chip credit landed nowhere for % in %', p_target_user_id, v_club;
  end if;

  insert into union_wallet_transactions
    (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
  values
    (p_union_id, case when v_is_club then v_club else null end,
     case v_source when 'chips' then 'chip_balance' when 'rake' then 'rake_wallet' else 'promo_wallet' end,
     'debit', p_amount, v_after, 'member_send',
     coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_actor);
  if v_is_club then
    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                   metadata)
    values (v_club, v_actor, p_target_user_id, p_amount, 'union_member_send',
            coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_to_after,
            jsonb_build_object('union_id', p_union_id, 'source_wallet', v_source, 'destination', v_dest));
  end if;

  return jsonb_build_object('success', true, 'kind', 'chips', 'source', v_source,
                            'wallet_after', v_after,
                            'destination', v_dest, 'recipient_balance_after', v_to_after);
end $function$;

revoke all on function public.fn_union_send_to_member(uuid, uuid, text, numeric, text, text) from anon;

-- ── 6. Union promo distribution to an agent lands in the float they spend ───
create or replace function public.fn_union_distribute_promo(
  p_union_id uuid, p_target_kind text, p_target_id uuid, p_amount numeric,
  p_agent_club_id uuid default null, p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor uuid; v_before numeric; v_after numeric; v_club uuid;
  v_role text; v_agent_row uuid;
begin
  v_actor := auth.uid();
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'chips move in hundredths at most');
  end if;
  if p_target_kind not in ('club','agent') then
    return jsonb_build_object('success', false, 'error', 'target must be club or agent');
  end if;

  if coalesce(auth.role(),'') <> 'service_role' then
    if v_actor is null or not exists (select 1 from unions where id=p_union_id and owner_id=v_actor) then
      return jsonb_build_object('success', false, 'error', 'only the union owner may distribute promo');
    end if;
  end if;

  select coalesce(promo_wallet,0) into v_before
    from union_wallets where union_id = p_union_id for update;
  if v_before is null then
    return jsonb_build_object('success', false, 'error', 'union wallet not found');
  end if;
  if v_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'insufficient union promo balance',
                              'balance', v_before, 'requested', p_amount);
  end if;

  if p_target_kind = 'club' then
    if not exists (select 1 from clubs where id=p_target_id and union_id=p_union_id) then
      return jsonb_build_object('success', false, 'error', 'club is not in this union');
    end if;
    v_club := p_target_id;
    update clubs set promo_balance = coalesce(promo_balance,0) + p_amount, updated_at = now()
     where id = p_target_id returning promo_balance into v_after;
  else
    if p_agent_club_id is null then
      return jsonb_build_object('success', false, 'error', 'p_agent_club_id required for agent target');
    end if;
    if not exists (select 1 from clubs where id=p_agent_club_id and union_id=p_union_id) then
      return jsonb_build_object('success', false, 'error', 'agent club is not in this union');
    end if;
    select role into v_role from club_members
     where club_id=p_agent_club_id and user_id=p_target_id
       and role in ('agent','super_agent','sub_agent','owner','co_owner','admin')
       and coalesce(status,'active') in ('active','approved')
     limit 1;
    if v_role is null then
      return jsonb_build_object('success', false, 'error', 'target is not an agent in that club');
    end if;
    v_club := p_agent_club_id;
    -- THE FLOAT THE PROMO CASHIER ACTUALLY SPENDS (2026-08-27). This used to
    -- credit club_members.promo_balance, a column nothing on the platform
    -- reads — the distributed promo was unreachable. agents.promo_wallet_balance
    -- is what fn_promo_wallet_send debits, and the sync trigger mirrors the
    -- legacy agents.promo_balance column for the old WH promo routes.
    v_agent_row := public.fn_ensure_agent_row(p_agent_club_id, p_target_id, v_role);
    if v_agent_row is null then
      raise exception 'could not ensure agents row for % in club %', p_target_id, p_agent_club_id;
    end if;
    update agents set promo_wallet_balance = coalesce(promo_wallet_balance,0) + p_amount,
                      updated_at = now()
     where id = v_agent_row returning promo_wallet_balance into v_after;
  end if;

  update union_wallets set promo_wallet = promo_wallet - p_amount where union_id = p_union_id;

  insert into union_wallet_transactions
    (id, union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes, created_by, created_at)
  values (gen_random_uuid(), p_union_id, 'promo_wallet', 'debit', p_amount, v_before - p_amount,
          'promo_union_to_' || p_target_kind, v_club,
          coalesce(p_note, format('Union promo distribution to %s', p_target_kind)), v_actor, now());

  return jsonb_build_object('success', true, 'amount', p_amount, 'target_kind', p_target_kind,
                            'union_balance_after', v_before - p_amount, 'target_balance_after', v_after);
end;
$function$;

-- ── 7. Nightly reconciliation learns the cashier's failure shapes ───────────
create or replace function public.reconcile_ledger_nightly()
returns table(total_checked integer, ok_count integer, warn_count integer, critical_count integer, worst_drift numeric)
language plpgsql
set search_path to 'public'
as $function$
DECLARE
  v_total   INT := 0;
  v_ok      INT := 0;
  v_warn    INT := 0;
  v_crit    INT := 0;
  v_worst   NUMERIC := 0;
BEGIN
  -- x222: clear today's existing rows so re-runs replace, not duplicate.
  DELETE FROM public.ledger_reconcile_log WHERE run_date = CURRENT_DATE;

  -- ── Player wallets ────────────────────────────────────────────────────
  WITH credits AS (
    SELECT to_entity_id AS user_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE to_type = 'player_wallet' AND to_entity_id IS NOT NULL
    GROUP BY to_entity_id
  ),
  debits AS (
    SELECT from_entity_id AS user_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE from_type = 'player_wallet' AND from_entity_id IS NOT NULL
    GROUP BY from_entity_id
  ),
  ledger AS (
    SELECT
      COALESCE(c.user_id, d.user_id) AS user_id,
      COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance
    FROM credits c FULL OUTER JOIN debits d USING (user_id)
  ),
  stored AS (
    SELECT user_id, SUM(COALESCE(balance, 0)) AS balance
    FROM public.wallets
    WHERE wallet_type IN ('player','PLAYER','CASH','cash')
    GROUP BY user_id
  ),
  merged AS (
    SELECT
      COALESCE(l.user_id, s.user_id) AS user_id,
      COALESCE(l.balance, 0)         AS ledger_balance,
      COALESCE(s.balance, 0)         AS stored_balance
    FROM ledger l FULL OUTER JOIN stored s USING (user_id)
    WHERE (COALESCE(l.balance, 0) <> 0 OR COALESCE(s.balance, 0) <> 0)
  )
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT
    'player_wallet',
    user_id,
    ledger_balance,
    stored_balance,
    CASE
      WHEN ABS(stored_balance - ledger_balance) = 0          THEN 'ok'
      WHEN ABS(stored_balance - ledger_balance) <= 1.00      THEN 'warn'
      ELSE                                                         'critical'
    END,
    jsonb_build_object('source', 'reconcile_ledger_nightly', 'wallet_type_filter', 'player/PLAYER/CASH')
  FROM merged
  WHERE user_id IS NOT NULL;

  GET DIAGNOSTICS v_total = ROW_COUNT;

  -- ── Club treasuries ───────────────────────────────────────────────────
  WITH credits AS (
    SELECT to_entity_id AS club_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE to_type = 'club_treasury' AND to_entity_id IS NOT NULL
    GROUP BY to_entity_id
  ),
  debits AS (
    SELECT from_entity_id AS club_id, SUM(amount) AS amt
    FROM public.chip_ledger
    WHERE from_type = 'club_treasury' AND from_entity_id IS NOT NULL
    GROUP BY from_entity_id
  ),
  ledger AS (
    SELECT
      COALESCE(c.club_id, d.club_id) AS club_id,
      COALESCE(c.amt, 0) - COALESCE(d.amt, 0) AS balance
    FROM credits c FULL OUTER JOIN debits d USING (club_id)
  ),
  stored AS (
    SELECT id AS club_id, COALESCE(chip_pool, 0) AS balance FROM public.clubs
  ),
  merged AS (
    SELECT
      COALESCE(l.club_id, s.club_id) AS club_id,
      COALESCE(l.balance, 0)         AS ledger_balance,
      COALESCE(s.balance, 0)         AS stored_balance
    FROM ledger l FULL OUTER JOIN stored s USING (club_id)
    WHERE (COALESCE(l.balance, 0) <> 0 OR COALESCE(s.balance, 0) <> 0)
  )
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT
    'club_treasury',
    club_id,
    ledger_balance,
    stored_balance,
    CASE
      WHEN ABS(stored_balance - ledger_balance) = 0          THEN 'ok'
      WHEN ABS(stored_balance - ledger_balance) <= 1.00      THEN 'warn'
      ELSE                                                         'critical'
    END,
    jsonb_build_object('source', 'reconcile_ledger_nightly')
  FROM merged
  WHERE club_id IS NOT NULL;

  -- ── Chips that left the felt and landed nowhere (added 2026-08-25) ──
  -- The two pools above are chip_ledger vs `wallets` and vs
  -- `clubs.chip_pool`. Club Arena's money is in NEITHER: it is in
  -- club_members.chip_balance and table_seats.stack. Both were wholly
  -- unreconciled, which is how 48 chips were destroyed on 2026-08-25
  -- with nothing noticing. See fn_unaccounted_seat_exits.
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'seat_stack_exit', x.user_id, x.stack, 0, 'critical',
         jsonb_build_object(
           'source', 'fn_unaccounted_seat_exits',
           'exit_id', x.exit_id, 'table_id', x.table_id,
           'club_id', x.club_id, 'exit_kind', x.exit_kind,
           'db_role', x.db_role, 'app_name', x.app_name,
           'occurred_at', x.occurred_at)
  FROM public.fn_unaccounted_seat_exits('1 day'::interval) x;

  -- ── Where the chips actually are (added 2026-08-25) ─────────────────
  -- OBSERVATIONS, not findings: severity 'ok' always. The seat-exit
  -- check above catches a stack that vanishes in one event; this is the
  -- trend line that makes a SLOW leak visible.
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'chip_circulation', c.club_id, c.on_the_felt, c.total, 'ok',
         jsonb_build_object(
           'source', 'fn_club_chip_circulation',
           'club_name', c.club_name,
           'member_wallets', c.member_wallets,
           'on_the_felt', c.on_the_felt,
           'treasury', c.treasury)
  FROM public.fn_club_chip_circulation() c
  WHERE c.total <> 0;

  -- ── Cashier integrity (added 2026-08-27, phase 2 audit) ─────────────
  -- STUCK CASH-OUT ESCROW: an unreleased escrow row whose request is no
  -- longer pending means chips left a player and are parked in a state no
  -- code path will ever release; released escrow on a still-pending request
  -- means the request can pay out twice. Both are critical.
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'cashout_escrow_stuck', e.player_id, e.amount, 0, 'critical',
         jsonb_build_object(
           'source', 'cashier_integrity',
           'escrow_id', e.id, 'cashout_id', e.cashout_request_id,
           'club_id', e.club_id, 'request_status', cr.status,
           'shape', CASE WHEN e.released_at IS NULL THEN 'unreleased_on_closed_request'
                         ELSE 'released_on_pending_request' END)
  FROM public.chip_escrow e
  JOIN public.cashout_requests cr ON cr.id = e.cashout_request_id
  WHERE (e.released_at IS NULL AND cr.status <> 'pending')
     OR (e.released_at IS NOT NULL AND cr.status = 'pending');

  -- NEGATIVE CASHIER BALANCES: every send RPC refuses an overdraft, so a
  -- negative float, wallet or treasury means something bypassed the guards.
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'negative_balance', t.entity_id, t.amount, 0, 'critical',
         jsonb_build_object('source', 'cashier_integrity', 'pool', t.pool, 'club_id', t.club_id)
  FROM (
    SELECT a.user_id AS entity_id, a.agent_wallet_balance AS amount, 'agent_wallet' AS pool, a.club_id
      FROM public.agents a WHERE COALESCE(a.agent_wallet_balance, 0) < 0
    UNION ALL
    SELECT a.user_id, a.promo_wallet_balance, 'promo_wallet', a.club_id
      FROM public.agents a WHERE COALESCE(a.promo_wallet_balance, 0) < 0
    UNION ALL
    SELECT m.user_id, m.chip_balance, 'player_wallet', m.club_id
      FROM public.club_members m WHERE COALESCE(m.chip_balance, 0) < 0
    UNION ALL
    SELECT c.id, c.chip_treasury, 'club_treasury', c.id
      FROM public.clubs c WHERE COALESCE(c.chip_treasury, 0) < 0
  ) t;

  -- OVER-CLAIMED SENDS: claimed_back beyond the send's own amount means the
  -- claw-back invariant broke.
  INSERT INTO public.ledger_reconcile_log
    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)
  SELECT 'over_claimed_send', ct.from_user_id,
         COALESCE((ct.metadata ->> 'claimed_back')::numeric, 0), ct.amount, 'critical',
         jsonb_build_object('source', 'cashier_integrity',
                            'transaction_id', ct.id, 'club_id', ct.club_id)
  FROM public.chip_transactions ct
  WHERE ct.transaction_type = 'agent_wallet_send'
    AND COALESCE((ct.metadata ->> 'claimed_back')::numeric, 0) > ct.amount;

  -- Recompute the summary counts from what we just inserted today
  SELECT
    COUNT(*)::INT                                                 AS total,
    COUNT(*) FILTER (WHERE severity = 'ok')::INT                  AS ok,
    COUNT(*) FILTER (WHERE severity = 'warn')::INT                AS warn,
    COUNT(*) FILTER (WHERE severity = 'critical')::INT            AS crit,
    COALESCE(MAX(ABS(stored_balance - ledger_balance)), 0)        AS worst
  INTO v_total, v_ok, v_warn, v_crit, v_worst
  FROM public.ledger_reconcile_log
  WHERE run_date = CURRENT_DATE;

  total_checked  := v_total;
  ok_count       := v_ok;
  warn_count     := v_warn;
  critical_count := v_crit;
  worst_drift    := v_worst;
  RETURN NEXT;
END;
$function$;

-- ── Post-apply assertions ───────────────────────────────────────────────────
do $assert$
declare v_src text;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_cashout_approve';
  if v_src not like '%fn_ensure_agent_row%' then
    raise exception 'ASSERT FAILED: fn_cashout_approve missing the ensure-row fix';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_expire_stale_cashouts';
  if v_src not like '%on conflict (club_id, user_id) do update%' then
    raise exception 'ASSERT FAILED: fn_expire_stale_cashouts missing the refund-must-land fallback';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_union_send_to_member';
  if v_src like '%add_to_promo_wallet%' or v_src like '%atomic_credit_wallet_and_log%' then
    raise exception 'ASSERT FAILED: fn_union_send_to_member still routes through a dead or out-of-union pool';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_union_distribute_promo';
  if v_src not like '%promo_wallet_balance%' then
    raise exception 'ASSERT FAILED: fn_union_distribute_promo still credits the unread column';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='reconcile_ledger_nightly';
  if v_src not like '%cashout_escrow_stuck%' then
    raise exception 'ASSERT FAILED: reconcile_ledger_nightly missing the cashier integrity section';
  end if;

  -- anon must no longer be able to execute the union member send.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname='public' and p.proname='fn_union_send_to_member'
      and a.grantee = 'anon'::regrole
  ) then
    raise exception 'ASSERT FAILED: anon can still execute fn_union_send_to_member';
  end if;
end $assert$;
