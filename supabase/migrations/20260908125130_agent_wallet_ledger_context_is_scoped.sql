BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_agent_wallet_send_core_20260830' AND md5(pg_get_functiondef(p.oid))='c52b2a02301ac17f2fd4502340cfe143') THEN RAISE EXCEPTION 'Function changed: fn_agent_wallet_send_core_20260830';END IF;END $guard$;
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_is_prepaid   boolean;
  v_credit_limit numeric;
  v_credit_used  numeric;
  v_credit_after numeric;
  v_shortfall    numeric := 0;
  v_headroom     numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
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
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
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

  if v_to_role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    v_dest := 'agent_wallet';
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0),
         coalesce(a.is_prepaid, true),
         coalesce(a.credit_limit, 0), coalesce(a.credit_used, 0)
    into v_agent_id, v_float_before, v_is_prepaid, v_credit_limit, v_credit_used
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;

  -- THE CREDIT LINE. Dan, 2026-08-31: "IF THEY GO BELOW THE CREDIT LIMIT, THEY
  -- MUST 'SQUARE UP' OR PRE PAY FOR CHIPS FOR THE REST OF THE WEEK." So the
  -- limit caps the debt outstanding, not the amount ever borrowed: an agent
  -- draws credit_limit - credit_used, and paying an invoice frees it again
  -- (fn_apply_credit_payment pays credit_used down, phase 1).
  if v_float_before < p_amount then
    v_shortfall := round(p_amount - v_float_before, 2);

    -- A prepaid agent, and an agent with no line at all, get the plain answer
    -- about their wallet. Talking about a credit line to somebody who has none
    -- is the sort of message that sends a person looking for a setting.
    if v_is_prepaid or v_credit_limit <= 0 then
      return jsonb_build_object('success', false,
        'error', 'Your Agent Wallet Only Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
        'balance', v_float_before, 'requested', p_amount,
        'prepaid', v_is_prepaid);
    end if;

    v_headroom := v_credit_limit - v_credit_used;
    if v_shortfall > v_headroom then
      return jsonb_build_object('success', false,
        'error', 'Your Wallet Holds '
                 || trim(to_char(v_float_before, 'FM999,999,999,990.00'))
                 || ' Chips And Your Credit Line Has '
                 || trim(to_char(greatest(v_headroom, 0), 'FM999,999,999,990.00'))
                 || ' Left. Square Up Your Invoice Or Add Chips To Send This Much.',
        'balance', v_float_before, 'requested', p_amount,
        'credit_limit', v_credit_limit, 'credit_used', v_credit_used,
        'credit_available', greatest(v_headroom, 0),
        'shortfall', v_shortfall);
    end if;
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): an agent wallet send is ONE `agent_send`
  -- row from the sender's float to the wallet that receives it, keyed and
  -- correlated on the op. Verified on 2026-09-01 14:23:18 (10,000.00 to a
  -- player) the undeclared journal was `adjustment agent_wallet ->
  -- settlement_suspense` plus `adjustment table_stack -> player_wallet`. The
  -- agents trigger is skipped for both float writes: a player recipient's
  -- club_members trigger writes the row with the sender's float as its
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. When the credit line covers a shortfall the
  -- float only pays p_amount - v_shortfall, so the draw is its own
  -- `credit_draw credit_facility -> agent_wallet` row for the difference and
  -- the send row still carries the whole amount. Never a refusal.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);
  if v_shortfall > 0 then
    perform public.fn_ca_post_leg('credit_draw', 'credit_facility', v_actor, 'agent_wallet', v_actor,
      v_shortfall, p_club_id, 'agent_send:credit:' || v_op_id::text,
      'Agent credit line covers the shortfall of an agent wallet send (fn_agent_wallet_send_core_20260830)');
  end if;

  -- The wallet pays what it can and the line covers the rest, so the balance
  -- lands on exactly zero rather than going negative.
  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - (p_amount - v_shortfall),
         credit_used          = coalesce(credit_used, 0) + v_shortfall,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning agent_wallet_balance into v_to_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, 'agent_wallet', p_to_user_id,
      p_amount, p_club_id, 'agent_send:' || v_op_id::text,
      'Agent wallet send to a downline agent wallet (fn_agent_wallet_send_core_20260830)');
  end if;

  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

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
       -- What was borrowed to make this send, and how much of that borrowing
       -- has since been handed back. The claim back reads both.
       'credit_drawn', v_shortfall,
       'credit_repaid', 0,
       'credit_used_after', v_credit_after,
       'credit_limit', v_credit_limit,
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
    'credit_drawn', v_shortfall,
    'credit_used_after', v_credit_after,
    'credit_limit', v_credit_limit,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
end
$function$;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) TO service_role;
DO $guard$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_agent_wallet_claim_back_phase2_core_20260831' AND md5(pg_get_functiondef(p.oid))='1173d6ef41b84e0064dec3763421bd9e') THEN RAISE EXCEPTION 'Function changed: fn_agent_wallet_claim_back_phase2_core_20260831';END IF;END $guard$;
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor            uuid := auth.uid();
  v_op_id            uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior            record;
  v_src              record;
  v_claimed          numeric;
  v_claimed_after    numeric;
  v_remaining_exact  numeric;
  v_remaining        numeric;
  v_take             numeric;
  v_complete         boolean;
  v_dest             text;
  v_held             numeric;
  v_agent_id         uuid;
  v_float_after      numeric;
  v_holder_after     numeric;
  v_tx_id            uuid;
  v_drawn            numeric;
  v_repaid           numeric;
  v_repay            numeric := 0;
  v_my_agent_id      uuid;
  v_my_used          numeric;
  v_credit_after     numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_club_id is null or p_transaction_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recent Agent Wallet Send');
  end if;
  if p_amount is not null and
     (p_amount <= 0 or p_amount > 1e9 or p_amount <> round(p_amount, 2)) then
    return jsonb_build_object(
      'success', false,
      'error', 'Claim Back Amounts Must Be Positive Whole Cents');
  end if;

  -- One caller/op pair is serialized, so two simultaneous retries cannot both
  -- pass the replay read and enter the money section.
  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-claim:' || p_club_id::text || ':' || v_actor::text || ':' || v_op_id::text,
    0
  ));

  select id, amount, metadata into v_prior
    from public.chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_claim_back'
     and to_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
  end if;

  select * into v_src
    from public.chip_transactions
   where id = p_transaction_id
     and club_id = p_club_id
   for update;
  if v_src is null then
    return jsonb_build_object('success', false, 'error', 'That Send Could Not Be Found');
  end if;
  if v_src.transaction_type <> 'agent_wallet_send' then
    return jsonb_build_object(
      'success', false,
      'error', 'Only An Agent Wallet Send Can Be Claimed Back This Way');
  end if;
  if v_src.from_user_id is distinct from v_actor then
    return jsonb_build_object(
      'success', false,
      'error', 'You Can Only Claim Back Chips You Sent Yourself');
  end if;
  if coalesce(v_src.is_reversed, false) then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;
  if v_src.reversible_until is null or now() > v_src.reversible_until then
    return jsonb_build_object(
      'success', false,
      'error', 'The Ten Minute Window To Claim These Chips Back Has Closed. '
               || 'The Player Must Request A Cash Out Instead');
  end if;

  v_claimed := coalesce((v_src.metadata ->> 'claimed_back')::numeric, 0);
  v_remaining_exact := greatest(v_src.amount - v_claimed, 0);

  -- Round DOWN, never to nearest. A historical 9.9951 remainder can safely
  -- return 9.99; rounding it to 10.00 would create another 0.0049 chips.
  v_remaining := trunc(v_remaining_exact, 2);
  if v_remaining < 0.01 then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;

  -- Null means all safely claimable whole cents. This is what the cashier uses
  -- so contaminated historical rows can be closed without echoing sub-cents.
  v_take := coalesce(p_amount, v_remaining);
  if v_take > v_remaining then
    return jsonb_build_object(
      'success', false,
      'error', 'Only ' || trim(to_char(v_remaining, 'FM999,999,999,990.00'))
               || ' Chips Of That Send Are Left To Claim Back',
      'remaining', v_remaining,
      'requested', v_take);
  end if;

  v_claimed_after := v_claimed + v_take;
  v_complete := (v_src.amount - v_claimed_after) < 0.01;

  v_dest := coalesce(v_src.metadata ->> 'destination', 'player_wallet');
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from public.club_members
     where club_id = p_club_id and user_id = v_src.to_user_id
     for update;
  else
    select a.id, coalesce(a.agent_wallet_balance, 0) into v_agent_id, v_held
      from public.agents a
     where a.club_id = p_club_id and a.user_id = v_src.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object(
      'success', false,
      'error', 'That Wallet Could Not Be Read, So Nothing Was Moved');
  end if;
  if v_held < v_take then
    return jsonb_build_object(
      'success', false,
      'error', 'Those Chips Have Already Been Spent. That Wallet Only Holds '
               || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held,
      'requested', v_take);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): a claim back is ONE `agent_claim` row from
  -- the wallet that held the send back to the agent's float, keyed and
  -- correlated on the op. The agents trigger is skipped for both float
  -- writes: a player holder's club_members trigger writes the row with the
  -- agent's float as counterparty; an agent holder (both sides in `agents`)
  -- gets the row posted explicitly below. The share that repays the credit
  -- line never reaches the float, so it is its own `credit_repayment
  -- agent_wallet -> credit_facility` row. Never a refusal.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_claim', 'agent_wallet', v_actor, null,
    'agent_claim:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  if v_dest = 'player_wallet' then
    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) - v_take,
           updated_at = now()
     where club_id = p_club_id and user_id = v_src.to_user_id
     returning chip_balance into v_holder_after;
  else
    update public.agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_claim', 'agent_wallet', v_src.to_user_id, 'agent_wallet', v_actor,
      v_take, p_club_id, 'agent_claim:' || v_op_id::text,
      'Agent wallet claim back from a downline agent wallet (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- HOW MUCH OF THIS CLAIM IS A REPAYMENT.
  --
  -- credit_drawn is what this send borrowed; credit_repaid is how much of that
  -- borrowing earlier partial claims have already handed back. The share of a
  -- partial claim is proportional, truncated down so repeated partials can
  -- never repay more than was drawn. The final claim settles the exact
  -- remainder, so truncation cannot strand a cent of debt on a send that has
  -- been returned in full.
  v_drawn  := coalesce((v_src.metadata ->> 'credit_drawn')::numeric, 0);
  v_repaid := coalesce((v_src.metadata ->> 'credit_repaid')::numeric, 0);

  select a.id, coalesce(a.credit_used, 0) into v_my_agent_id, v_my_used
    from public.agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_my_agent_id is null then
    raise exception 'agent wallet row vanished for % in club %', v_actor, p_club_id;
  end if;

  if v_drawn > 0 then
    if v_complete then
      v_repay := greatest(v_drawn - v_repaid, 0);
    else
      v_repay := least(trunc(v_drawn * v_take / v_src.amount, 2),
                       greatest(v_drawn - v_repaid, 0));
    end if;
    -- The debt may already have been settled another way: an invoice paid
    -- inside the ten minute window pays credit_used down (phase 1), and paying
    -- twice for the same borrowing would hand the agent free chips.
    v_repay := greatest(least(v_repay, v_my_used), 0);
  end if;

  if v_repay > 0 then
    perform public.fn_ca_post_leg('credit_repayment', 'agent_wallet', v_actor, 'credit_facility', v_actor,
      v_repay, p_club_id, 'agent_claim:credit:' || v_op_id::text,
      'Claimed back chips repay the credit line drawn for the send (fn_agent_wallet_claim_back_phase2_core_20260831)');
  end if;

  -- Every chip returns: what is not repaying a debt becomes float.
  update public.agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + (v_take - v_repay),
         credit_used          = greatest(coalesce(credit_used, 0) - v_repay, 0),
         updated_at = now()
   where id = v_my_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;
  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

  update public.chip_transactions
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('claimed_back', v_claimed_after,
                                          'credit_repaid', v_repaid + v_repay),
         is_reversed = v_complete,
         clawed_back = v_complete
   where id = v_src.id;

  insert into public.chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_src.to_user_id, v_actor, v_take, 'agent_wallet_claim_back',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Claim Back Inside The Ten Minute Window'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_dest,
       'original_transaction_id', v_src.id,
       'holder_balance_after', v_holder_after,
       'agent_wallet_after', v_float_after,
       'credit_repaid', v_repay,
       'credit_used_after', v_credit_after),
     v_float_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', v_take,
    'source', v_dest,
    'holder_balance_after', v_holder_after,
    'agent_wallet_after', v_float_after,
    'credit_repaid', v_repay,
    'credit_used_after', v_credit_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from public.chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_claim_back'
       and to_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'credit_repaid', coalesce((v_prior.metadata ->> 'credit_repaid')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric);
end
$function$;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_claim_back_phase2_core_20260831(uuid,uuid,numeric,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
