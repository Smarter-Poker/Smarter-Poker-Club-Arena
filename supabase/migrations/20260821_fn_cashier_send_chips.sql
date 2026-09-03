-- ═══════════════════════════════════════════════════════════════════════════════
-- fn_cashier_send_chips — browser-safe club-ledger SEND for the cashier Trade
-- view (Dan 2026-08-21, PokerBros-parity cashier rebuild).
--
-- WHY: the Trade view's "Send Out" must move CLUB chips
-- (club_members.chip_balance — the ledger that buys into games), but no
-- browser-executable RPC could do it:
--   * fn_transfer_chips  — right ledger, but EXECUTE not granted to
--     authenticated AND it takes p_from_user_id as an argument with NO auth
--     check (anyone could drain anyone), and it casts amounts ::integer in a
--     decimal-chip economy. Not fixable by a simple GRANT.
--   * atomic_chip_transfer — authorized, but moves the GLOBAL wallets ledger.
--   * fn_admin_remove_player_chips — the claim-back direction only.
--
-- This function is the missing sender-side primitive:
--   * sender is ALWAYS auth.uid() — never a parameter;
--   * sender must be an active owner/admin/super_agent/agent/sub_agent of the
--     club; agent-tier senders may only send to their own downline
--     (club_members.agent_id = sender);
--   * numeric amounts (decimal chips are real: 0.10/0.20 games);
--   * locks the two member rows in a deterministic order (no deadlocks);
--   * logs chip_transactions + both wallet_transactions rows atomically.
--
-- ROLLBACK: drop function public.fn_cashier_send_chips(uuid, uuid, numeric, text);
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.fn_cashier_send_chips(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender uuid := auth.uid();
  v_sender_role text;
  v_recipient_agent uuid;
  v_recipient_found boolean := false;
  v_from_before numeric;
  v_from_after numeric;
  v_to_after numeric;
  v_first uuid;
  v_second uuid;
begin
  if v_sender is null then
    return jsonb_build_object('success', false, 'error', 'not authenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'amount exceeds limit');
  end if;
  if p_to_user_id is null or p_to_user_id = v_sender then
    return jsonb_build_object('success', false, 'error', 'invalid recipient');
  end if;

  -- Deterministic lock order prevents deadlock between concurrent transfers.
  if v_sender < p_to_user_id then
    v_first := v_sender; v_second := p_to_user_id;
  else
    v_first := p_to_user_id; v_second := v_sender;
  end if;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_second for update;

  select role, coalesce(chip_balance, 0)
    into v_sender_role, v_from_before
    from club_members
   where club_id = p_club_id and user_id = v_sender and status = 'active';
  if v_sender_role is null then
    return jsonb_build_object('success', false, 'error', 'sender is not an active member of this club');
  end if;
  if v_sender_role not in ('owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'your role cannot send chips');
  end if;

  select agent_id into v_recipient_agent
    from club_members
   where club_id = p_club_id and user_id = p_to_user_id and status = 'active';
  if not found then
    return jsonb_build_object('success', false, 'error', 'recipient is not an active member of this club');
  end if;
  v_recipient_found := true;
  if v_sender_role in ('super_agent', 'agent', 'sub_agent')
     and v_recipient_agent is distinct from v_sender then
    return jsonb_build_object('success', false, 'error', 'recipient is not in your downline');
  end if;

  if v_from_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_from_before);
  end if;

  update club_members
     set chip_balance = chip_balance - p_amount, updated_at = now()
   where club_id = p_club_id and user_id = v_sender
   returning chip_balance into v_from_after;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) + p_amount, updated_at = now()
   where club_id = p_club_id and user_id = p_to_user_id
   returning chip_balance into v_to_after;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  values
    (p_club_id, v_sender, p_to_user_id, p_amount, 'peer_transfer',
     coalesce(p_reason, 'Cashier send out'), v_to_after);

  insert into wallet_transactions
    (user_id, wallet_type, type, amount, category, description, balance_after)
  values
    (v_sender, 'PLAYER', 'debit', p_amount, 'transfer',
     coalesce(p_reason, 'Cashier send out'), v_from_after),
    (p_to_user_id, 'PLAYER', 'credit', p_amount, 'transfer',
     coalesce(p_reason, 'Cashier send out'), v_to_after);

  return jsonb_build_object(
    'success', true,
    'from_balance', v_from_after,
    'to_balance', v_to_after
  );
end
$$;

revoke all on function public.fn_cashier_send_chips(uuid, uuid, numeric, text) from public;
revoke all on function public.fn_cashier_send_chips(uuid, uuid, numeric, text) from anon;
grant execute on function public.fn_cashier_send_chips(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.fn_cashier_send_chips(uuid, uuid, numeric, text) to service_role;
