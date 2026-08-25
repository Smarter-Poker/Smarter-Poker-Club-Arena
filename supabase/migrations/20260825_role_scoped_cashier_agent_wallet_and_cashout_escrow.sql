-- ═══════════════════════════════════════════════════════════════════════════
--  ROLE SCOPED CASHIER, THE AGENT WALLET AS AN ACCOUNT, AND CASHOUT ESCROW
--  Dan 2026-08-25, binding.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "For the cashier, it needs to be role specific wallets. Owners, Co Owners,
--  Admins and Super Agents can access the global bank, but they need to click
--  on the global bank to send from the global bank. If they simply just click
--  cashier, this must always default to Agent and player wallets only. Super
--  Agents, Agents, and Sub Agents should ONLY EVER SEE their downlines, and
--  their downline agents' downlines - nobody else. Owners, Co Owners and Admins
--  see everyone. Any chips sent or claimed back transact from the Agent Wallet.
--  Agents can only claim back chips that were sent in the first 10 minutes
--  (reconciling a mistake); after that they cannot remove chips from downline
--  wallets unless the downline requests a cash out. When a player requests a
--  cash out, those chips are removed from the player account and held in escrow
--  until the agent approves or denies. Once approved the chips go into the
--  agent's wallet; if cancelled they return to the player wallet. Owners, Co
--  Owners and Admins can pull from any player at any time. Push notifications
--  and messages must trigger upon a player requesting cash out and when it is
--  approved. All transactions must be in the transaction ledger."
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--
-- 1. THE AGENT WALLET WAS NOT AN ACCOUNT. The cashier's agent send went through
--    ChipFlowService.agentToPlayer -> atomic_chip_transfer, which capped the
--    send against agents.agent_wallet_balance but DEBITED a completely
--    different account (wallets, wallet_type='PLAYER'), wrote no
--    chip_transactions row at all, and carried no idempotency key while being
--    wrapped in a three-attempt retry. The float on screen never moved, the
--    ledger never heard of the send, and a retry sent twice.
--
-- 2. THE CASHIER SHOWED EVERY MEMBER TO EVERYONE. WalletCashierModal.loadMembers
--    paged the whole club_members table with no scoping whatsoever, so a sub
--    agent could pick the club owner as a recipient. There was no server rule to
--    disagree with, either: nothing in the send path asked who the recipient
--    was beneath.
--
-- 3. CASHOUT APPROVAL PUT THE MONEY IN THE WRONG POCKET. fn_approve_cashout_atomic
--    credited the approving agent's club_members.chip_balance - their PLAYER
--    wallet - not their agent float. It also never checked that the escrow row
--    it was releasing existed, while an RLS policy let any player INSERT a
--    cashout_requests row directly: an unescrowed request, approved, minted
--    chips out of nothing.
--
-- 4. NO AGENT COULD SEE A REQUEST. cashout_requests' only SELECT policy was
--    `player_id = auth.uid()`, so AgentCashoutPanel's query returned an empty
--    list to every agent it was written for, and the realtime subscription
--    behind it delivered nothing.
--
-- 5. AN ADMIN PULL VANISHED FROM THE BANK. fn_admin_remove_player_chips credited
--    clubs.chip_pool, which no surface displays, while the Club Bank cashier and
--    DynamicWallet both read clubs.chip_treasury. It also cast the amount to
--    integer against a numeric column.
--
-- ── THE TEN MINUTE CLAWBACK IS A NARROW, DELIBERATE EXCEPTION ───────────────
--
-- 20260815_chip_removal_authority_policy.sql states that an agent may NEVER
-- remove chips from a downline player. That policy stands. This migration adds
-- exactly one hole in it, and no more: an agent may claw back a send THEY
-- THEMSELVES made, only from the specific chip_transactions row that recorded
-- it, only for chips still sitting in the recipient's wallet, and only while
-- now() <= that row's reversible_until, which fn_agent_wallet_send stamps at
-- ten minutes. It is a typo eraser, not an authority to take money. Every other
-- agent-initiated removal still refuses; a player who wants chips out still has
-- to ask, and staff still use fn_admin_remove_player_chips.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. WHO SEES WHOM
-- ───────────────────────────────────────────────────────────────────────────

-- 'all'      - owner, co owner, admin. Sees and transacts with every member.
-- 'downline' - super agent, agent, sub agent. Sees ONLY the recursive downline
--              beneath them: their players, their downline agents, and those
--              agents' downlines.
-- 'none'     - a plain player, or a non member. The cashier has nobody to show.
--
-- super_agent is deliberately 'downline' even though it may also stand at the
-- Club Bank. The two authorities are different: what the bank may FUND is the
-- club's money, but who a super agent may SEE is still only their own tree.
create or replace function public.fn_club_cashier_scope(
  p_club_id uuid,
  p_user_id uuid default null
) returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select case public.fn_club_bank_role(p_club_id, coalesce(p_user_id, auth.uid()))
    when 'owner'       then 'all'
    when 'co_owner'    then 'all'
    when 'admin'       then 'all'
    when 'super_agent' then 'downline'
    when 'agent'       then 'downline'
    when 'sub_agent'   then 'downline'
    else 'none'
  end;
$$;

comment on function public.fn_club_cashier_scope(uuid, uuid) is
  'Cashier visibility scope for a member of a club: all, downline or none.';

-- The one question every money RPC below asks before it moves anything: may
-- this actor transact with this target, in this club? A client-side filter is a
-- courtesy to the reader. THIS is the rule.
create or replace function public.fn_club_cashier_can_transact(
  p_club_id uuid,
  p_actor uuid,
  p_target uuid
) returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_scope text;
begin
  if p_club_id is null or p_actor is null or p_target is null then
    return false;
  end if;
  v_scope := public.fn_club_cashier_scope(p_club_id, p_actor);
  if v_scope = 'all' then
    return true;
  end if;
  if v_scope = 'downline' then
    return public.fn_club_is_in_downline(p_club_id, p_actor, p_target);
  end if;
  return false;
end
$$;

comment on function public.fn_club_cashier_can_transact(uuid, uuid, uuid) is
  'True when the actor may send to, or claim from, the target in this club.';

-- The recipient list the cashier is allowed to offer.
--
-- It walks the SAME edge fn_club_is_in_downline walks - club_members.agent_id
-- inside ONE club - so the list and the refusal can never disagree. A member
-- offered here is a member the server will accept, and that is the whole point:
-- a list that offers someone the RPC then rejects is a dead end nobody can
-- diagnose.
--
-- Cycle safety: club_members.agent_id has held real cycles (see the note in
-- ca_club_my_downline). The visited set is carried in `path` and the depth is
-- capped, so a malformed graph returns a short answer rather than burning the
-- caller's whole statement budget.
create or replace function public.fn_club_cashier_members(p_club_id uuid)
returns table (
  user_id uuid,
  role text,
  role_rank int,
  depth int,
  chip_balance numeric,
  name text,
  username text,
  player_number text,
  avatar_url text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_scope text;
begin
  if v_actor is null or p_club_id is null then
    return;
  end if;

  v_scope := public.fn_club_cashier_scope(p_club_id, v_actor);
  if v_scope = 'none' then
    return;
  end if;

  return query
  with recursive
  edges as (
    select cm.user_id as child, cm.agent_id as parent
      from club_members cm
     where cm.club_id = p_club_id
       and coalesce(cm.status, 'active') in ('active', 'approved')
       and cm.agent_id is not null
       and cm.agent_id <> cm.user_id
  ),
  tree as (
    select e.child, array[e.child] as path, 1 as depth
      from edges e
     where e.parent = v_actor
    union all
    select e.child, t.path || e.child, t.depth + 1
      from tree t
      join edges e on e.parent = t.child
     where not (e.child = any (t.path))
       and t.depth < 20
  ),
  flat as (
    select t.child as uid, min(t.depth)::int as d
      from tree t
     group by t.child
  ),
  scoped as (
    select cm.user_id as uid,
           coalesce(cm.role, 'player') as r,
           coalesce(cm.chip_balance, 0)::numeric as bal,
           coalesce(f.d, 0) as d
      from club_members cm
      left join flat f on f.uid = cm.user_id
     where cm.club_id = p_club_id
       and coalesce(cm.status, 'active') in ('active', 'approved')
       and (v_scope = 'all' or f.uid is not null)
  )
  select s.uid,
         s.r,
         (case s.r
            when 'owner' then 100 when 'co_owner' then 90 when 'admin' then 80
            when 'super_agent' then 60 when 'agent' then 40 when 'sub_agent' then 20
            else 0 end)::int,
         s.d,
         s.bal,
         coalesce(
           nullif(btrim(pr.display_name), ''),
           nullif(btrim(pr.alias), ''),
           nullif(btrim(pr.username), ''),
           'Member'
         )::text,
         coalesce(pr.username, '')::text,
         coalesce(pr.player_number, '')::text,
         coalesce(nullif(btrim(pr.avatar_url), ''), nullif(btrim(pr.arena_avatar_url), ''), '')::text
    from scoped s
    left join profiles pr on pr.id = s.uid
   order by s.d asc,
            (case s.r
               when 'owner' then 100 when 'co_owner' then 90 when 'admin' then 80
               when 'super_agent' then 60 when 'agent' then 40 when 'sub_agent' then 20
               else 0 end) desc,
            lower(coalesce(pr.display_name, pr.username, ''));
end
$$;

comment on function public.fn_club_cashier_members(uuid) is
  'Members the caller may transact with in this club: everyone for staff, the recursive downline for an agent, nobody for a player.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE AGENT WALLET IS THE ACCOUNT
-- ───────────────────────────────────────────────────────────────────────────

-- Idempotency, exactly as the club bank does it. The caller generates an op_id
-- ONCE per attempt and reuses it on every retry of that attempt, so a response
-- lost to a dropped connection cannot become a second send.
create unique index if not exists chip_transactions_agent_wallet_op_id_uidx
  on public.chip_transactions (club_id, ((metadata ->> 'op_id')))
  where transaction_type in (
          'agent_wallet_send',
          'agent_wallet_claim_back',
          'cashout_request_escrow',
          'cashout_approved',
          'cashout_denied',
          'cashout_cancelled'
        )
    and metadata ? 'op_id';

-- Sends still inside their ten minute clawback window.
create index if not exists chip_transactions_agent_wallet_reversible_idx
  on public.chip_transactions (from_user_id, reversible_until)
  where transaction_type = 'agent_wallet_send';

-- SEND FROM THE AGENT WALLET.
--
-- Debits agents.agent_wallet_balance for the CALLER in this club and credits
-- the recipient's player wallet (club_members.chip_balance) or, for a downline
-- agent being funded, their own agent float. One transaction, one ledger row,
-- one op_id, and a reversible_until ten minutes out so the send can be undone
-- if it was a mistake.
create or replace function public.fn_agent_wallet_send(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_destination text default 'player_wallet',
  p_reason text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  -- REPLAY first, before any validation: a retry of an attempt that in fact
  -- committed must report the original rather than being refused for a balance
  -- the original already spent.
  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('player_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Send Chips To Yourself');
  end if;

  -- THE SCOPE RULE. An agent may only ever reach their own downline; staff
  -- reach anyone. Refused here, on the server, whatever the screen offered.
  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false,
      'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0)
    into v_agent_id, v_float_before
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;
  if v_float_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Only Holds '
               || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_float_before, 'requested', p_amount);
  end if;

  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - p_amount,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance into v_float_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    select a.id into v_to_agent_id
      from agents a
     where a.club_id = p_club_id and a.user_id = p_to_user_id
     for update;
    if v_to_agent_id is null then
      insert into agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
      values (p_to_user_id, p_club_id, v_to_role, 'active', 0, 0)
      returning id into v_to_agent_id;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning agent_wallet_balance into v_to_after;
  end if;

  v_until := now() + interval '10 minutes';

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'agent_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'agent_wallet_before', v_float_before,
       'agent_wallet_after', v_float_after,
       'recipient_balance_after', v_to_after,
       'claimed_back', 0,
       'clawback_window_minutes', 10),
     v_float_after, v_until)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'agent_wallet_before', v_float_before,
    'agent_wallet_after', v_float_after,
    'recipient_balance_after', v_to_after,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$$;

comment on function public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid) is
  'Agent wallet send: debits agents.agent_wallet_balance, credits the downline recipient, writes the ledger row, ten minute clawback window.';

-- THE TEN MINUTE CLAWBACK, and nothing wider.
--
-- Anchored on the originating chip_transactions row rather than on a member's
-- balance, because "undo the send I just made" and "take chips from a player"
-- are different powers and only the first one is granted here. Everything the
-- refusal needs is on that row: who sent it, how much, where it went, and
-- reversible_until.
create or replace function public.fn_agent_wallet_claim_back(
  p_club_id uuid,
  p_transaction_id uuid,
  p_amount numeric default null,
  p_reason text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor        uuid := auth.uid();
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_src          record;
  v_claimed      numeric;
  v_remaining    numeric;
  v_take         numeric;
  v_dest         text;
  v_held         numeric;
  v_agent_id     uuid;
  v_float_after  numeric;
  v_holder_after numeric;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_claim_back'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric);
  end if;

  select * into v_src
    from chip_transactions
   where id = p_transaction_id
     and club_id = p_club_id
   for update;
  if v_src is null then
    return jsonb_build_object('success', false, 'error', 'That Send Could Not Be Found');
  end if;
  if v_src.transaction_type <> 'agent_wallet_send' then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent Wallet Send Can Be Claimed Back This Way');
  end if;
  if v_src.from_user_id is distinct from v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Can Only Claim Back Chips You Sent Yourself');
  end if;
  if coalesce(v_src.is_reversed, false) then
    return jsonb_build_object('success', false,
      'error', 'That Send Has Already Been Claimed Back');
  end if;

  -- THE WINDOW. This is the whole exception, and it is refused by the clock.
  if v_src.reversible_until is null or now() > v_src.reversible_until then
    return jsonb_build_object('success', false,
      'error', 'The Ten Minute Window To Claim These Chips Back Has Closed. '
               || 'The Player Must Request A Cash Out Instead');
  end if;

  v_claimed   := coalesce((v_src.metadata ->> 'claimed_back')::numeric, 0);
  v_remaining := v_src.amount - v_claimed;
  if v_remaining <= 0 then
    return jsonb_build_object('success', false,
      'error', 'That Send Has Already Been Claimed Back');
  end if;

  v_take := coalesce(p_amount, v_remaining);
  if v_take <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if v_take > v_remaining then
    return jsonb_build_object('success', false,
      'error', 'Only ' || trim(to_char(v_remaining, 'FM999,999,999,990.00'))
               || ' Chips Of That Send Are Left To Claim Back',
      'remaining', v_remaining, 'requested', v_take);
  end if;

  v_dest := coalesce(v_src.metadata ->> 'destination', 'player_wallet');

  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = p_club_id and user_id = v_src.to_user_id
     for update;
  else
    select a.id, coalesce(a.agent_wallet_balance, 0) into v_agent_id, v_held
      from agents a
     where a.club_id = p_club_id and a.user_id = v_src.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Could Not Be Read, So Nothing Was Moved');
  end if;
  if v_held < v_take then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Have Already Been Spent. That Wallet Only Holds '
               || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held, 'requested', v_take);
  end if;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) - v_take,
           updated_at = now()
     where club_id = p_club_id and user_id = v_src.to_user_id
     returning chip_balance into v_holder_after;
  else
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
  end if;

  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_take,
         updated_at = now()
   where club_id = p_club_id and user_id = v_actor
   returning agent_wallet_balance into v_float_after;
  if v_float_after is null then
    raise exception 'agent wallet row vanished for % in club %', v_actor, p_club_id;
  end if;

  update chip_transactions
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('claimed_back', v_claimed + v_take),
         is_reversed = ((v_claimed + v_take) >= v_src.amount),
         clawed_back = ((v_claimed + v_take) >= v_src.amount)
   where id = v_src.id;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_src.to_user_id, v_actor, v_take, 'agent_wallet_claim_back',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Claim Back Inside The Ten Minute Window'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_dest,
       'original_transaction_id', v_src.id,
       'holder_balance_after', v_holder_after,
       'agent_wallet_after', v_float_after),
     v_float_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', v_take,
    'source', v_dest,
    'holder_balance_after', v_holder_after,
    'agent_wallet_after', v_float_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_claim_back'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric);
end
$$;

comment on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid) is
  'The ten minute mistake eraser: claim back chips YOU sent from your agent wallet, only while the originating row is still reversible.';

-- What the Claim Back tab can actually offer: this agent's own sends that are
-- still inside the window, with the seconds left on each. Rendering a claim
-- button for a send whose window has closed is a button that can only ever be
-- refused, so the list is computed where the rule lives.
create or replace function public.fn_agent_wallet_reversible(p_club_id uuid)
returns table (
  transaction_id uuid,
  to_user_id uuid,
  to_name text,
  amount numeric,
  claimed_back numeric,
  remaining numeric,
  destination text,
  created_at timestamptz,
  reversible_until timestamptz,
  seconds_left int
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select t.id,
         t.to_user_id,
         coalesce(
           nullif(btrim(pr.display_name), ''),
           nullif(btrim(pr.alias), ''),
           nullif(btrim(pr.username), ''),
           'Member'
         )::text,
         t.amount,
         coalesce((t.metadata ->> 'claimed_back')::numeric, 0),
         t.amount - coalesce((t.metadata ->> 'claimed_back')::numeric, 0),
         coalesce(t.metadata ->> 'destination', 'player_wallet'),
         t.created_at,
         t.reversible_until,
         greatest(0, ceil(extract(epoch from (t.reversible_until - now()))))::int
    from chip_transactions t
    left join profiles pr on pr.id = t.to_user_id
   where t.club_id = p_club_id
     and t.transaction_type = 'agent_wallet_send'
     and t.from_user_id = auth.uid()
     and coalesce(t.is_reversed, false) = false
     and t.reversible_until is not null
     and t.reversible_until > now()
     and t.amount - coalesce((t.metadata ->> 'claimed_back')::numeric, 0) > 0
   order by t.created_at desc
   limit 50;
$$;

comment on function public.fn_agent_wallet_reversible(uuid) is
  'The callers own agent wallet sends still inside their ten minute clawback window.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. STAFF MAY PULL FROM ANY PLAYER, AND THE CHIPS MUST GO SOMEWHERE VISIBLE
-- ───────────────────────────────────────────────────────────────────────────

-- Unchanged in authority - owner, co owner, admin, at any time, exactly as
-- before. Two things were wrong with where the money went:
--
--   - it credited clubs.chip_pool, which no screen in the app displays, while
--     the Club Bank cashier and DynamicWallet both read clubs.chip_treasury.
--     A pull therefore left the player's balance and arrived nowhere anyone
--     could see. fn_club_bank_claim_back has always credited chip_treasury;
--     these two are the same operation and must land in the same account.
--   - `p_amount::integer` truncated against a numeric column.
--
-- The ledger row now carries the same metadata shape the rest of the cashier
-- writes, so an admin pull reads the same way as every other movement.
create or replace function public.fn_admin_remove_player_chips(
  p_club_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_before     numeric;
  v_after      numeric;
  v_bank_after numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner Or Admin May Pull Chips From A Member. '
               || 'An Agent Must Wait For A Cash Out Request');
  end if;

  select chip_balance into v_before
    from club_members
   where club_id = p_club_id and user_id = p_player_id
   for update;
  if v_before is null then
    return jsonb_build_object('success', false,
      'error', 'That Person Is Not A Member Of This Club');
  end if;
  if v_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Only Holds ' || trim(to_char(v_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_before, 'requested', p_amount);
  end if;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) - p_amount,
         updated_at = now()
   where club_id = p_club_id and user_id = p_player_id
   returning chip_balance into v_after;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) + p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, p_player_id, v_actor, p_amount, 'admin_removal',
     coalesce(nullif(btrim(p_reason), ''), 'Chips Pulled By Club Staff'),
     jsonb_build_object(
       'source', 'player_wallet',
       'direction', 'into_bank',
       'actor_role', v_actor_role,
       'holder_balance_after', v_after,
       'bank_after', v_bank_after),
     v_bank_after);

  return jsonb_build_object('success', true, 'removed', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'bank_after', v_bank_after);
end
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. CASH OUT: PLAYER TO ESCROW TO AGENT WALLET, OR BACK
-- ───────────────────────────────────────────────────────────────────────────

-- The public write policies on cashout_requests were a hole with a door in it.
--
--   cashout_insert  let any player INSERT a request directly, with no escrow
--                   row and no debit. Approving one of those minted chips.
--   cashout_update  let the player (and any 'agent' anywhere in the club) set
--                   status to whatever they liked, including 'approved'.
--
-- Both are replaced by the SECURITY DEFINER functions below, which are now the
-- ONLY way a cashout row is written. Reads stay open, and widen: the agent who
-- has to act on a request could not see it before.
drop policy if exists "cashout_insert" on public.cashout_requests;
drop policy if exists "cashout_update" on public.cashout_requests;
drop policy if exists "Users can read own cashout requests" on public.cashout_requests;
drop policy if exists "cashout_read_scoped" on public.cashout_requests;

create policy "cashout_read_scoped" on public.cashout_requests
  for select to authenticated
  using (
    player_id = (select auth.uid())
    or agent_id = (select auth.uid())
    or public.fn_club_bank_role(club_id) in ('owner', 'co_owner', 'admin')
    or public.fn_club_is_in_downline(club_id, (select auth.uid()), player_id)
  );

drop policy if exists "escrow_read_scoped" on public.chip_escrow;
create policy "escrow_read_scoped" on public.chip_escrow
  for select to authenticated
  using (
    player_id = (select auth.uid())
    or exists (
      select 1 from public.cashout_requests cr
       where cr.id = chip_escrow.cashout_request_id
         and (cr.agent_id = (select auth.uid())
              or public.fn_club_bank_role(cr.club_id) in ('owner', 'co_owner', 'admin'))
    )
  );

-- A PLAYER ASKS. The chips leave the player's balance in the same transaction
-- that creates the request, so there is never a moment where the same chips are
-- both spendable and promised.
--
-- The agent is resolved from club_members.agent_id - the edge the whole
-- hierarchy is built on - and falls back to the club owner so a player with no
-- agent is not stuck holding chips nobody can release.
create or replace function public.fn_cashout_request(
  p_club_id uuid,
  p_amount numeric,
  p_note text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

  select id, amount, related_cashout_id, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'cashout_request_escrow'
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

  -- The in-app message lands here, inside the same transaction as the money,
  -- because notifications INSERT is service_role only and a browser cannot
  -- write one for somebody else. The realtime channel notifications:<agent>
  -- delivers it the instant this commits.
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
$$;

comment on function public.fn_cashout_request(uuid, numeric, text, uuid) is
  'Player asks to cash out: debits their balance into escrow, opens the request, notifies the agent.';

-- AN AGENT ACCEPTS. The escrowed chips land in the APPROVER'S agent wallet -
-- they are the person who now owes the player the money outside the app, so it
-- is their float that carries it.
--
-- The escrow row is re-read and required. Without that check an unescrowed
-- request (which the dropped INSERT policy used to permit) would have credited
-- an agent out of thin air.
create or replace function public.fn_cashout_approve(
  p_cashout_id uuid,
  p_note text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

  select a.id into v_agent_id
    from agents a
   where a.club_id = v_req.club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    insert into agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
    values (v_actor, v_req.club_id, v_role, 'active', 0, 0)
    returning id into v_agent_id;
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
end
$$;

comment on function public.fn_cashout_approve(uuid, text, uuid) is
  'Agent accepts a cash out: releases escrow into the approvers agent wallet, writes the ledger row, notifies the player.';

-- AN AGENT REFUSES, or a player changes their mind. Same money leg either way -
-- the escrow goes back to the player - so it is one function with one honest
-- difference in who may call it and what the row ends up saying.
create or replace function public.fn_cashout_release(
  p_cashout_id uuid,
  p_note text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

  v_is_player := (v_req.player_id = v_actor);
  if not v_is_player
     and v_req.agent_id <> v_actor
     and not public.fn_club_cashier_can_transact(v_req.club_id, v_actor, v_req.player_id) then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Belongs To A Different Agent');
  end if;

  select * into v_escrow from chip_escrow where cashout_request_id = p_cashout_id for update;
  if v_escrow is null or v_escrow.released_at is not null then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Are Not Held In Escrow, So Nothing Can Be Returned');
  end if;

  v_type   := case when v_is_player then 'cashout_cancelled' else 'cashout_denied' end;
  v_status := case when v_is_player then 'cancelled' else 'rejected' end;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) + v_req.amount,
         updated_at = now()
   where club_id = v_req.club_id and user_id = v_req.player_id
   returning chip_balance into v_after;
  if v_after is null then
    -- The membership was removed while chips of theirs sat in escrow. Putting
    -- the row back is the only way the chips are not simply lost.
    insert into club_members (club_id, user_id, role, chip_balance, status, is_active)
    values (v_req.club_id, v_req.player_id, 'player', v_req.amount, 'active', true)
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

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
     related_cashout_id, metadata, balance_after)
  values
    (v_req.club_id, v_actor, v_req.player_id, v_req.amount, v_type,
     coalesce(nullif(btrim(p_note), ''), 'Cash Out Closed. Chips Returned From Escrow'),
     p_cashout_id,
     jsonb_build_object('op_id', v_op_id, 'closed_by', v_actor,
                        'player_balance_after', v_after),
     v_after);

  if not v_is_player then
    select coalesce(nullif(btrim(pr.display_name), ''),
                    nullif(btrim(pr.alias), ''),
                    nullif(btrim(pr.username), ''), 'Your Agent')
      into v_name
      from profiles pr where pr.id = v_actor;

    insert into notifications (user_id, type, title, message, metadata, actor_id)
    values (v_req.player_id, 'settlement', 'Cash Out Declined',
            coalesce(v_name, 'Your Agent') || ' Declined Your Cash Out. '
              || trim(to_char(v_req.amount, 'FM999,999,999,990')) || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_req.amount),
            v_actor);
  end if;

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', p_cashout_id, 'amount', v_req.amount,
    'club_id', v_req.club_id,
    'player_id', v_req.player_id,
    'cancelled_by_player', v_is_player,
    'player_balance_after', v_after);
end
$$;

comment on function public.fn_cashout_release(uuid, text, uuid) is
  'Deny (agent or staff) or cancel (the player): escrow returns to the player wallet and the ledger says which it was.';

-- The queue an agent actually has to work. cashout_requests could only ever be
-- read by the player before this migration, so the panel built for agents was
-- always empty; this returns exactly the requests the caller may act on, with
-- the player's name attached so the panel is one round trip rather than two.
create or replace function public.fn_cashout_queue(
  p_club_id uuid default null,
  p_status text default 'pending'
) returns table (
  id uuid,
  club_id uuid,
  player_id uuid,
  player_name text,
  player_avatar text,
  agent_id uuid,
  amount numeric,
  status text,
  player_note text,
  agent_note text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select cr.id, cr.club_id, cr.player_id,
         coalesce(
           nullif(btrim(pr.display_name), ''),
           nullif(btrim(pr.alias), ''),
           nullif(btrim(pr.username), ''),
           'Player'
         )::text,
         coalesce(nullif(btrim(pr.arena_avatar_url), ''), nullif(btrim(pr.avatar_url), ''), '')::text,
         cr.agent_id, cr.amount, cr.status, cr.player_note, cr.agent_note, cr.created_at
    from cashout_requests cr
    left join profiles pr on pr.id = cr.player_id
   where auth.uid() is not null
     and (p_club_id is null or cr.club_id = p_club_id)
     and (p_status is null or cr.status = p_status)
     and (
       cr.agent_id = auth.uid()
       or public.fn_club_bank_role(cr.club_id) in ('owner', 'co_owner', 'admin')
       or public.fn_club_is_in_downline(cr.club_id, auth.uid(), cr.player_id)
     )
   order by cr.created_at desc
   limit 200;
$$;

comment on function public.fn_cashout_queue(uuid, text) is
  'Cash out requests the caller may act on: their own downline, or every request in a club they run.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. THE CLUB BANK OBEYS THE SAME SCOPE
-- ───────────────────────────────────────────────────────────────────────────

-- A super agent may stand at the Club Bank, but "ONLY EVER SEE their downlines"
-- is about the PEOPLE, not the account. Without this, a super agent whose
-- recipient list is correctly scoped could still call fn_club_bank_send
-- directly with any member's id, and a scope enforced only in the list is not a
-- permission. Sending to yourself stays allowed: a super agent funding their own
-- float from the bank is the ordinary case, and fn_club_cashier_can_transact
-- answers false for actor = target by design.
--
-- Done as a targeted in-place edit rather than by re-emitting both functions in
-- full. Each is roughly 130 lines this migration does not otherwise touch, and a
-- copy pasted here would be a second definition free to drift from the one that
-- runs. The position() test makes it a no-op on a database that already has it.
do $$
declare d text;
begin
  select pg_get_functiondef(oid) into d
    from pg_proc
   where oid = 'public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)'::regprocedure;

  if position('fn_club_cashier_can_transact' in d) = 0 then
    d := replace(d,
      'select coalesce(c.chip_treasury, 0) into v_bank_before',
      'if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object(''success'', false,
      ''error'', ''That Member Is Not In Your Downline'');
  end if;

  select coalesce(c.chip_treasury, 0) into v_bank_before');
    execute d;
  end if;
end $$;

do $$
declare d text;
begin
  select pg_get_functiondef(oid) into d
    from pg_proc
   where oid = 'public.fn_club_bank_claim_back(uuid,uuid,numeric,text,text,uuid)'::regprocedure;

  if position('fn_club_cashier_can_transact' in d) = 0 then
    d := replace(d,
      'select cm.role into v_holder_role',
      'if p_from_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_from_user_id) then
    return jsonb_build_object(''success'', false,
      ''error'', ''That Member Is Not In Your Downline'');
  end if;

  select cm.role into v_holder_role');
    execute d;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. GRANTS. anon gets nothing; every one of these needs a signed in caller.
-- ───────────────────────────────────────────────────────────────────────────

revoke all on function public.fn_club_cashier_scope(uuid, uuid) from public, anon;
revoke all on function public.fn_club_cashier_can_transact(uuid, uuid, uuid) from public, anon;
revoke all on function public.fn_club_cashier_members(uuid) from public, anon;
revoke all on function public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid) from public, anon;
revoke all on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid) from public, anon;
revoke all on function public.fn_agent_wallet_reversible(uuid) from public, anon;
revoke all on function public.fn_cashout_request(uuid, numeric, text, uuid) from public, anon;
revoke all on function public.fn_cashout_approve(uuid, text, uuid) from public, anon;
revoke all on function public.fn_cashout_release(uuid, text, uuid) from public, anon;
revoke all on function public.fn_cashout_queue(uuid, text) from public, anon;

grant execute on function public.fn_club_cashier_scope(uuid, uuid) to authenticated, service_role;
grant execute on function public.fn_club_cashier_can_transact(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.fn_club_cashier_members(uuid) to authenticated, service_role;
grant execute on function public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid) to authenticated, service_role;
grant execute on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid) to authenticated, service_role;
grant execute on function public.fn_agent_wallet_reversible(uuid) to authenticated, service_role;
grant execute on function public.fn_cashout_request(uuid, numeric, text, uuid) to authenticated, service_role;
grant execute on function public.fn_cashout_approve(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.fn_cashout_release(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.fn_cashout_queue(uuid, text) to authenticated, service_role;
