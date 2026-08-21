-- ═══════════════════════════════════════════════════════════════════════════════
-- fn_cashier_claim_back — browser-safe club-ledger CLAIM BACK for the cashier
-- Trade view (Dan 2026-08-21, PokerBros-parity cashier rebuild).
--
-- WHY: "Claim Back" must pull chips from a downline player back to the
-- CALLER's own club balance (that is what the button means at PokerBros).
-- fn_admin_remove_player_chips is the wrong primitive for it: owner/admin
-- only (agents refused), and it credits clubs.chip_pool — the mint ledger —
-- not the caller, so a claim-back would strand the chips.
--
-- Semantics (exact mirror of fn_cashier_send_chips):
--   * actor is ALWAYS auth.uid();
--   * owner/admin may claim from any active member; super_agent/agent/
--     sub_agent only from players whose club_members.agent_id = actor;
--   * conserved move on club_members.chip_balance (player -> actor);
--   * deterministic lock order; chip_transactions + wallet_transactions
--     logged atomically.
--
-- ROLLBACK: drop function public.fn_cashier_claim_back(uuid, uuid, numeric, text);
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.fn_cashier_claim_back(
  p_club_id uuid,
  p_from_user_id uuid,
  p_amount numeric,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_player_agent uuid;
  v_player_before numeric;
  v_player_after numeric;
  v_actor_after numeric;
  v_first uuid;
  v_second uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'not authenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'amount exceeds limit');
  end if;
  if p_from_user_id is null or p_from_user_id = v_actor then
    return jsonb_build_object('success', false, 'error', 'invalid player');
  end if;

  if v_actor < p_from_user_id then
    v_first := v_actor; v_second := p_from_user_id;
  else
    v_first := p_from_user_id; v_second := v_actor;
  end if;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_second for update;

  select role into v_actor_role
    from club_members
   where club_id = p_club_id and user_id = v_actor and status = 'active';
  if v_actor_role is null then
    return jsonb_build_object('success', false, 'error', 'you are not an active member of this club');
  end if;
  if v_actor_role not in ('owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'your role cannot claim back chips');
  end if;

  select agent_id, coalesce(chip_balance, 0)
    into v_player_agent, v_player_before
    from club_members
   where club_id = p_club_id and user_id = p_from_user_id and status = 'active';
  if v_player_before is null then
    return jsonb_build_object('success', false, 'error', 'player is not an active member of this club');
  end if;
  if v_actor_role in ('super_agent', 'agent', 'sub_agent')
     and v_player_agent is distinct from v_actor then
    return jsonb_build_object('success', false, 'error', 'player is not in your downline');
  end if;

  if v_player_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'insufficient chips',
                              'balance', v_player_before);
  end if;

  update club_members
     set chip_balance = chip_balance - p_amount, updated_at = now()
   where club_id = p_club_id and user_id = p_from_user_id
   returning chip_balance into v_player_after;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) + p_amount, updated_at = now()
   where club_id = p_club_id and user_id = v_actor
   returning chip_balance into v_actor_after;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  values
    (p_club_id, p_from_user_id, v_actor, p_amount, 'peer_transfer',
     coalesce(p_reason, 'Cashier claim back'), v_actor_after);

  insert into wallet_transactions
    (user_id, wallet_type, type, amount, category, description, balance_after)
  values
    (p_from_user_id, 'PLAYER', 'debit', p_amount, 'transfer',
     coalesce(p_reason, 'Cashier claim back'), v_player_after),
    (v_actor, 'PLAYER', 'credit', p_amount, 'transfer',
     coalesce(p_reason, 'Cashier claim back'), v_actor_after);

  return jsonb_build_object(
    'success', true,
    'player_balance', v_player_after,
    'your_balance', v_actor_after
  );
end
$$;

revoke all on function public.fn_cashier_claim_back(uuid, uuid, numeric, text) from public;
revoke all on function public.fn_cashier_claim_back(uuid, uuid, numeric, text) from anon;
grant execute on function public.fn_cashier_claim_back(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.fn_cashier_claim_back(uuid, uuid, numeric, text) to service_role;
